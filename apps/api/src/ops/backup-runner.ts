// The backup runner (#16): builds the poii.backup v1 document through BackupService (the same code as
// POST /v1/backup), writes it to the configured target with a latest.json pointer, keeps the newest N documents
// and records every run in ops_backup_run.
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupDocument, type RestoreResponse } from '@poii/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { newId, sha256Hex } from '../common/util.js';
import type { RequestContext } from '../common/request-context.js';
import type { Db } from '../db/client.js';
import { actor, opsBackupRun, workspace } from '../db/schema/index.js';
import { countsOf, type BackupService } from '../modules/backup/backup.service.js';
import type { BackupObject, BackupTarget } from './backup-target.js';

export const LATEST_POINTER = 'latest.json';
export const POINTER_FORMAT = 'poii.backup-pointer';

const BACKUP_NAME = /^poii-backup-([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

/** ISO 8601 time with ':' and '.' replaced by '-', so the name is valid on every filesystem and sorts by time. */
export function fileTime(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function backupObjectName(workspaceId: string, date: Date): string {
  return `poii-backup-${workspaceId}-${fileTime(date)}.json`;
}

/** The time encoded in a backup object name, or null when the name is not a backup document. */
export function parseBackupName(name: string): { workspaceId: string; time: string } | null {
  const match = BACKUP_NAME.exec(name);
  return match ? { workspaceId: match[1]!, time: match[2]! } : null;
}

/**
 * Backup documents beyond the newest `keep`, oldest first. Never touches latest.json, unrelated objects or `protect`
 * (the document this run just wrote, even if a clock skew made older-looking names sort after it).
 */
export function selectForDeletion(objects: BackupObject[], keep: number, protect?: string): string[] {
  const backups = objects
    .map(o => ({ key: o.key, parsed: parseBackupName(o.key) }))
    .filter((o): o is { key: string; parsed: { workspaceId: string; time: string } } => o.parsed !== null)
    .sort((a, b) => (a.parsed.time < b.parsed.time ? 1 : a.parsed.time > b.parsed.time ? -1 : a.key < b.key ? 1 : -1));
  return backups.slice(keep).map(o => o.key).filter(key => key !== protect).reverse();
}

export interface BackupPointer {
  format: typeof POINTER_FORMAT;
  formatVersion: 1;
  objectKey: string;
  workspaceId: string;
  generatedAt: string;
  byteLength: number;
  /** SHA-256 of the written bytes of the file (what to check a download against). */
  sha256: string;
  /** SHA-256 of canonicalJson(doc): the value in export_run.content_sha256 and the workspace.backup audit event. */
  contentSha256: string;
  backupFormat: typeof BACKUP_FORMAT;
  backupFormatVersion: typeof BACKUP_VERSION;
  /** Row counts of the document: the manifest a restore is checked against. */
  counts: RestoreResponse['restored'];
}

export interface BackupRunResult {
  runId: string;
  status: 'succeeded' | 'failed';
  objectKey: string | null;
  byteLength: number | null;
  sha256: string | null;
  pointer: BackupPointer | null;
  deleted: string[];
  /** Set when the run failed, or when the backup landed but retention could not prune. */
  error: string | null;
}

export interface RunBackupDeps {
  db: Db;
  backupService: BackupService;
  target: BackupTarget;
  keep: number;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

/**
 * The workspace a scheduled backup covers and the person it acts as: the install's only workspace (release one has
 * exactly one; anything else fails the run rather than silently picking one) and its owner. Read from the database,
 * not the identity port, so it works without a request or session.
 */
export async function backupContext(db: Db, runId: string): Promise<RequestContext> {
  const all = await db.orm.select().from(workspace).orderBy(asc(workspace.createdAt), asc(workspace.id)).limit(2);
  if (all.length === 0) throw new Error('Nothing to back up: this install has no workspace yet');
  if (all.length > 1) throw new Error('This install holds more than one workspace; the backup runner backs up exactly one and refuses to guess');
  const ws = all[0]!;
  const owner = (await db.orm.select().from(actor)
    .where(and(eq(actor.workspaceId, ws.id), eq(actor.kind, 'person'), eq(actor.authority, 'owner'), isNull(actor.revokedAt)))
    .orderBy(asc(actor.createdAt), asc(actor.id)).limit(1))[0];
  if (!owner) throw new Error(`Workspace ${ws.id} has no active owner to perform the backup`);
  return { actor: owner, workspace: { id: ws.id, name: ws.name }, requestId: `backup-run-${runId}` };
}

export async function runBackup(deps: RunBackupDeps): Promise<BackupRunResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const runId = newId();
  const startedAt = now();
  await deps.db.orm.insert(opsBackupRun).values({ id: runId, startedAt, target: deps.target.name, status: 'running' });
  log({ event: 'backup.started', runId, target: deps.target.name, location: deps.target.location });

  let objectKey: string | null = null;
  let workspaceId: string | null = null;
  let exportRunId: string | null = null;
  try {
    const ctx = await backupContext(deps.db, runId);
    workspaceId = ctx.workspace.id;
    const key = backupObjectName(ctx.workspace.id, startedAt);
    // The document goes to the target inside backup(), before its export run and audit event are committed: if the
    // upload fails nothing claims a backup happened; if the commit fails the uploaded object is removed again.
    const written: { bytes?: Buffer; contentSha256?: string } = {};
    let doc: BackupDocument;
    try {
      doc = await deps.backupService.backup(ctx, {
        via: 'backup-cli', destination: { target: deps.target.name, objectKey: key, backupRunId: runId },
        sink: async (bytes, info) => {
          await deps.target.put(key, bytes, 'application/json');
          written.bytes = bytes;
          written.contentSha256 = info.contentSha256;
        },
      });
    } catch (error) {
      if (written.bytes) await deps.target.delete(key).catch(() => undefined);
      throw error;
    }
    exportRunId = doc.exportRunId ?? null;
    const bytes = written.bytes!;
    const contentSha256 = written.contentSha256!;
    const sha256 = sha256Hex(bytes);
    objectKey = key;
    const pointer: BackupPointer = {
      format: POINTER_FORMAT, formatVersion: 1, objectKey: key, workspaceId: ctx.workspace.id, generatedAt: doc.generatedAt,
      byteLength: bytes.byteLength, sha256, contentSha256, backupFormat: BACKUP_FORMAT, backupFormatVersion: BACKUP_VERSION,
      counts: countsOf(doc),
    };
    await deps.target.put(LATEST_POINTER, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8'), 'application/json');
    log({ event: 'backup.written', runId, objectKey: key, byteLength: bytes.byteLength, sha256, counts: pointer.counts });

    let deleted: string[] = [];
    let retentionError: string | null = null;
    try {
      deleted = selectForDeletion(await deps.target.list(), deps.keep, key);
      for (const name of deleted) await deps.target.delete(name);
      if (deleted.length) log({ event: 'backup.pruned', runId, keep: deps.keep, deleted });
    } catch (error) {
      retentionError = `retention failed: ${message(error)}`;
      log({ event: 'backup.retention_failed', runId, error: retentionError });
    }
    await deps.db.orm.update(opsBackupRun).set({
      finishedAt: now(), objectKey: key, byteLength: bytes.byteLength, sha256, status: 'succeeded', error: retentionError, workspaceId, exportRunId,
    }).where(eq(opsBackupRun.id, runId));
    log({ event: 'backup.finished', runId, status: 'succeeded' });
    return { runId, status: 'succeeded', objectKey: key, byteLength: bytes.byteLength, sha256, pointer, deleted, error: retentionError };
  } catch (error) {
    const text = message(error);
    await deps.db.orm.update(opsBackupRun).set({ finishedAt: now(), status: 'failed', error: text, objectKey, workspaceId, exportRunId })
      .where(eq(opsBackupRun.id, runId))
      .catch(updateError => log({ event: 'backup.record_failed', runId, error: message(updateError) }));
    log({ event: 'backup.finished', runId, status: 'failed', error: text });
    return { runId, status: 'failed', objectKey, byteLength: null, sha256: null, pointer: null, deleted: [], error: text };
  }
}
