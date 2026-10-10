// #13 AI: HTTP-facing service for AI-assisted candidate extraction (ADR-0007, BUILD-BASELINE §4.2).
// The port does disclosure, caps and the provider call; this service turns returned candidates into
// candidate records (statementMode ai_extracted, stated by the AI actor for provider and model) and never
// confirms anything. Nothing in a provider answer can reach review state, approvals or other records.
import { Inject, Injectable } from '@nestjs/common';
import type {
  AiExecuteRequest, AiExecuteResponse, AiPreviewRequest, AiPreviewResponse, AiStatusResponse, AiUsageResponse, RecordSummary,
} from '@poii/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { AI_EXECUTION_PORT, DB } from '../../common/tokens.js';
import { iso, newId } from '../../common/util.js';
import { requireCapability, type AuthorizableActor } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { actor, record, recordEvidence, source, sourceRevision } from '../../db/schema/index.js';
import type { ActorRow, Exec, RecordRow } from '../../db/types.js';
import { computeLocator } from '../../domain/locator.js';
import type { AiExecution, AiExecutionPort, AiProviderName } from '../../ports/ai-execution.js';
import { appendVersion, toSummaries } from '../records/records.repository.js';

type PreviewInput = z.output<typeof AiPreviewRequest>;
type ExecuteInput = z.output<typeof AiExecuteRequest>;

const PROVIDER_LABEL: Record<AiProviderName, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/**
 * TODO(integrator, #13): executing spends provider budget, which is a new capability ("ai_execute") that
 * authorization.ts does not have yet. Until it does, only a person with authority may execute; agent
 * tokens may preview (propose) but never spend.
 */
export function requireAiExecute(who: AuthorizableActor): void {
  requireCapability(who, 'propose');
  if (who.kind !== 'person' || !who.authority) {
    throw new AppError(403, 'authority_required', 'Sending to an AI provider spends budget and needs a person with authority (capability: ai_execute)');
  }
}

@Injectable()
export class AiService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AI_EXECUTION_PORT) private readonly ai: AiExecutionPort,
  ) {}

  status(ctx: RequestContext): AiStatusResponse {
    requireCapability(ctx.actor, 'read');
    return this.ai.status();
  }

  async usage(ctx: RequestContext): Promise<AiUsageResponse> {
    requireCapability(ctx.actor, 'read');
    return this.ai.usage();
  }

  async preview(ctx: RequestContext, input: PreviewInput): Promise<AiPreviewResponse> {
    requireCapability(ctx.actor, 'propose');
    const preview = await this.ai.preview(ctx, input);
    return { ...preview, expiresAt: iso(preview.expiresAt) };
  }

  async execute(ctx: RequestContext, input: ExecuteInput): Promise<AiExecuteResponse> {
    requireAiExecute(ctx.actor);
    const result = await this.ai.execute(ctx, input.previewId);
    const { records, errors } = await this.createCandidates(ctx, result);
    return {
      previewId: result.previewId,
      provider: result.provider,
      model: result.model,
      outcome: result.outcome,
      errors: [...result.errors, ...errors],
      records,
      usage: result.usage,
    };
  }

  private async createCandidates(ctx: RequestContext, result: AiExecution): Promise<{ records: RecordSummary[]; errors: string[] }> {
    if (!result.candidates.length) return { records: [], errors: [] };
    const rows = await this.db.orm.transaction(async tx => {
      const src = (await tx.select().from(source).where(and(eq(source.id, result.sourceId), eq(source.workspaceId, ctx.workspace.id))))[0];
      const revision = (await tx.select({ id: sourceRevision.id, text: sourceRevision.contentText }).from(sourceRevision)
        .where(and(eq(sourceRevision.id, result.revisionId), eq(sourceRevision.sourceId, result.sourceId))))[0];
      if (!src || !revision) return null;
      const assistant = await this.assistantActor(tx, ctx, result.provider, result.model);
      const created: RecordRow[] = [];
      for (const candidate of result.candidates) {
        const recordId = newId();
        const locator = computeLocator(revision.text, revision.id, candidate.startChar, candidate.endChar);
        const row = (await tx.insert(record).values({
          id: recordId, workspaceId: ctx.workspace.id, kind: candidate.kind, title: candidate.title, body: candidate.body,
          reviewState: 'candidate', lifecycleStatus: 'unknown', statedByActorId: assistant.id, statedRole: 'assistant',
          statementMode: 'ai_extracted', aiAllowed: src.aiAllowed, versionNo: 1, createdByActorId: ctx.actor.id,
        }).returning())[0]!;
        await tx.insert(recordEvidence).values({
          id: newId(), recordId, sourceId: src.id, originalSourceId: src.id, revisionId: revision.id, locator, role: 'primary', anchorResult: 'exact',
        });
        await appendVersion(tx, row, 'create', ctx.actor.id, `AI extraction, preview ${result.previewId} (${result.provider} ${result.model})`);
        await audit(tx, ctx, 'record.created', 'record', recordId, {
          kind: candidate.kind, evidenceCount: 1, statementMode: 'ai_extracted', previewId: result.previewId, provider: result.provider, model: result.model,
        });
        created.push(row);
      }
      return created;
    });
    if (!rows) return { records: [], errors: ['The source or its revision was deleted while the provider answered; no candidates were stored.'] };
    return { records: await toSummaries(this.db.orm, rows), errors: [] };
  }

  /** The ai_assistant actor for this provider and model, created on first use. Never holds authority. */
  private async assistantActor(tx: Exec, ctx: RequestContext, provider: AiProviderName, model: string): Promise<ActorRow> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`poii.ai.actor:${ctx.workspace.id}`}))`);
    const existing = (await tx.select().from(actor).where(and(
      eq(actor.workspaceId, ctx.workspace.id), eq(actor.kind, 'ai_assistant'),
      sql`${actor.details}->>'aiProvider' = ${provider}`, sql`${actor.details}->>'aiModel' = ${model}`,
    )).orderBy(actor.createdAt).limit(1))[0];
    if (existing) return existing;
    const created = (await tx.insert(actor).values({
      id: newId(), workspaceId: ctx.workspace.id, kind: 'ai_assistant', displayName: `${PROVIDER_LABEL[provider]} ${model}`, authority: null,
      details: { aiProvider: provider, aiModel: model, createdBy: 'ai-execution' },
    }).returning())[0]!;
    await audit(tx, ctx, 'actor.created', 'actor', created.id, { kind: 'ai_assistant', aiProvider: provider, aiModel: model });
    return created;
  }
}
