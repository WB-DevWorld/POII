import { Inject, Injectable } from '@nestjs/common';
import type { CurrentDecision, WithheldCurrentDecision } from '@poii/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { RequestContext } from '../../common/request-context.js';
import { DB } from '../../common/tokens.js';
import { iso } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import { neverSendRecordIds, withheldRecord } from '../../ai/disclosure.js';
import type { Db } from '../../db/client.js';
import { approval, record } from '../../db/schema/index.js';
import type { Exec, RecordRow } from '../../db/types.js';
import { loadApprovals, loadEvidence, toSummaries } from '../records/records.repository.js';

export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function stalenessOf(observedAt: Date | null, now = new Date()): CurrentDecision['staleness'] {
  if (!observedAt) return { lastObservedAt: null, label: 'unknown' };
  return { lastObservedAt: iso(observedAt), label: now.getTime() - observedAt.getTime() <= STALE_AFTER_MS ? 'observed' : 'stale' };
}

/**
 * Confirmed records with no confirmed successor: nothing supersedes them and no confirmed record's approval
 * names them as antecedent. Derived on every call; nothing stores "current".
 */
export async function currentRecordRows(exec: Exec, workspaceId: string, kind: RecordRow['kind'] | null): Promise<RecordRow[]> {
  return exec.select().from(record).where(and(
    eq(record.workspaceId, workspaceId),
    kind ? eq(record.kind, kind) : undefined,
    eq(record.reviewState, 'confirmed'),
    sql`NOT EXISTS (SELECT 1 FROM record s WHERE s.supersedes_record_id = ${record.id} AND s.review_state = 'confirmed')`,
    sql`NOT EXISTS (SELECT 1 FROM approval a JOIN record s ON s.id = a.record_id
      WHERE a.antecedent_record_id = ${record.id} AND s.review_state = 'confirmed' AND s.id <> ${record.id})`,
  )).orderBy(desc(record.recordedAt), desc(record.id));
}

@Injectable()
export class ViewsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** `ai` (#18, X-POII-AI-Context): decisions derived from never-send sources show their title and ids only. */
  async currentDecisions(ctx: RequestContext, ai = false): Promise<Array<CurrentDecision | WithheldCurrentDecision>> {
    requireCapability(ctx.actor, 'read');
    const exec = this.db.orm;
    const rows = await currentRecordRows(exec, ctx.workspace.id, 'decision');
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const summaries = await toSummaries(exec, rows);
    const evidence = await loadEvidence(exec, ids);
    const approvals = await loadApprovals(exec, ids);
    const withheld = ai ? await neverSendRecordIds(exec, ids) : new Set<string>();
    const now = new Date();
    const out: Array<CurrentDecision | WithheldCurrentDecision> = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const recordApprovals = approvals.get(row.id) ?? [];
      const latest = recordApprovals[recordApprovals.length - 1];
      if (!latest) continue; // confirmed only through an approval; a row without one is not shown as current
      if (withheld.has(row.id)) {
        out.push({ record: withheldRecord(summaries[i]!), contentWithheld: true });
        continue;
      }
      const list = evidence.get(row.id) ?? [];
      out.push({
        record: summaries[i]!,
        approval: latest,
        replaced: await this.replacedChain(exec, ctx.workspace.id, row, latest.antecedentRecordId),
        primaryEvidence: list.find(e => e.role === 'primary') ?? list[0] ?? null,
        staleness: stalenessOf(row.observedAtStatus === 'known' ? row.observedAt : null, now),
      });
    }
    return out;
  }

  /** The records this decision replaced, nearest first (oldest last). */
  private async replacedChain(exec: Exec, workspaceId: string, row: RecordRow, antecedent: string | null) {
    const chain: CurrentDecision['replaced'] = [];
    const seen = new Set([row.id]);
    let nextId = row.supersedesRecordId ?? antecedent;
    while (nextId && !seen.has(nextId)) {
      seen.add(nextId);
      const prev = (await exec.select().from(record).where(and(eq(record.id, nextId), eq(record.workspaceId, workspaceId))))[0];
      if (!prev) break;
      const prevApproval = (await exec.select().from(approval).where(eq(approval.recordId, prev.id))
        .orderBy(desc(approval.approvedAt)).limit(1))[0];
      chain.push({ id: prev.id, title: prev.title, approvedAt: iso(prevApproval?.approvedAt ?? null) });
      nextId = prev.supersedesRecordId ?? prevApproval?.antecedentRecordId ?? null;
    }
    return chain;
  }
}


