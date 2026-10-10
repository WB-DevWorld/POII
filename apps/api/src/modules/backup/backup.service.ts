// poii.backup v1 (ADR-0008): the complete workspace with identical ids and original bytes, and restore into an
// empty install. Restore replaces the empty bootstrap workspace with the backed-up one, keeping every id.
import { Inject, Injectable } from '@nestjs/common';
import {
  ActorKind, AnchorResult, Authority, BACKUP_FORMAT, BACKUP_VERSION, BackupDocument, EvidenceRole, Id, IsoTime, LifecycleStatus,
  RecordKind, ReviewState, StatedRole, StatementMode, TimeStatus,
  type RestoreResponse,
} from '@poii/contracts';
import { and, asc, count, eq, getTableColumns, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../../common/audit.js';
import { badRequest, conflict } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB, IDENTITY_PORT, STORAGE_PORT } from '../../common/tokens.js';
import { canonicalJson, chunk, newId, sha256Hex } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import {
  actor, approval, auditEvent, exportRun, idempotencyKey, record, recordEvidence, recordVersion, source, sourceRevision,
  sourceTombstone, workspace,
} from '../../db/schema/index.js';
import type { Exec } from '../../db/types.js';
import type { IdentityPort } from '../../ports/identity.js';
import type { StoragePort } from '../../ports/storage.js';

const { searchVector: _rsv, ...revisionColumns } = getTableColumns(sourceRevision);
const { searchVector: _rv, ...recordColumns } = getTableColumns(record);

const json = z.record(z.string(), z.unknown());
const ts = IsoTime;
const tsN = IsoTime.nullable();

const ActorB = z.object({ id: Id, workspaceId: Id, kind: ActorKind, displayName: z.string(), authority: Authority.nullable(), details: json, createdAt: ts, revokedAt: tsN });
const SourceB = z.object({
  id: Id, workspaceId: Id, title: z.string(), kind: z.enum(['paste', 'upload', 'import']), mediaType: z.string(), origin: json,
  originKey: z.string().nullable(), aiAllowed: z.boolean(), archivedAt: tsN, createdAt: ts, createdByActorId: Id,
});
const RevisionB = z.object({
  id: Id, sourceId: Id, revisionNo: z.number().int().positive(), contentText: z.string(), contentSha256: z.string(),
  byteLength: z.number().int().nonnegative(), lineCount: z.number().int().nonnegative(), storageKey: z.string().nullable(),
  note: z.string().nullable(), createdAt: ts, createdByActorId: Id, originalBase64: z.string(),
});
const TombstoneB = z.object({
  id: Id, workspaceId: Id, originKey: z.string().nullable(), lastContentSha256: z.string().nullable(), deletedAt: ts,
  deletedByActorId: Id, reason: z.string().nullable(),
});
const RecordB = z.object({
  id: Id, workspaceId: Id, kind: RecordKind, title: z.string(), body: z.string(), reviewState: ReviewState, lifecycleStatus: LifecycleStatus,
  statedByActorId: Id.nullable(), statedRole: StatedRole, statementMode: StatementMode, recordedAt: ts, effectiveAt: tsN,
  effectiveAtStatus: TimeStatus, observedAt: tsN, observedAtStatus: TimeStatus, timeConflicts: z.array(json).nullable(),
  supersedesRecordId: Id.nullable(), rejectedAt: tsN, rejectionReason: z.string().nullable(), aiAllowed: z.boolean(),
  origin: json.nullable(), versionNo: z.number().int().positive(), createdByActorId: Id, updatedAt: ts,
});
const VersionB = z.object({
  id: Id, recordId: Id, versionNo: z.number().int().positive(),
  changeKind: z.enum(['create', 'edit', 'confirm', 'reject', 'supersede', 'status', 'evidence']), snapshot: json,
  changedByActorId: Id, changedAt: ts, note: z.string().nullable(),
});
const EvidenceB = z.object({
  id: Id, recordId: Id, sourceId: Id.nullable(), originalSourceId: Id, revisionId: Id.nullable(), locator: json, role: EvidenceRole,
  anchorResult: AnchorResult, createdAt: ts,
});
const ApprovalB = z.object({
  id: Id, recordId: Id, approvedByActorId: Id, authority: Authority, approvedAt: ts, antecedentRecordId: Id.nullable(), note: z.string().nullable(),
});
const AuditB = z.object({
  id: Id, workspaceId: Id, actorId: Id.nullable(), action: z.string(), targetType: z.string(), targetId: Id.nullable(),
  requestId: z.string().nullable(), details: json, at: ts,
});
const ExportRunB = z.object({
  id: Id, workspaceId: Id, kind: z.enum(['context_pack', 'backup']), formatVersion: z.number().int(), selection: json, manifest: json,
  contentSha256: z.string(), storageKey: z.string().nullable(), createdAt: ts, createdByActorId: Id,
});

/** Converts the named ISO-string fields back to Dates. */
function withDates<T extends Record<string, unknown>, K extends keyof T>(row: T, keys: K[]): Omit<T, K> & { [P in K]: Date | Extract<T[P], null> } {
  const out: Record<string, unknown> = { ...row };
  for (const key of keys) out[key as string] = row[key] === null ? null : new Date(row[key] as string);
  return out as Omit<T, K> & { [P in K]: Date | Extract<T[P], null> };
}

function serialize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out;
}

type Counts = RestoreResponse['restored'];

/** How a backup was triggered and where its document goes (#16 backup runner). Defaults: HTTP, copy kept in storage. */
export interface BackupOptions {
  /** Recorded in the audit event, e.g. `http` or `backup-cli`. */
  via?: string;
  /**
   * Where the document's bytes go instead of the storage port's `backups/<exportRunId>.json` copy (the HTTP default).
   * Called before the export run and audit event are committed: if it throws, nothing is recorded. The scheduled
   * runner passes its target's put, so the storage volume does not grow and history never claims a backup that did
   * not land. `info.contentSha256` is the SHA-256 of canonicalJson(doc), the value stored in export_run.
   */
  sink?: (bytes: Buffer, info: { exportRunId: string; contentSha256: string }) => Promise<void>;
  /** Extra manifest fields describing where the document went (target and object key). */
  destination?: Record<string, unknown>;
}

@Injectable()
export class BackupService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
  ) {}

  async backup(ctx: RequestContext, options: BackupOptions = {}): Promise<BackupDocument> {
    const { via = 'http', sink, destination } = options;
    // A backup carries everything, including never-send-to-AI material: it needs a person with authority.
    requireCapability(ctx.actor, 'confirm');
    const ws = ctx.workspace.id;
    const data = await this.db.orm.transaction(async tx => {
      const wsRow = (await tx.select().from(workspace).where(eq(workspace.id, ws)))[0]!;
      const actors = await tx.select().from(actor).where(eq(actor.workspaceId, ws)).orderBy(asc(actor.createdAt), asc(actor.id));
      const sources = await tx.select().from(source).where(eq(source.workspaceId, ws)).orderBy(asc(source.createdAt), asc(source.id));
      const sourceIds = sources.map(s => s.id);
      const revisions = sourceIds.length
        ? await tx.select(revisionColumns).from(sourceRevision).where(inArray(sourceRevision.sourceId, sourceIds))
          .orderBy(asc(sourceRevision.sourceId), asc(sourceRevision.revisionNo))
        : [];
      const tombstones = await tx.select().from(sourceTombstone).where(eq(sourceTombstone.workspaceId, ws)).orderBy(asc(sourceTombstone.deletedAt), asc(sourceTombstone.id));
      const records = await tx.select(recordColumns).from(record).where(eq(record.workspaceId, ws)).orderBy(asc(record.recordedAt), asc(record.id));
      const recordIds = records.map(r => r.id);
      const byRecords = recordIds.length > 0;
      const versions = byRecords
        ? await tx.select().from(recordVersion).where(inArray(recordVersion.recordId, recordIds)).orderBy(asc(recordVersion.recordId), asc(recordVersion.versionNo))
        : [];
      const evidence = byRecords
        ? await tx.select().from(recordEvidence).where(inArray(recordEvidence.recordId, recordIds)).orderBy(asc(recordEvidence.createdAt), asc(recordEvidence.id))
        : [];
      const approvals = byRecords
        ? await tx.select().from(approval).where(inArray(approval.recordId, recordIds)).orderBy(asc(approval.approvedAt), asc(approval.id))
        : [];
      const auditEvents = await tx.select().from(auditEvent).where(eq(auditEvent.workspaceId, ws)).orderBy(asc(auditEvent.at), asc(auditEvent.id));
      const exportRuns = await tx.select().from(exportRun).where(eq(exportRun.workspaceId, ws)).orderBy(asc(exportRun.createdAt), asc(exportRun.id));
      return { wsRow, actors, sources, revisions, tombstones, records, versions, evidence, approvals, auditEvents, exportRuns };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });

    const revisions = [];
    for (const r of data.revisions) {
      const stored = r.storageKey ? await this.storage.get(r.storageKey) : null;
      const bytes = stored ?? Buffer.from(r.contentText, 'utf8');
      revisions.push({ ...serialize(r), originalBase64: Buffer.from(bytes).toString('base64') });
    }
    const exportRunId = newId();
    const doc: BackupDocument = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_VERSION,
      generatedAt: new Date().toISOString(),
      exportRunId,
      workspace: { id: data.wsRow.id, name: data.wsRow.name, createdAt: data.wsRow.createdAt.toISOString() },
      actors: data.actors.map(serialize),
      sources: data.sources.map(serialize),
      revisions,
      tombstones: data.tombstones.map(serialize),
      records: data.records.map(serialize),
      versions: data.versions.map(serialize),
      evidence: data.evidence.map(serialize),
      approvals: data.approvals.map(serialize),
      auditEvents: data.auditEvents.map(serialize),
      exportRuns: data.exportRuns.map(serialize),
    };
    const counts = countsOf(doc);
    const contentSha256 = sha256Hex(canonicalJson(doc));
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    const storageKey = sink ? null : `backups/${exportRunId}.json`;
    if (sink) await sink(bytes, { exportRunId, contentSha256 });
    else await this.storage.put(storageKey!, bytes);
    try {
      await this.db.orm.transaction(async tx => {
        await tx.insert(exportRun).values({
          id: exportRunId, workspaceId: ws, kind: 'backup', formatVersion: BACKUP_VERSION, selection: {},
          manifest: { format: BACKUP_FORMAT, formatVersion: BACKUP_VERSION, workspaceId: ws, counts, ...(destination ? { destination } : {}) },
          contentSha256, storageKey, createdByActorId: ctx.actor.id,
        });
        await audit(tx, ctx, 'workspace.backup', 'export_run', exportRunId, { counts, contentSha256, via, ...(destination ? { destination } : {}) });
      });
    } catch (error) {
      if (storageKey) await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    return doc;
  }

  async restore(ctx: RequestContext, raw: Record<string, unknown>): Promise<RestoreResponse> {
    requireCapability(ctx.actor, 'delete');
    const doc = BackupDocument.parse(raw);
    const backupSha256 = sha256Hex(canonicalJson(doc));
    const target = doc.workspace.id;
    const rows = {
      actors: doc.actors.map(r => ActorB.parse(r)),
      sources: doc.sources.map(r => SourceB.parse(r)),
      revisions: doc.revisions.map(r => RevisionB.parse(r)),
      tombstones: doc.tombstones.map(r => TombstoneB.parse(r)),
      records: doc.records.map(r => RecordB.parse(r)),
      versions: doc.versions.map(r => VersionB.parse(r)),
      evidence: doc.evidence.map(r => EvidenceB.parse(r)),
      approvals: doc.approvals.map(r => ApprovalB.parse(r)),
      auditEvents: doc.auditEvents.map(r => AuditB.parse(r)),
      exportRuns: doc.exportRuns.map(r => ExportRunB.parse(r)),
    };
    for (const list of [rows.actors, rows.sources, rows.tombstones, rows.records, rows.auditEvents, rows.exportRuns]) {
      if (list.some(r => r.workspaceId !== target)) throw badRequest('invalid_backup', 'Every row must belong to the backed-up workspace');
    }
    const zero: Counts = { sources: 0, revisions: 0, records: 0, approvals: 0, evidence: 0, versions: 0, actors: 0, tombstones: 0, auditEvents: 0 };

    const result = await this.db.orm.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('poii.restore'))`);
      const previous = ctx.workspace.id;
      if (previous === target) {
        const done = (await tx.select({ id: auditEvent.id }).from(auditEvent).where(and(
          eq(auditEvent.workspaceId, target), eq(auditEvent.action, 'workspace.restored'),
          sql`${auditEvent.details} ->> 'backupSha256' = ${backupSha256}`,
        )).limit(1))[0];
        if (done) return { restored: zero, workspaceId: target, alreadyRestored: true };
        throw conflict('workspace_not_empty', 'This workspace already holds data; restore only goes into an empty workspace');
      }
      await this.assertEmpty(tx, ctx);
      if ((await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, target)))[0]) {
        throw conflict('workspace_exists', 'The backed-up workspace already exists in this install');
      }

      await tx.insert(workspace).values({ id: target, name: doc.workspace.name, createdAt: new Date(doc.workspace.createdAt) });
      for (const part of chunk(rows.actors, 500)) await tx.insert(actor).values(part.map(r => withDates(r, ['createdAt', 'revokedAt'])));
      for (const part of chunk(rows.sources, 500)) await tx.insert(source).values(part.map(r => withDates(r, ['archivedAt', 'createdAt'])));
      for (const part of chunk(rows.revisions, 50)) {
        await tx.insert(sourceRevision).values(part.map(({ originalBase64: _o, ...r }) => withDates(r, ['createdAt'])));
      }
      for (const part of chunk(rows.tombstones, 500)) await tx.insert(sourceTombstone).values(part.map(r => withDates(r, ['deletedAt'])));
      // Self-references are linked after every record exists.
      for (const part of chunk(rows.records, 200)) {
        await tx.insert(record).values(part.map(r => ({
          ...withDates(r, ['recordedAt', 'effectiveAt', 'observedAt', 'rejectedAt', 'updatedAt']), supersedesRecordId: null,
        })));
      }
      for (const r of rows.records) {
        if (r.supersedesRecordId) await tx.update(record).set({ supersedesRecordId: r.supersedesRecordId }).where(eq(record.id, r.id));
      }
      for (const part of chunk(rows.versions, 200)) await tx.insert(recordVersion).values(part.map(r => withDates(r, ['changedAt'])));
      for (const part of chunk(rows.evidence, 500)) await tx.insert(recordEvidence).values(part.map(r => withDates(r, ['createdAt'])));
      for (const part of chunk(rows.approvals, 500)) await tx.insert(approval).values(part.map(r => withDates(r, ['approvedAt'])));
      for (const part of chunk(rows.auditEvents, 500)) await tx.insert(auditEvent).values(part.map(r => withDates(r, ['at'])));
      for (const part of chunk(rows.exportRuns, 500)) await tx.insert(exportRun).values(part.map(r => withDates(r, ['createdAt'])));

      // The empty bootstrap workspace is replaced by the restored one.
      await tx.delete(idempotencyKey).where(eq(idempotencyKey.workspaceId, previous));
      await tx.delete(auditEvent).where(eq(auditEvent.workspaceId, previous));
      await tx.delete(exportRun).where(eq(exportRun.workspaceId, previous));
      await tx.delete(actor).where(eq(actor.workspaceId, previous));
      await tx.delete(workspace).where(eq(workspace.id, previous));

      const owner = rows.actors.find(a => a.kind === 'person' && a.authority === 'owner' && !a.revokedAt);
      const counts = countsOf(doc);
      await tx.insert(auditEvent).values({
        id: newId(), workspaceId: target, actorId: owner?.id ?? null, action: 'workspace.restored', targetType: 'workspace', targetId: target,
        requestId: ctx.requestId, details: { backupSha256, previousWorkspaceId: previous, performedByActorId: ctx.actor.id, counts },
      });

      for (const r of rows.revisions) {
        if (r.storageKey) await this.storage.put(r.storageKey, Buffer.from(r.originalBase64, 'base64'));
      }
      return { restored: counts, workspaceId: target };
    });
    this.identity.invalidate();
    return result;
  }

  /** Empty = no sources, records, tombstones or exports, and no actors besides the bootstrap owner and system actor. */
  private async assertEmpty(tx: Exec, ctx: RequestContext) {
    const ws = ctx.workspace.id;
    const n = async (query: Promise<Array<{ n: number }>>) => Number((await query)[0]?.n ?? 0);
    const busy = await n(tx.select({ n: count() }).from(source).where(eq(source.workspaceId, ws)))
      + await n(tx.select({ n: count() }).from(record).where(eq(record.workspaceId, ws)))
      + await n(tx.select({ n: count() }).from(sourceTombstone).where(eq(sourceTombstone.workspaceId, ws)))
      + await n(tx.select({ n: count() }).from(exportRun).where(eq(exportRun.workspaceId, ws)))
      + await n(tx.select({ n: count() }).from(actor).where(and(eq(actor.workspaceId, ws), ne(actor.id, ctx.actor.id), ne(actor.kind, 'system'))));
    if (busy > 0) throw conflict('workspace_not_empty', 'Restore only goes into an empty workspace');
  }
}

export function countsOf(doc: BackupDocument): Counts {
  return {
    sources: doc.sources.length, revisions: doc.revisions.length, records: doc.records.length, approvals: doc.approvals.length,
    evidence: doc.evidence.length, versions: doc.versions.length, actors: doc.actors.length, tombstones: doc.tombstones.length,
    auditEvents: doc.auditEvents.length,
  };
}

