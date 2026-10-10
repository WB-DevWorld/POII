// #20 conversation import: selected conversations from official ChatGPT and Claude.ai exports become sources.
// One source per conversation (kind `import`), idempotent by origin key and content hash, a changed
// conversation becomes a new revision. The import creates sources only: never records, never approvals, so
// nothing is attributed to the owner by the import itself. Assistant messages are attributed to the provider's
// ai_assistant actor in the source's origin (`origin.messages`).
import { Inject, Injectable } from '@nestjs/common';
import {
  ConversationImportRequest, ConversationPreviewRequest, MessageAttributionQuery,
  type ConversationImportResponse, type ConversationImportResult, type ConversationImportState, type ConversationPreviewResponse,
  type ConversationProvider, type MessageAttributionResponse,
} from '@poii/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../../common/audit.js';
import { AppError, badRequest } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB } from '../../common/tokens.js';
import { chunk, newId, sha256Hex } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { actor, source, sourceRevision, sourceTombstone } from '../../db/schema/index.js';
import {
  ASSISTANT_ACTOR_NAME, attributeBlocks, attributeSpan, ExportShapeError, IMPORTED_FROM, messageTimes, parseConversationExport,
  renderConversation, type ParsedConversation, type ParsedExport,
} from '../../domain/conversation-import/index.js';
import { SourcesService } from '../sources/sources.service.js';

type PreviewInput = z.output<typeof ConversationPreviewRequest>;
type ImportInput = z.output<typeof ConversationImportRequest>;
type AttributionInput = z.output<typeof MessageAttributionQuery>;
type CreateSourceInput = Parameters<SourcesService['create']>[1];

/** Version of the rendering and of `origin` for imported conversations. */
export const CONVERSATION_IMPORT_FORMAT = 'poii.conversation-import';
export const CONVERSATION_IMPORT_FORMAT_VERSION = 1;

interface Existing {
  sourceId: string;
  currentSha: string;
  shas: Set<string>;
}

function parseExportOrThrow(file: unknown): ParsedExport {
  try {
    return parseConversationExport(file);
  } catch (error) {
    if (error instanceof ExportShapeError) {
      throw badRequest('unsupported_export', error.message, error.issues.length ? error.issues : undefined);
    }
    throw error;
  }
}

function sourceTitle(conversation: ParsedConversation): string {
  const prefix = conversation.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
  return `${prefix} · ${conversation.title}`.slice(0, 500);
}

@Injectable()
export class ImportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SourcesService) private readonly sources: SourcesService,
  ) {}

  /** Lists the conversations in an export and how each relates to this workspace. Stores nothing. */
  async preview(ctx: RequestContext, input: PreviewInput): Promise<ConversationPreviewResponse> {
    requireCapability(ctx.actor, 'read');
    const parsed = parseExportOrThrow(input.file);
    const keys = parsed.conversations.map(c => c.originKey);
    const existing = await this.existingByOriginKey(ctx.workspace.id, keys);
    const deleted = await this.deletedOriginKeys(ctx.workspace.id, keys);
    return {
      provider: parsed.provider,
      importedFrom: parsed.importedFrom,
      conversationCount: parsed.conversations.length,
      conversations: parsed.conversations.map(conversation => {
        const times = messageTimes(conversation.messages);
        const found = existing.get(conversation.originKey);
        let importState: ConversationImportState = 'new';
        if (found) {
          const sha = sha256Hex(renderConversation(conversation).content);
          importState = found.currentSha === sha ? 'unchanged' : found.shas.has(sha) ? 'older' : 'changed';
        } else if (deleted.has(conversation.originKey)) {
          importState = 'deleted';
        }
        return {
          provider: conversation.provider,
          id: conversation.id,
          originKey: conversation.originKey,
          title: conversation.title,
          messageCount: conversation.messages.length,
          firstMessageAt: times.first,
          lastMessageAt: times.last,
          unknownTimeCount: times.unknownCount,
          skippedMessageCount: conversation.skippedMessageCount,
          otherBranchMessageCount: conversation.otherBranchMessageCount,
          importState,
          sourceId: found?.sourceId ?? null,
        };
      }),
    };
  }

  /** Imports exactly the selected conversations. Re-importing an unchanged conversation is a no-op. */
  async importSelected(ctx: RequestContext, input: ImportInput): Promise<ConversationImportResponse> {
    requireCapability(ctx.actor, 'propose');
    const parsed = parseExportOrThrow(input.file);
    const byId = new Map(parsed.conversations.map(c => [c.id, c]));
    const missing = input.conversationIds.filter(id => !byId.has(id));
    if (missing.length) {
      throw badRequest('conversation_not_found', `${missing.length} selected conversation id(s) are not in this file; nothing was imported`, { missing });
    }
    const selected = input.conversationIds.map(id => byId.get(id)!);
    const assistant = await this.ensureAssistantActor(ctx, parsed.provider);
    const deleted = await this.deletedOriginKeys(ctx.workspace.id, selected.map(c => c.originKey));
    const results: ConversationImportResult[] = [];
    for (const conversation of selected) {
      results.push(await this.importOne(ctx, parsed, conversation, assistant.id, deleted.has(conversation.originKey), input));
    }
    await this.db.orm.transaction(tx => audit(tx, ctx, 'conversations.imported', 'import', null, {
      provider: parsed.provider,
      fileName: input.fileName ?? null,
      results: results.map(r => ({ originKey: r.originKey, outcome: r.outcome, sourceId: r.sourceId, revisionNo: r.revisionNo })),
    }));
    return {
      provider: parsed.provider,
      importedFrom: parsed.importedFrom,
      assistantActor: { id: assistant.id, displayName: assistant.displayName },
      results,
    };
  }

  private async importOne(
    ctx: RequestContext, parsed: ParsedExport, conversation: ParsedConversation, assistantActorId: string, wasDeleted: boolean, input: ImportInput,
  ): Promise<ConversationImportResult> {
    const rendered = renderConversation(conversation);
    const sha = sha256Hex(rendered.content);
    const messageIds = new Map(conversation.messages.map(m => [m.index, m.messageId]));
    const messages = attributeBlocks(rendered.blocks, assistantActorId, messageIds);
    const base = {
      conversationId: conversation.id, originKey: conversation.originKey, title: conversation.title, messageCount: conversation.messages.length, messages,
    };
    // A conversation the owner deleted is not brought back by a re-import.
    if (wasDeleted && !(await this.existingByOriginKey(ctx.workspace.id, [conversation.originKey])).size) {
      return { ...base, outcome: 'deleted_skipped', sourceId: null, revisionId: null, revisionNo: null };
    }
    const times = messageTimes(conversation.messages);
    const origin: Record<string, unknown> = {
      provider: conversation.provider,
      conversationId: conversation.id,
      importedFrom: IMPORTED_FROM[conversation.provider],
      ...(input.exportedAt ? { exportedAt: input.exportedAt } : {}),
      format: CONVERSATION_IMPORT_FORMAT,
      formatVersion: CONVERSATION_IMPORT_FORMAT_VERSION,
      conversationTitle: conversation.title,
      conversationCreatedAt: conversation.createdAt,
      conversationUpdatedAt: conversation.updatedAt,
      firstMessageAt: times.first,
      lastMessageAt: times.last,
      linearisation: conversation.linearisation,
      skippedMessageCount: conversation.skippedMessageCount,
      otherBranchMessageCount: conversation.otherBranchMessageCount,
      // Same shape as the #21 hook capture, so a span resolves its role and actor the same way for both.
      attribution: {
        assistant: { actorKind: 'ai_assistant', actorName: ASSISTANT_ACTOR_NAME[conversation.provider], actorId: assistantActorId },
        user: { statedRole: 'unknown', note: 'The export user is the owner only where the owner says so on a record.' },
      },
      // `messages` describes the revision with this content hash; for any other revision, read the block headers
      // (GET /v1/imports/conversations/attribution). `messageId` is the export's own id (an addition to the #21 shape).
      messagesContentSha256: sha,
      messages: messages.map(m => ({
        index: m.index, role: m.exportRole, timestamp: m.createdAt, startChar: m.startChar, endChar: m.endChar, messageId: m.messageId,
      })),
    };
    // kind `import` is an existing source kind that the public POST /v1/sources does not accept; only importers create it.
    const create: CreateSourceInput = {
      title: sourceTitle(conversation),
      kind: 'import' as CreateSourceInput['kind'],
      content: rendered.content,
      mediaType: 'text/markdown',
      ...(input.fileName ? { fileName: input.fileName } : {}),
      origin,
      originKey: conversation.originKey,
      aiAllowed: input.aiAllowed,
    };
    const { view, created } = await this.sources.create(ctx, create);
    if (created) {
      return { ...base, outcome: 'created', sourceId: view.id, revisionId: view.currentRevision.id, revisionNo: view.currentRevision.revisionNo };
    }
    if (view.originKey !== conversation.originKey) {
      // Identical text already exists as another source (for example pasted by hand); nothing new is stored.
      return { ...base, outcome: 'duplicate_content', sourceId: view.id, revisionId: view.currentRevision.id, revisionNo: view.currentRevision.revisionNo };
    }
    if (view.currentRevision.contentSha256 === sha) {
      return { ...base, outcome: 'unchanged', sourceId: view.id, revisionId: view.currentRevision.id, revisionNo: view.currentRevision.revisionNo };
    }
    try {
      const { meta, created: revised } = await this.sources.addRevision(ctx, view.id, {
        content: rendered.content,
        note: `Re-imported from a ${parsed.provider === 'chatgpt' ? 'ChatGPT' : 'Claude.ai'} export${input.fileName ? ` (${input.fileName.slice(0, 200)})` : ''}`,
      });
      return { ...base, outcome: revised ? 'revised' : 'unchanged', sourceId: view.id, revisionId: meta.id, revisionNo: meta.revisionNo };
    } catch (error) {
      if (error instanceof AppError && error.code === 'revision_content_exists') {
        const details = error.details as { revisionId?: string; revisionNo?: number } | undefined;
        return { ...base, outcome: 'older_revision', sourceId: view.id, revisionId: details?.revisionId ?? null, revisionNo: details?.revisionNo ?? null };
      }
      throw error;
    }
  }

  /** Which message blocks a span of an imported conversation touches, and the attribution a candidate should carry. */
  async attribution(ctx: RequestContext, query: AttributionInput): Promise<MessageAttributionResponse> {
    requireCapability(ctx.actor, 'read');
    const detail = await this.sources.get(ctx, query.sourceId);
    const origin = detail.origin as Record<string, unknown>;
    const attribution = origin.attribution as { assistant?: { actorId?: unknown } } | undefined;
    const assistantActorId = attribution?.assistant?.actorId;
    if (detail.kind !== 'import' || (origin.importedFrom !== IMPORTED_FROM.chatgpt && origin.importedFrom !== IMPORTED_FROM.claude)
      || typeof assistantActorId !== 'string') {
      throw badRequest('not_a_conversation_import', 'This source was not created by the conversation importer');
    }
    const revision = query.revisionId && query.revisionId !== detail.currentRevision.id
      ? await this.sources.getRevision(ctx, query.sourceId, query.revisionId)
      : detail.currentRevision;
    if (query.endChar > revision.contentText.length) {
      throw badRequest('span_out_of_range', `endChar is beyond the end of revision ${revision.revisionNo}`);
    }
    // Message ids are known for the revision the stored map was computed for; block headers carry everything else.
    const messageIds = new Map<number, string | null>();
    if (origin.messagesContentSha256 === revision.contentSha256 && Array.isArray(origin.messages)) {
      for (const m of origin.messages as Array<{ index?: unknown; messageId?: unknown }>) {
        if (typeof m.index === 'number') messageIds.set(m.index, typeof m.messageId === 'string' ? m.messageId : null);
      }
    }
    const result = attributeSpan(revision.contentText, query.startChar, query.endChar, assistantActorId, messageIds);
    return { sourceId: detail.id, revisionId: revision.id, ...result };
  }

  /** The provider's "(imported)" ai_assistant actor, created once per workspace. Keyed by details, never by name. */
  private async ensureAssistantActor(ctx: RequestContext, provider: ConversationProvider): Promise<{ id: string; displayName: string }> {
    const importedFrom = IMPORTED_FROM[provider];
    return this.db.orm.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`poii.import-actor:${ctx.workspace.id}:${provider}`}))`);
      const found = (await tx.select({ id: actor.id, displayName: actor.displayName }).from(actor)
        .where(and(
          eq(actor.workspaceId, ctx.workspace.id), eq(actor.kind, 'ai_assistant'), isNull(actor.revokedAt),
          sql`${actor.details}->>'importedFrom' = ${importedFrom}`,
        ))
        .orderBy(asc(actor.createdAt), asc(actor.id)).limit(1))[0];
      if (found) return found;
      const row = (await tx.insert(actor).values({
        id: newId(), workspaceId: ctx.workspace.id, kind: 'ai_assistant', displayName: ASSISTANT_ACTOR_NAME[provider], authority: null,
        details: { provider, importedFrom, purpose: 'attribution of imported assistant messages' },
      }).returning({ id: actor.id, displayName: actor.displayName }))[0]!;
      await audit(tx, ctx, 'actor.created', 'actor', row.id, { kind: 'ai_assistant', importedFrom });
      return row;
    });
  }

  private async existingByOriginKey(workspaceId: string, keys: string[]): Promise<Map<string, Existing>> {
    const out = new Map<string, Existing>();
    for (const part of chunk([...new Set(keys)], 500)) {
      if (!part.length) continue;
      const rows = await this.db.orm.select({
        sourceId: source.id, originKey: source.originKey, sha: sourceRevision.contentSha256, revisionNo: sourceRevision.revisionNo,
      }).from(source)
        .innerJoin(sourceRevision, eq(sourceRevision.sourceId, source.id))
        .where(and(eq(source.workspaceId, workspaceId), inArray(source.originKey, part)))
        .orderBy(asc(sourceRevision.revisionNo));
      for (const row of rows) {
        const entry = out.get(row.originKey!) ?? { sourceId: row.sourceId, currentSha: row.sha, shas: new Set<string>() };
        entry.shas.add(row.sha);
        entry.currentSha = row.sha; // ordered by revision number: the last one wins
        out.set(row.originKey!, entry);
      }
    }
    return out;
  }

  private async deletedOriginKeys(workspaceId: string, keys: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunk([...new Set(keys)], 500)) {
      if (!part.length) continue;
      const rows = await this.db.orm.select({ originKey: sourceTombstone.originKey }).from(sourceTombstone)
        .where(and(eq(sourceTombstone.workspaceId, workspaceId), inArray(sourceTombstone.originKey, part)));
      for (const row of rows) if (row.originKey) out.add(row.originKey);
    }
    return out;
  }
}
