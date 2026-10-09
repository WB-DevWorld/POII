import type { RevisionMeta, SourceView } from '@poii/contracts';
import { and, asc, count, countDistinct, desc, eq, inArray } from 'drizzle-orm';
import { notFound } from '../../common/errors.js';
import { iso } from '../../common/util.js';
import { recordEvidence, source, sourceRevision } from '../../db/schema/index.js';
import type { Exec, SourceRow } from '../../db/types.js';

export const revisionMetaColumns = {
  id: sourceRevision.id,
  sourceId: sourceRevision.sourceId,
  revisionNo: sourceRevision.revisionNo,
  contentSha256: sourceRevision.contentSha256,
  byteLength: sourceRevision.byteLength,
  lineCount: sourceRevision.lineCount,
  note: sourceRevision.note,
  createdAt: sourceRevision.createdAt,
  createdByActorId: sourceRevision.createdByActorId,
  storageKey: sourceRevision.storageKey,
};

type MetaRow = { id: string; revisionNo: number; contentSha256: string; byteLength: number; lineCount: number; note: string | null; createdAt: Date; createdByActorId: string };

export function toRevisionMeta(row: MetaRow): RevisionMeta {
  return {
    id: row.id,
    revisionNo: row.revisionNo,
    contentSha256: row.contentSha256,
    byteLength: row.byteLength,
    lineCount: row.lineCount,
    note: row.note,
    createdAt: iso(row.createdAt),
    createdByActorId: row.createdByActorId,
  };
}

export async function findSource(exec: Exec, workspaceId: string, id: string, lock = false): Promise<SourceRow> {
  const query = exec.select().from(source).where(and(eq(source.id, id), eq(source.workspaceId, workspaceId)));
  const row = (await (lock ? query.for('update') : query))[0];
  if (!row) throw notFound('Source');
  return row;
}

export async function revisionsOf(exec: Exec, sourceId: string) {
  return exec.select(revisionMetaColumns).from(sourceRevision).where(eq(sourceRevision.sourceId, sourceId)).orderBy(asc(sourceRevision.revisionNo));
}

export async function toSourceViews(exec: Exec, rows: SourceRow[]): Promise<SourceView[]> {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const current = await exec.selectDistinctOn([sourceRevision.sourceId], revisionMetaColumns).from(sourceRevision)
    .where(inArray(sourceRevision.sourceId, ids)).orderBy(sourceRevision.sourceId, desc(sourceRevision.revisionNo));
  const counts = await exec.select({ sourceId: sourceRevision.sourceId, n: count() }).from(sourceRevision)
    .where(inArray(sourceRevision.sourceId, ids)).groupBy(sourceRevision.sourceId);
  const records = await exec.select({ sourceId: recordEvidence.sourceId, n: countDistinct(recordEvidence.recordId) }).from(recordEvidence)
    .where(inArray(recordEvidence.sourceId, ids)).groupBy(recordEvidence.sourceId);
  const currentBy = new Map(current.map(r => [r.sourceId, r]));
  const countBy = new Map(counts.map(r => [r.sourceId, Number(r.n)]));
  const recordsBy = new Map(records.map(r => [r.sourceId!, Number(r.n)]));
  return rows.map(r => {
    const rev = currentBy.get(r.id);
    if (!rev) throw new Error(`Source ${r.id} has no revision`);
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      mediaType: r.mediaType,
      origin: r.origin,
      originKey: r.originKey,
      aiAllowed: r.aiAllowed,
      archivedAt: iso(r.archivedAt),
      createdAt: iso(r.createdAt),
      createdByActorId: r.createdByActorId,
      currentRevision: toRevisionMeta(rev),
      revisionCount: countBy.get(r.id) ?? 1,
      recordCount: recordsBy.get(r.id) ?? 0,
    };
  });
}
