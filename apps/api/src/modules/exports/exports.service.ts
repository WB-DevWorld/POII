import { Inject, Injectable } from '@nestjs/common';
import {
  CONTEXT_PACK_VERSION,
  type ContextPackRequest, type ContextPackResponse, ExportRunView,
} from '@poii/contracts';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../../common/audit.js';
import { notFound } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB, STORAGE_PORT } from '../../common/tokens.js';
import { canonicalJson, iso, newId, sha256Hex } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { exportRun, record, recordEvidence, source, sourceRevision, sourceTombstone } from '../../db/schema/index.js';
import type { Exec } from '../../db/types.js';
import { buildContextPack, type PackSourceInfo } from '../../domain/context-pack.js';
import type { StoragePort } from '../../ports/storage.js';
import { loadApprovals, loadEvidence, toSummaries } from '../records/records.repository.js';
import { stalenessOf } from '../views/views.service.js';

type PackRequest = z.output<typeof ContextPackRequest>;

/** Of the given ids, those that are confirmed and have no confirmed successor. */
async function currentIds(exec: Exec, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await exec.select({ id: record.id }).from(record).where(and(
    inArray(record.id, ids),
    eq(record.reviewState, 'confirmed'),
    sql`NOT EXISTS (SELECT 1 FROM record s WHERE s.supersedes_record_id = ${record.id} AND s.review_state = 'confirmed')`,
    sql`NOT EXISTS (SELECT 1 FROM approval a JOIN record s ON s.id = a.record_id
      WHERE a.antecedent_record_id = ${record.id} AND s.review_state = 'confirmed' AND s.id <> ${record.id})`,
  ));
  return new Set(rows.map(r => r.id));
}

@Injectable()
export class ExportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async contextPack(ctx: RequestContext, request: PackRequest): Promise<ContextPackResponse> {
    requireCapability(ctx.actor, 'read');
    const exec = this.db.orm;
    const ws = ctx.workspace.id;
    let citing: string[] | undefined;
    if (request.sourceIds?.length) {
      citing = (await exec.selectDistinct({ id: recordEvidence.recordId }).from(recordEvidence)
        .where(or(inArray(recordEvidence.sourceId, request.sourceIds), inArray(recordEvidence.originalSourceId, request.sourceIds))))
        .map(r => r.id);
    }
    const rows = citing && !citing.length ? [] : await exec.select().from(record).where(and(
      eq(record.workspaceId, ws),
      request.reviewStates.length ? inArray(record.reviewState, request.reviewStates) : undefined,
      request.kinds?.length ? inArray(record.kind, request.kinds) : undefined,
      request.lifecycleStatuses?.length ? inArray(record.lifecycleStatus, request.lifecycleStatuses) : undefined,
      request.recordIds ? (request.recordIds.length ? inArray(record.id, request.recordIds) : sql`false`) : undefined,
      citing ? inArray(record.id, citing) : undefined,
    )).orderBy(asc(record.kind), asc(record.recordedAt), asc(record.id));
    const ids = rows.map(r => r.id);
    const summaries = await toSummaries(exec, rows);
    const evidence = await loadEvidence(exec, ids);
    const approvals = await loadApprovals(exec, ids);
    const current = await currentIds(exec, ids);

    const liveSourceIds = new Set<string>(request.sourceIds ?? []);
    const deletedIds = new Set<string>(request.sourceIds ?? []);
    for (const list of evidence.values()) {
      for (const e of list) {
        if (e.sourceId) liveSourceIds.add(e.sourceId);
        else deletedIds.add(e.originalSourceId);
      }
    }
    const sources = new Map<string, PackSourceInfo>();
    if (liveSourceIds.size) {
      const sourceRows = await exec.select().from(source).where(and(eq(source.workspaceId, ws), inArray(source.id, [...liveSourceIds])));
      const revisions = sourceRows.length
        ? await exec.selectDistinctOn([sourceRevision.sourceId], { sourceId: sourceRevision.sourceId, id: sourceRevision.id, sha: sourceRevision.contentSha256 })
          .from(sourceRevision).where(inArray(sourceRevision.sourceId, sourceRows.map(s => s.id)))
          .orderBy(sourceRevision.sourceId, desc(sourceRevision.revisionNo))
        : [];
      const revBy = new Map(revisions.map(r => [r.sourceId, r]));
      for (const s of sourceRows) {
        const rev = revBy.get(s.id)!;
        sources.set(s.id, { id: s.id, title: s.title, currentRevisionId: rev.id, currentSha256: rev.sha, aiAllowed: s.aiAllowed, archived: s.archivedAt !== null });
      }
    }
    const tombstones = new Map<string, { lastContentSha256: string | null }>();
    if (deletedIds.size) {
      const rowsT = await exec.select().from(sourceTombstone)
        .where(and(eq(sourceTombstone.workspaceId, ws), inArray(sourceTombstone.id, [...deletedIds])));
      for (const t of rowsT) tombstones.set(t.id, { lastContentSha256: t.lastContentSha256 });
    }

    const exportRunId = newId();
    const generatedAt = new Date().toISOString();
    const selection = canonicalSelection(request);
    const pack = buildContextPack({
      exportRunId,
      generatedAt,
      destination: request.destination,
      title: request.title,
      selection,
      includeExcerpts: request.includeExcerpts,
      requestedSourceIds: request.sourceIds,
      sources,
      tombstones,
      records: rows.map((row, i) => ({
        summary: summaries[i]!,
        body: row.body,
        statedByActorId: row.statedByActorId,
        timeConflicts: (row.timeConflicts as Array<{ value: string | null }> | null) ?? null,
        approvals: approvals.get(row.id) ?? [],
        evidence: evidence.get(row.id) ?? [],
        current: current.has(row.id),
        staleness: stalenessOf(row.observedAtStatus === 'known' ? row.observedAt : null),
      })),
    });
    const response: ContextPackResponse = { exportRunId, manifest: pack.manifest, markdown: pack.markdown, json: pack.json };
    const contentSha256 = sha256Hex(canonicalJson(pack.json));
    const storageKey = `exports/${exportRunId}.json`;
    await this.storage.put(storageKey, Buffer.from(JSON.stringify(response), 'utf8'));
    try {
      await this.db.orm.transaction(async tx => {
        await tx.insert(exportRun).values({
          id: exportRunId, workspaceId: ws, kind: 'context_pack', formatVersion: CONTEXT_PACK_VERSION, selection,
          manifest: pack.manifest as unknown as Record<string, unknown>, contentSha256, storageKey, createdByActorId: ctx.actor.id,
        });
        await audit(tx, ctx, 'export.context_pack', 'export_run', exportRunId, {
          destination: request.destination, recordCount: pack.records.length, excludedRecordCount: pack.excludedRecords.length,
          included: pack.manifest.included.length, excluded: pack.manifest.excluded.length, unavailable: pack.manifest.unavailable.length,
        });
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    return response;
  }

  async list(ctx: RequestContext): Promise<z.infer<typeof ExportRunView>[]> {
    requireCapability(ctx.actor, 'read');
    const rows = await this.db.orm.select().from(exportRun).where(eq(exportRun.workspaceId, ctx.workspace.id))
      .orderBy(desc(exportRun.createdAt), desc(exportRun.id)).limit(200);
    return rows.map(r => ({
      id: r.id, kind: r.kind, formatVersion: r.formatVersion, createdAt: iso(r.createdAt), contentSha256: r.contentSha256, manifest: r.manifest,
    }));
  }

  /** The stored context pack or backup document. */
  async get(ctx: RequestContext, id: string): Promise<unknown> {
    requireCapability(ctx.actor, 'read');
    const run = (await this.db.orm.select().from(exportRun).where(and(eq(exportRun.id, id), eq(exportRun.workspaceId, ctx.workspace.id))))[0];
    if (!run) throw notFound('Export');
    // A backup contains everything, including never-send material: reading it back needs authority.
    requireCapability(ctx.actor, run.kind === 'backup' ? 'confirm' : 'read');
    const bytes = run.storageKey ? await this.storage.get(run.storageKey) : null;
    if (!bytes) throw notFound('Export content');
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  }
}

function canonicalSelection(request: PackRequest): Record<string, unknown> {
  return JSON.parse(canonicalJson(request)) as Record<string, unknown>;
}
