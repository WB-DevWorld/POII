// #13 AI: the gated provider execution behind the AI-execution port (ADR-0007).
//   preview: disclosure → prompt → estimate → stored preview (no prompt text stored) → audit (hash and ids).
//   execute: preview checks → disclosure again → rebuild the prompt and prove it equals the preview (sha256)
//            → reserve under the cap (refuse: nothing sent) → construct the provider client → send exactly
//            the previewed text → reconcile from reported usage → audit.
// Provider clients are created only inside execute, after disclosure and the cap have passed.
import { and, eq, isNull } from 'drizzle-orm';
import { AppError, conflict, notFound } from '../common/errors.js';
import { audit } from '../common/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { newId, sha256Hex } from '../common/util.js';
import type { Settings } from '../config.js';
import type { Db } from '../db/client.js';
import { aiPreview } from '../db/schema/index.js';
import type {
  AiExecution, AiExecutionPort, AiPreview, AiPreviewRequest, AiProviderClient, AiProviderName, AiProviderStatus, AiStatusInfo,
  AiUsageInfo, ProviderCallResult,
} from '../ports/ai-execution.js';
import { aiProviderNames } from '../ports/ai-execution.js';
import { anchorCandidates } from './candidates.js';
import { currentMonth, lockProvider, monthTotals, reserve, settle, usageRow } from './caps.js';
import { discloseForAi, type DisclosedMaterial } from './disclosure.js';
import { costMicroUsd, estimateInputTokens, microToUsd, type ModelPrice } from './pricing.js';
import { buildPrompt } from './prompt.js';

/** A configured provider: what preview needs (model, price, cap) and a factory used only by execute. */
export interface ProviderRegistration {
  provider: AiProviderName;
  model: string;
  price: ModelPrice;
  capMicro: number;
  create: () => AiProviderClient;
}

export class GatedAiExecution implements AiExecutionPort {
  readonly name = 'providers';
  readonly enabled = true;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly registrations: Map<AiProviderName, ProviderRegistration>,
    private readonly providerStatus: AiProviderStatus[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): AiStatusInfo {
    return {
      enabled: true,
      defaultProvider: this.defaultProvider(),
      providers: this.providerStatus,
      previewTtlSeconds: this.settings.ai.previewTtlSeconds,
      maxInputChars: this.settings.ai.maxInputChars,
      maxOutputTokens: this.settings.ai.maxOutputTokens,
      logRequestText: this.settings.ai.logRequestText,
    };
  }

  async usage(): Promise<AiUsageInfo> {
    const month = currentMonth(this.now());
    const providers = [];
    for (const provider of aiProviderNames) {
      const totals = await monthTotals(this.db.orm, provider, month);
      providers.push(usageRow(provider, this.capMicro(provider), totals));
    }
    return { month, providers };
  }

  private capMicro(provider: AiProviderName): number {
    return Math.round(this.settings.ai[provider].monthlyCapUsd * 1_000_000);
  }

  private defaultProvider(): AiProviderName | null {
    const wanted = this.settings.ai.defaultProvider;
    if (wanted && this.registrations.has(wanted)) return wanted;
    return [...this.registrations.keys()][0] ?? null;
  }

  private registration(provider: AiProviderName | undefined): ProviderRegistration {
    const name = provider ?? this.defaultProvider();
    const reg = name ? this.registrations.get(name) : undefined;
    if (!reg) {
      throw conflict('provider_unavailable', `AI provider ${name ?? '(none)'} is not configured`, {
        configured: [...this.registrations.keys()],
      });
    }
    return reg;
  }

  async preview(ctx: RequestContext, request: AiPreviewRequest): Promise<AiPreview> {
    let material: DisclosedMaterial;
    try {
      // Disclosure first: nothing else happens for a never-send source or record.
      material = await discloseForAi(this.db.orm, { ...request, workspaceId: ctx.workspace.id }, this.settings.ai.maxInputChars);
    } catch (error) {
      if (error instanceof AppError && error.code === 'ai_not_allowed') {
        await audit(this.db.orm, ctx, 'ai.preview_refused', 'source', request.sourceId, {
          reason: 'ai_not_allowed', ...(error.details as Record<string, unknown>), requestedRecordIds: request.recordIds ?? [],
        });
      }
      throw error;
    }
    const reg = this.registration(request.provider);
    const promptText = buildPrompt(material.documentText, material.records);
    const promptSha256 = sha256Hex(promptText);
    const inputTokensEstimate = estimateInputTokens(promptText);
    const maxOutputTokens = this.settings.ai.maxOutputTokens;
    const estimateMicro = costMicroUsd(reg.price, inputTokensEstimate, maxOutputTokens);
    const previewId = newId();
    const expiresAt = new Date(this.now().getTime() + this.settings.ai.previewTtlSeconds * 1000);
    await this.db.orm.transaction(async tx => {
      await tx.insert(aiPreview).values({
        id: previewId, workspaceId: ctx.workspace.id, createdByActorId: ctx.actor.id, provider: reg.provider, model: reg.model,
        sourceId: material.source.id, revisionId: material.revisionId, startChar: material.startChar, endChar: material.endChar,
        recordIds: material.recordIds, promptSha256, promptChars: promptText.length, inputTokensEstimate, maxOutputTokens,
        estimatedCostMicroUsd: estimateMicro, expiresAt,
      });
      await audit(tx, ctx, 'ai.previewed', 'source', material.source.id, {
        previewId, provider: reg.provider, model: reg.model, revisionId: material.revisionId, startChar: material.startChar,
        endChar: material.endChar, recordIds: material.recordIds, promptSha256, promptChars: promptText.length,
        inputTokensEstimate, maxOutputTokens, estimatedCostUsd: microToUsd(estimateMicro),
        // Only ever AI-allowed material reaches this point; text is logged only when the owner opted in.
        ...(this.settings.ai.logRequestText ? { promptText } : {}),
      });
    });
    const totals = await monthTotals(this.db.orm, reg.provider, currentMonth(this.now()));
    const cap = usageRow(reg.provider, reg.capMicro, totals);
    return {
      previewId, provider: reg.provider, model: reg.model, promptText, promptSha256, sourceId: material.source.id,
      revisionId: material.revisionId, startChar: material.startChar, endChar: material.endChar, recordIds: material.recordIds,
      inputTokensEstimate, maxOutputTokens, estimatedCostUsd: microToUsd(estimateMicro), remainingCapUsd: cap.remainingUsd,
      monthlyCapUsd: cap.capUsd, expiresAt,
    };
  }

  /**
   * Loads a preview for viewing or executing: it must exist, be unused and unexpired, match the current
   * provider configuration, pass disclosure again (the source or a record may have been marked never-send
   * since), and rebuild to exactly the previewed bytes (sha256).
   */
  private async loadPreview(ctx: RequestContext, previewId: string, purpose: 'view' | 'execute') {
    const preview = (await this.db.orm.select().from(aiPreview)
      .where(and(eq(aiPreview.id, previewId), eq(aiPreview.workspaceId, ctx.workspace.id))))[0];
    if (!preview) throw notFound('Preview');
    if (preview.executedAt) throw conflict('preview_used', 'This preview was already executed; create a new preview');
    if (preview.expiresAt.getTime() <= this.now().getTime()) throw conflict('preview_expired', 'This preview has expired; create a new preview');
    const provider = preview.provider as AiProviderName;
    const reg = this.registrations.get(provider);
    if (!reg || reg.model !== preview.model) {
      throw conflict('preview_stale', 'The provider or model configuration changed since the preview; create a new preview');
    }
    let material: DisclosedMaterial;
    try {
      material = await discloseForAi(this.db.orm, {
        workspaceId: ctx.workspace.id, sourceId: preview.sourceId, revisionId: preview.revisionId, startChar: preview.startChar,
        endChar: preview.endChar, recordIds: preview.recordIds,
      }, this.settings.ai.maxInputChars);
    } catch (error) {
      if (error instanceof AppError && error.code === 'ai_not_allowed') {
        await audit(this.db.orm, ctx, purpose === 'execute' ? 'ai.execute_refused' : 'ai.preview_refused', 'source', preview.sourceId, {
          previewId, reason: 'ai_not_allowed', ...(error.details as Record<string, unknown>),
        });
      }
      throw error;
    }
    const promptText = buildPrompt(material.documentText, material.records);
    if (sha256Hex(promptText) !== preview.promptSha256) {
      throw conflict('preview_stale', 'The previewed material changed since the preview (a context record was edited); create a new preview');
    }
    return { preview, provider, reg, material, promptText };
  }

  /** The stored preview again, with its exact text rebuilt and verified. Sends nothing. */
  async getPreview(ctx: RequestContext, previewId: string): Promise<AiPreview> {
    const { preview, provider, reg, promptText } = await this.loadPreview(ctx, previewId, 'view');
    const cap = usageRow(provider, reg.capMicro, await monthTotals(this.db.orm, provider, currentMonth(this.now())));
    return {
      previewId, provider, model: preview.model, promptText, promptSha256: preview.promptSha256, sourceId: preview.sourceId,
      revisionId: preview.revisionId, startChar: preview.startChar, endChar: preview.endChar, recordIds: preview.recordIds,
      inputTokensEstimate: preview.inputTokensEstimate, maxOutputTokens: preview.maxOutputTokens,
      estimatedCostUsd: microToUsd(preview.estimatedCostMicroUsd), remainingCapUsd: cap.remainingUsd, monthlyCapUsd: cap.capUsd,
      expiresAt: preview.expiresAt,
    };
  }

  async execute(ctx: RequestContext, previewId: string): Promise<AiExecution> {
    const { preview, provider, reg, material, promptText } = await this.loadPreview(ctx, previewId, 'execute');

    const usageId = newId();
    const month = currentMonth(this.now());
    await this.db.orm.transaction(async tx => {
      await lockProvider(tx, provider);
      const claimed = await tx.update(aiPreview).set({ executedAt: this.now() })
        .where(and(eq(aiPreview.id, previewId), isNull(aiPreview.executedAt))).returning({ id: aiPreview.id });
      if (!claimed.length) throw conflict('preview_used', 'This preview was already executed; create a new preview');
      await reserve(tx, {
        id: usageId, workspaceId: ctx.workspace.id, actorId: ctx.actor.id, provider, model: reg.model, month, previewId,
        promptSha256: preview.promptSha256, estimateMicro: preview.estimatedCostMicroUsd, capMicro: reg.capMicro,
      });
    }).catch(async error => {
      if (error instanceof AppError && error.code === 'cap_reached') {
        await audit(this.db.orm, ctx, 'ai.cap_reached', 'source', preview.sourceId, { previewId, provider, month, ...(error.details as Record<string, unknown>) });
      }
      throw error;
    });

    let result: ProviderCallResult;
    try {
      const client = reg.create();
      result = await client.extract(promptText, { maxOutputTokens: preview.maxOutputTokens, timeoutMs: this.settings.ai.timeoutMs });
    } catch {
      result = { outcome: 'network_error', candidates: [], errors: ['The provider call failed unexpectedly; no candidates were created.'], usage: null, httpStatus: null, notBilled: false };
    }

    const anchored = anchorCandidates(material.documentText, material.startChar, result.candidates);
    const errors = [...result.errors, ...anchored.errors];
    // Reconcile: reported usage when there is some; nothing for a pre-generation client error; otherwise the
    // reservation stays spent (unknown whether the provider billed it).
    const actualMicro = result.usage
      ? costMicroUsd(reg.price, result.usage.inputTokens, result.usage.outputTokens)
      : result.notBilled ? 0 : preview.estimatedCostMicroUsd;
    await this.db.orm.transaction(async tx => {
      await settle(tx, usageId, {
        actualMicro, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null, outcome: result.outcome,
      });
      await audit(tx, ctx, 'ai.executed', 'source', preview.sourceId, {
        previewId, provider, model: reg.model, revisionId: preview.revisionId, startChar: preview.startChar, endChar: preview.endChar,
        recordIds: preview.recordIds, promptSha256: preview.promptSha256, outcome: result.outcome, httpStatus: result.httpStatus,
        candidateCount: anchored.candidates.length, errors, inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null, costUsd: microToUsd(actualMicro), usageReported: result.usage !== null,
      });
    });
    return {
      previewId, provider, model: reg.model, sourceId: preview.sourceId, revisionId: preview.revisionId, promptSha256: preview.promptSha256,
      outcome: result.outcome, candidates: anchored.candidates, errors,
      usage: {
        inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null,
        reservedUsd: microToUsd(preview.estimatedCostMicroUsd), costUsd: microToUsd(actualMicro), reconciled: result.usage !== null,
      },
    };
  }
}
