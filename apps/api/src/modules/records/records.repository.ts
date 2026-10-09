// Reads that shape records into the contract views, plus the version/aiAllowed helpers shared by modules.
import type {
  ApprovalView, EvidenceView, Locator, RecordDetail, RecordSummary, ReviewState,
} from '@poii/contracts';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { notFound } from '../../common/errors.js';
import { iso, newId } from '../../common/util.js';
import {
  actor, approval, record, recordEvidence, recordVersion, source, sourceRevision,
} from '../../db/schema/index.js';
import type { Exec, RecordRow } from '../../db/types.js';

type ChangeKind = 'create' | 'edit' | 'confirm' | 'reject' | 'supersede' | 'status' | 'evidence';

export async function findRecord(exec: Exec, workspaceId: string, id: string, lock = false): Promise<RecordRow> {
  const query = exec.select().from(record).where(and(eq(record.id, id), eq(record.workspaceId, workspaceId)));
  const row = (await (lock ? query.for('update') : query))[0];
  if (!row) throw notFound('Record');
  return row;
}

async function actorNames(exec: Exec, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const rows = await exec.select({ id: actor.id, displayName: actor.displayName }).from(actor).where(inArray(actor.id, unique));
  return new Map(rows.map(r => [r.id, r.displayName]));
}

/** For each record id: the confirmed successor if any, otherwise the newest non-rejected successor. */
async function successors(exec: Exec, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await exec.select({ id: record.id, supersedes: record.supersedesRecordId, reviewState: record.reviewState })
    .from(record)
    .where(and(inArray(record.supersedesRecordId, ids), ne(record.reviewState, 'rejected')))
    .orderBy(desc(record.recordedAt), desc(record.id));
  const out = new Map<string, string>();
  for (const row of rows) {
    const key = row.supersedes!;
    if (row.reviewState === 'confirmed' && !out.has(`confirmed:${key}`)) {
      out.set(key, row.id);
      out.set(`confirmed:${key}`, row.id);
    } else if (!out.has(key)) {
      out.set(key, row.id);
    }
  }
  return out;
}

export async function toSummaries(exec: Exec, rows: RecordRow[]): Promise<RecordSummary[]> {
  const names = await actorNames(exec, rows.map(r => r.statedByActorId));
  const next = await successors(exec, rows.map(r => r.id));
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    reviewState: r.reviewState,
    lifecycleStatus: r.lifecycleStatus,
    statedRole: r.statedRole,
    statementMode: r.statementMode,
    statedByDisplayName: r.statedByActorId ? names.get(r.statedByActorId) ?? null : null,
    recordedAt: iso(r.recordedAt),
    effectiveAt: iso(r.effectiveAt),
    effectiveAtStatus: r.effectiveAtStatus,
    observedAt: iso(r.observedAt),
    observedAtStatus: r.observedAtStatus,
    supersedesRecordId: r.supersedesRecordId,
    supersededByRecordId: next.get(r.id) ?? null,
    aiAllowed: r.aiAllowed,
    versionNo: r.versionNo,
    updatedAt: iso(r.updatedAt),
  }));
}

export async function loadEvidence(exec: Exec, recordIds: string[]): Promise<Map<string, EvidenceView[]>> {
  const out = new Map<string, EvidenceView[]>();
  if (!recordIds.length) return out;
  const rows = await exec.select({
    e: recordEvidence, sourceTitle: source.title, sourceAiAllowed: source.aiAllowed, revisionNo: sourceRevision.revisionNo,
  })
    .from(recordEvidence)
    .leftJoin(source, eq(source.id, recordEvidence.sourceId))
    .leftJoin(sourceRevision, eq(sourceRevision.id, recordEvidence.revisionId))
    .where(inArray(recordEvidence.recordId, recordIds))
    .orderBy(asc(recordEvidence.createdAt), asc(recordEvidence.id));
  for (const row of rows) {
    const view: EvidenceView = {
      id: row.e.id,
      sourceId: row.e.sourceId,
      originalSourceId: row.e.originalSourceId,
      sourceTitle: row.sourceTitle ?? null,
      revisionId: row.e.revisionId,
      revisionNo: row.revisionNo ?? null,
      locator: row.e.locator as unknown as Locator,
      role: row.e.role,
      anchorResult: row.e.anchorResult,
      available: row.e.sourceId !== null,
      sourceAiAllowed: row.e.sourceId !== null ? row.sourceAiAllowed ?? null : null,
    };
    const list = out.get(row.e.recordId) ?? [];
    list.push(view);
    out.set(row.e.recordId, list);
  }
  return out;
}

export async function loadApprovals(exec: Exec, recordIds: string[]): Promise<Map<string, ApprovalView[]>> {
  const out = new Map<string, ApprovalView[]>();
  if (!recordIds.length) return out;
  const rows = await exec.select({ a: approval, name: actor.displayName })
    .from(approval).innerJoin(actor, eq(actor.id, approval.approvedByActorId))
    .where(inArray(approval.recordId, recordIds))
    .orderBy(asc(approval.approvedAt), asc(approval.id));
  for (const row of rows) {
    const list = out.get(row.a.recordId) ?? [];
    list.push({
      id: row.a.id,
      approvedByActorId: row.a.approvedByActorId,
      approvedByDisplayName: row.name,
      authority: row.a.authority,
      approvedAt: iso(row.a.approvedAt),
      antecedentRecordId: row.a.antecedentRecordId,
      note: row.a.note,
    });
    out.set(row.a.recordId, list);
  }
  return out;
}

type Link = { id: string; title: string; reviewState: ReviewState };

/** Confirmed successors, nearest first. */
async function confirmedSuccessorChain(exec: Exec, id: string): Promise<Link[]> {
  const chain: Link[] = [];
  const seen = new Set([id]);
  let current = id;
  for (;;) {
    const next = (await exec.select({ id: record.id, title: record.title, reviewState: record.reviewState }).from(record)
      .where(and(eq(record.supersedesRecordId, current), eq(record.reviewState, 'confirmed')))
      .orderBy(desc(record.recordedAt), desc(record.id)).limit(1))[0];
    if (!next || seen.has(next.id)) return chain;
    chain.push(next);
    seen.add(next.id);
    current = next.id;
  }
}

export async function loadDetail(exec: Exec, workspaceId: string, id: string): Promise<RecordDetail> {
  const row = await findRecord(exec, workspaceId, id);
  const [summary] = await toSummaries(exec, [row]);
  const evidence = (await loadEvidence(exec, [id])).get(id) ?? [];
  const approvals = (await loadApprovals(exec, [id])).get(id) ?? [];
  const versionRows = await exec.select({ v: recordVersion, name: actor.displayName })
    .from(recordVersion).innerJoin(actor, eq(actor.id, recordVersion.changedByActorId))
    .where(eq(recordVersion.recordId, id)).orderBy(asc(recordVersion.versionNo));
  const predecessor = row.supersedesRecordId
    ? (await exec.select({ id: record.id, title: record.title, reviewState: record.reviewState }).from(record)
      .where(eq(record.id, row.supersedesRecordId)))[0] ?? null
    : null;
  return {
    ...summary!,
    body: row.body,
    statedByActorId: row.statedByActorId,
    timeConflicts: (row.timeConflicts as RecordDetail['timeConflicts']) ?? null,
    rejectedAt: iso(row.rejectedAt),
    rejectionReason: row.rejectionReason,
    origin: row.origin ?? null,
    evidence,
    approvals,
    versions: versionRows.map(v => ({
      versionNo: v.v.versionNo,
      changeKind: v.v.changeKind,
      changedByActorId: v.v.changedByActorId,
      changedByDisplayName: v.name,
      changedAt: iso(v.v.changedAt),
      note: v.v.note,
      snapshot: v.v.snapshot,
    })),
    supersededBy: row.reviewState === 'confirmed' ? await confirmedSuccessorChain(exec, id) : [],
    supersedes: predecessor,
  };
}

/** A full snapshot of the record and its evidence, stored with every version. */
export async function snapshotOf(exec: Exec, row: RecordRow): Promise<Record<string, unknown>> {
  const evidence = await exec.select().from(recordEvidence).where(eq(recordEvidence.recordId, row.id))
    .orderBy(asc(recordEvidence.createdAt), asc(recordEvidence.id));
  const { searchVector: _searchVector, ...fields } = row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = value instanceof Date ? value.toISOString() : value;
  out.evidence = evidence.map(e => {
    const locator = e.locator as unknown as Locator;
    return {
      id: e.id, sourceId: e.sourceId, originalSourceId: e.originalSourceId, revisionId: e.revisionId, role: e.role,
      anchorResult: e.anchorResult, startChar: locator.startChar, endChar: locator.endChar, excerptSha256: locator.excerptSha256,
    };
  });
  return out;
}

/** Applies a change to a record, bumps its version and appends the version snapshot. */
export async function changeRecord(
  exec: Exec,
  id: string,
  patch: Partial<typeof record.$inferInsert>,
  changeKind: ChangeKind,
  actorId: string,
  note: string | null = null,
): Promise<RecordRow> {
  const updated = (await exec.update(record)
    .set({ ...patch, versionNo: sql`${record.versionNo} + 1`, updatedAt: new Date() })
    .where(eq(record.id, id)).returning())[0];
  if (!updated) throw notFound('Record');
  await appendVersion(exec, updated, changeKind, actorId, note);
  return updated;
}

export async function appendVersion(exec: Exec, row: RecordRow, changeKind: ChangeKind, actorId: string, note: string | null) {
  await exec.insert(recordVersion).values({
    id: newId(), recordId: row.id, versionNo: row.versionNo, changeKind, snapshot: await snapshotOf(exec, row),
    changedByActorId: actorId, note,
  });
}

/**
 * Permissions pass down: a record is AI-allowed only when every live cited source is. Evidence whose
 * source was deleted can no longer prove the source was allowed, so it never turns a record back to allowed.
 */
export async function recomputeRecordAiAllowed(exec: Exec, recordIds: string[]): Promise<void> {
  if (!recordIds.length) return;
  await exec.execute(sql`
    UPDATE record r SET ai_allowed =
      NOT EXISTS (SELECT 1 FROM record_evidence e JOIN source s ON s.id = e.source_id WHERE e.record_id = r.id AND s.ai_allowed = false)
      AND (r.ai_allowed OR NOT EXISTS (SELECT 1 FROM record_evidence e WHERE e.record_id = r.id AND e.source_id IS NULL))
    WHERE r.id IN (${sql.join(recordIds.map(id => sql`${id}::uuid`), sql`, `)})`);
}
