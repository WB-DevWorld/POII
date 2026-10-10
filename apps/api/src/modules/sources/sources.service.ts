import { Inject, Injectable } from '@nestjs/common';
import type {
  AddRevisionRequest, CreateSourceRequest, DeleteSourceRequest, ListSourcesQuery, Locator, RecordSummary, RevisionMeta,
  RevisionView, SourceDetail, SourceView, UpdateSourceRequest,
} from '@poii/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../../common/audit.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB, STORAGE_PORT } from '../../common/tokens.js';
import { newId, sha256Hex } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { record, recordEvidence, source, sourceRevision, sourceTombstone } from '../../db/schema/index.js';
import type { Exec, SourceRow } from '../../db/types.js';
import { computeLocator, DELETED_EXCERPT, reanchor } from '../../domain/locator.js';
import { countLines } from '../../domain/text.js';
import type { StoragePort } from '../../ports/storage.js';
import { changeRecord, recomputeRecordAiAllowed, toSummaries } from '../records/records.repository.js';
import { findSource, revisionsOf, toRevisionMeta, toSourceViews } from './sources.repository.js';

type CreateSource = z.output<typeof CreateSourceRequest>;
type AddRevision = z.output<typeof AddRevisionRequest>;
type UpdateSource = z.output<typeof UpdateSourceRequest>;
type DeleteSource = z.output<typeof DeleteSourceRequest>;
type ListSources = z.output<typeof ListSourcesQuery>;

export const revisionStorageKey = (sourceId: string, revisionId: string) => `sources/${sourceId}/${revisionId}`;

function assertStorableText(content: string) {
  if (content.includes('\u0000')) throw badRequest('invalid_content', 'Content may not contain NUL characters');
}

@Injectable()
export class SourcesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** Creates a source, or returns the existing one for the same origin key or content hash. */
  async create(ctx: RequestContext, input: CreateSource): Promise<{ view: SourceView; created: boolean }> {
    requireCapability(ctx.actor, 'propose');
    assertStorableText(input.content);
    const sha = sha256Hex(input.content);
    const bytes = Buffer.from(input.content, 'utf8');
    let storedKey: string | null = null;
    try {
      const result = await this.db.orm.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`poii.sources:${ctx.workspace.id}`}))`);
        const existing = await this.findDuplicate(tx, ctx.workspace.id, input.originKey ?? null, sha);
        if (existing) return { row: existing, created: false };
        const sourceId = newId();
        const revisionId = newId();
        const key = revisionStorageKey(sourceId, revisionId);
        const origin = { ...input.origin, ...(input.fileName ? { fileName: input.fileName } : {}) };
        const row = (await tx.insert(source).values({
          id: sourceId, workspaceId: ctx.workspace.id, title: input.title, kind: input.kind, mediaType: input.mediaType,
          origin, originKey: input.originKey ?? null, aiAllowed: input.aiAllowed, createdByActorId: ctx.actor.id,
        }).returning())[0]!;
        await tx.insert(sourceRevision).values({
          id: revisionId, sourceId, revisionNo: 1, contentText: input.content, contentSha256: sha, byteLength: bytes.byteLength,
          lineCount: countLines(input.content), storageKey: key, createdByActorId: ctx.actor.id,
        });
        await this.storage.put(key, bytes);
        storedKey = key;
        await audit(tx, ctx, 'source.created', 'source', sourceId, {
          kind: input.kind, contentSha256: sha, byteLength: bytes.byteLength, aiAllowed: input.aiAllowed, originKey: input.originKey ?? null,
        });
        return { row, created: true };
      });
      const [view] = await toSourceViews(this.db.orm, [result.row]);
      return { view: result.created ? view! : { ...view!, deduplicated: true }, created: result.created };
    } catch (error) {
      if (storedKey) await this.storage.delete(storedKey).catch(() => undefined);
      throw error;
    }
  }

  private async findDuplicate(exec: Exec, workspaceId: string, originKey: string | null, sha: string): Promise<SourceRow | null> {
    if (originKey) {
      const byKey = (await exec.select().from(source).where(and(eq(source.workspaceId, workspaceId), eq(source.originKey, originKey))))[0];
      if (byKey) return byKey;
    }
    const byHash = (await exec.select({ s: source }).from(source)
      .innerJoin(sourceRevision, eq(sourceRevision.sourceId, source.id))
      .where(and(eq(source.workspaceId, workspaceId), eq(sourceRevision.contentSha256, sha)))
      .orderBy(source.createdAt).limit(1))[0];
    return byHash?.s ?? null;
  }

  async list(ctx: RequestContext, query: ListSources): Promise<SourceView[]> {
    requireCapability(ctx.actor, 'read');
    const archived = query.archived === 'true' ? isNotNull(source.archivedAt) : query.archived === 'false' ? isNull(source.archivedAt) : undefined;
    const rows = await this.db.orm.select().from(source)
      .where(and(eq(source.workspaceId, ctx.workspace.id), archived))
      .orderBy(desc(source.createdAt), desc(source.id)).limit(query.limit).offset(query.offset);
    return toSourceViews(this.db.orm, rows);
  }

  async get(ctx: RequestContext, id: string): Promise<SourceDetail> {
    requireCapability(ctx.actor, 'read');
    const row = await findSource(this.db.orm, ctx.workspace.id, id);
    const [view] = await toSourceViews(this.db.orm, [row]);
    const revisions = await revisionsOf(this.db.orm, id);
    const current = revisions[revisions.length - 1]!;
    const text = (await this.db.orm.select({ contentText: sourceRevision.contentText }).from(sourceRevision).where(eq(sourceRevision.id, current.id)))[0]!;
    return {
      ...view!,
      revisions: revisions.map(toRevisionMeta),
      currentRevision: { ...toRevisionMeta(current), contentText: text.contentText },
    };
  }

  async getRevision(ctx: RequestContext, id: string, revisionId: string): Promise<RevisionView> {
    requireCapability(ctx.actor, 'read');
    await findSource(this.db.orm, ctx.workspace.id, id);
    const row = (await this.db.orm.select().from(sourceRevision)
      .where(and(eq(sourceRevision.id, revisionId), eq(sourceRevision.sourceId, id))))[0];
    if (!row) throw notFound('Revision');
    return { ...toRevisionMeta(row), contentText: row.contentText };
  }

  /** Adds a revision (identical content is a no-op) and re-anchors every evidence locator on this source. */
  async addRevision(ctx: RequestContext, id: string, input: AddRevision): Promise<{ meta: RevisionMeta; created: boolean }> {
    requireCapability(ctx.actor, 'propose');
    assertStorableText(input.content);
    const sha = sha256Hex(input.content);
    const bytes = Buffer.from(input.content, 'utf8');
    let storedKey: string | null = null;
    try {
      return await this.db.orm.transaction(async tx => {
        await findSource(tx, ctx.workspace.id, id, true);
        const revisions = await revisionsOf(tx, id);
        const current = revisions[revisions.length - 1]!;
        if (current.contentSha256 === sha) return { meta: toRevisionMeta(current), created: false };
        const older = revisions.find(r => r.contentSha256 === sha);
        if (older) {
          throw conflict('revision_content_exists', `This content is already revision ${older.revisionNo} of the source`, {
            revisionId: older.id, revisionNo: older.revisionNo,
          });
        }
        const revisionId = newId();
        const key = revisionStorageKey(id, revisionId);
        const inserted = (await tx.insert(sourceRevision).values({
          id: revisionId, sourceId: id, revisionNo: current.revisionNo + 1, contentText: input.content, contentSha256: sha,
          byteLength: bytes.byteLength, lineCount: countLines(input.content), storageKey: key, note: input.note ?? null,
          createdByActorId: ctx.actor.id,
        }).returning())[0]!;
        await this.storage.put(key, bytes);
        storedKey = key;
        const reanchored = await this.reanchorEvidence(tx, ctx, id, inserted.id, inserted.revisionNo, input.content);
        await audit(tx, ctx, 'source.revision_added', 'source', id, {
          revisionId, revisionNo: inserted.revisionNo, contentSha256: sha, reanchored,
        });
        return { meta: { ...toRevisionMeta(inserted), reanchored }, created: true };
      });
    } catch (error) {
      if (storedKey) await this.storage.delete(storedKey).catch(() => undefined);
      throw error;
    }
  }

  private async reanchorEvidence(tx: Exec, ctx: RequestContext, sourceId: string, revisionId: string, revisionNo: number, newText: string) {
    const counts = { exact: 0, moved: 0, lost: 0 };
    const evidence = await tx.select().from(recordEvidence).where(eq(recordEvidence.sourceId, sourceId));
    const texts = new Map<string, string>();
    const changedRecords = new Map<string, string[]>();
    for (const e of evidence) {
      if (!e.revisionId || e.revisionId === revisionId) continue;
      let oldText = texts.get(e.revisionId);
      if (oldText === undefined) {
        oldText = (await tx.select({ t: sourceRevision.contentText }).from(sourceRevision).where(eq(sourceRevision.id, e.revisionId)))[0]?.t ?? '';
        texts.set(e.revisionId, oldText);
      }
      const locator = e.locator as unknown as Locator;
      const outcome = reanchor(oldText, locator.startChar, locator.endChar, newText);
      counts[outcome.result]++;
      if (outcome.result === 'lost') {
        if (e.anchorResult === 'lost') continue;
        // Never silently re-pointed: a lost span keeps its old revision and offsets.
        await tx.update(recordEvidence).set({ anchorResult: 'lost' }).where(eq(recordEvidence.id, e.id));
      } else {
        const next = computeLocator(newText, revisionId, outcome.startChar!, outcome.endChar!);
        await tx.update(recordEvidence).set({ revisionId, locator: next, anchorResult: outcome.result }).where(eq(recordEvidence.id, e.id));
      }
      const notes = changedRecords.get(e.recordId) ?? [];
      notes.push(`${e.id}: ${outcome.result}`);
      changedRecords.set(e.recordId, notes);
    }
    for (const [recordId, notes] of changedRecords) {
      await changeRecord(tx, recordId, {}, 'evidence', ctx.actor.id, `Re-anchored to revision ${revisionNo}: ${notes.join(', ')}`);
    }
    return counts;
  }

  async update(ctx: RequestContext, id: string, input: UpdateSource): Promise<SourceView> {
    requireCapability(ctx.actor, 'propose');
    // Changing what may reach AI, or archiving (which removes a source from exports), is a policy change.
    if (input.aiAllowed !== undefined || input.archived !== undefined) requireCapability(ctx.actor, 'delete');
    const row = await this.db.orm.transaction(async tx => {
      const before = await findSource(tx, ctx.workspace.id, id, true);
      const patch: Partial<typeof source.$inferInsert> = {};
      if (input.title !== undefined && input.title !== before.title) patch.title = input.title;
      if (input.aiAllowed !== undefined && input.aiAllowed !== before.aiAllowed) patch.aiAllowed = input.aiAllowed;
      if (input.archived !== undefined && input.archived !== (before.archivedAt !== null)) patch.archivedAt = input.archived ? new Date() : null;
      if (!Object.keys(patch).length) return before;
      const after = (await tx.update(source).set(patch).where(eq(source.id, id)).returning())[0]!;
      if (patch.aiAllowed !== undefined) {
        const recordIds = await this.recordIdsCiting(tx, id);
        await recomputeRecordAiAllowed(tx, recordIds);
      }
      await audit(tx, ctx, 'source.updated', 'source', id, {
        changes: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])),
      });
      return after;
    });
    return (await toSourceViews(this.db.orm, [row]))[0]!;
  }

  private async recordIdsCiting(exec: Exec, sourceId: string): Promise<string[]> {
    const rows = await exec.selectDistinct({ recordId: recordEvidence.recordId }).from(recordEvidence).where(eq(recordEvidence.sourceId, sourceId));
    return rows.map(r => r.recordId);
  }

  /** Hard delete: content, revisions, originals and search entries go; a tombstone stays; evidence becomes unavailable. */
  async remove(ctx: RequestContext, id: string, input: DeleteSource): Promise<void> {
    requireCapability(ctx.actor, 'delete');
    const keys = await this.db.orm.transaction(async tx => {
      const row = await findSource(tx, ctx.workspace.id, id, true);
      const revisions = await revisionsOf(tx, id);
      const recordIds = await this.recordIdsCiting(tx, id);
      await tx.update(recordEvidence)
        .set({
          sourceId: null,
          revisionId: null,
          locator: sql`jsonb_set(${recordEvidence.locator}, '{excerpt}', to_jsonb(${DELETED_EXCERPT}::text))`,
        })
        .where(eq(recordEvidence.sourceId, id));
      await tx.insert(sourceTombstone).values({
        id, workspaceId: ctx.workspace.id, originKey: row.originKey, lastContentSha256: revisions[revisions.length - 1]?.contentSha256 ?? null,
        deletedByActorId: ctx.actor.id, reason: input.reason ?? null,
      });
      // Evidence was detached above (it keeps original_source_id); revisions cascade.
      await tx.delete(source).where(eq(source.id, id));
      await recomputeRecordAiAllowed(tx, recordIds);
      for (const recordId of recordIds) {
        await changeRecord(tx, recordId, {}, 'evidence', ctx.actor.id, `Source ${id} was deleted; its evidence is unavailable`);
      }
      await audit(tx, ctx, 'source.deleted', 'source', id, {
        reason: input.reason ?? null, revisionCount: revisions.length, affectedRecordIds: recordIds,
      });
      return revisions.map(r => r.storageKey).filter((k): k is string => !!k);
    });
    for (const key of keys) await this.storage.delete(key).catch(() => undefined);
  }

  /** Records citing this source, including through evidence that became unavailable when it was deleted. */
  async records(ctx: RequestContext, id: string): Promise<RecordSummary[]> {
    requireCapability(ctx.actor, 'read');
    const exists = (await this.db.orm.select({ id: source.id }).from(source).where(and(eq(source.id, id), eq(source.workspaceId, ctx.workspace.id))))[0]
      ?? (await this.db.orm.select({ id: sourceTombstone.id }).from(sourceTombstone)
        .where(and(eq(sourceTombstone.id, id), eq(sourceTombstone.workspaceId, ctx.workspace.id))))[0];
    if (!exists) throw notFound('Source');
    const ids = (await this.db.orm.selectDistinct({ recordId: recordEvidence.recordId }).from(recordEvidence)
      .where(or(eq(recordEvidence.sourceId, id), eq(recordEvidence.originalSourceId, id)))).map(r => r.recordId);
    if (!ids.length) return [];
    const rows = await this.db.orm.select().from(record)
      .where(and(eq(record.workspaceId, ctx.workspace.id), inArray(record.id, ids))).orderBy(desc(record.recordedAt), desc(record.id));
    return toSummaries(this.db.orm, rows);
  }
}
