import { Inject, Injectable } from '@nestjs/common';
import type {
  ConfirmRecordRequest, CreateRecordRequest, EvidenceInput, ListRecordsQuery, RecordDetail, RecordSummary, RejectRecordRequest,
  SetStatusRequest, StatedRole, StatementMode, SupersedeRecordRequest, UpdateRecordRequest,
} from '@poii/contracts';
import { and, asc, desc, eq, inArray, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../../common/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { DB } from '../../common/tokens.js';
import { newId } from '../../common/util.js';
import { requireCapability } from '../../authorization/authorization.js';
import type { Db } from '../../db/client.js';
import { actor, approval, record, recordEvidence, sourceRevision } from '../../db/schema/index.js';
import type { Exec, RecordRow } from '../../db/types.js';
import { computeLocator } from '../../domain/locator.js';
import { DEFAULT_TIMES, mergeTimes, type Times } from '../../domain/times.js';
import { findSource } from '../sources/sources.repository.js';
import {
  appendVersion, changeRecord, findRecord, loadDetail, recomputeRecordAiAllowed, toSummaries,
} from './records.repository.js';

type CreateRecord = z.output<typeof CreateRecordRequest>;
type UpdateRecord = z.output<typeof UpdateRecordRequest>;
type Evidence = z.output<typeof EvidenceInput>;
type Confirm = z.output<typeof ConfirmRecordRequest>;
type Reject = z.output<typeof RejectRecordRequest>;
type SetStatus = z.output<typeof SetStatusRequest>;
type Supersede = z.output<typeof SupersedeRecordRequest>;
type ListRecords = z.output<typeof ListRecordsQuery>;

const timesOf = (row: RecordRow): Times => ({
  effectiveAt: row.effectiveAt,
  effectiveAtStatus: row.effectiveAtStatus,
  observedAt: row.observedAt,
  observedAtStatus: row.observedAtStatus,
  timeConflicts: (row.timeConflicts as Times['timeConflicts']) ?? null,
});

@Injectable()
export class RecordsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(ctx: RequestContext, input: CreateRecord, changeKind: 'create' | 'supersede' = 'create'): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    const id = await this.db.orm.transaction(async tx => {
      const attribution = await this.resolveAttribution(tx, ctx, {
        statedByActorId: input.statedByActorId ?? null, statedRole: input.statedRole, statementMode: input.statementMode,
      }, true);
      const times = mergeTimes(DEFAULT_TIMES, input, true);
      if (input.supersedesRecordId) {
        const predecessor = await findRecord(tx, ctx.workspace.id, input.supersedesRecordId);
        if (predecessor.reviewState === 'rejected') throw conflict('cannot_supersede_rejected', 'A rejected record cannot be superseded');
      }
      const evidence = [];
      for (const item of input.evidence) evidence.push(await this.buildEvidence(tx, ctx, item));
      const recordId = newId();
      const row = (await tx.insert(record).values({
        id: recordId, workspaceId: ctx.workspace.id, kind: input.kind, title: input.title, body: input.body,
        reviewState: 'candidate', lifecycleStatus: input.lifecycleStatus, ...attribution, ...times,
        supersedesRecordId: input.supersedesRecordId ?? null, aiAllowed: evidence.every(e => e.sourceAiAllowed),
        versionNo: 1, createdByActorId: ctx.actor.id,
      }).returning())[0]!;
      await tx.insert(recordEvidence).values(evidence.map(e => ({ ...e.values, recordId })));
      await appendVersion(tx, row, changeKind, ctx.actor.id, null);
      await audit(tx, ctx, changeKind === 'supersede' ? 'record.superseded' : 'record.created', 'record', recordId, {
        kind: input.kind, supersedesRecordId: input.supersedesRecordId ?? null, evidenceCount: evidence.length,
      });
      return recordId;
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  /** Attribution is not approval: validates who said it, in what role, and how it reached POII. */
  private async resolveAttribution(
    exec: Exec,
    ctx: RequestContext,
    wanted: { statedByActorId: string | null; statedRole: StatedRole; statementMode: StatementMode },
    statementModeChanged: boolean,
  ) {
    if (wanted.statementMode === 'ai_extracted' && statementModeChanged && ctx.actor.kind !== 'system') {
      throw badRequest('ai_extracted_not_allowed', 'statementMode ai_extracted is reserved for the AI-execution path');
    }
    let statedByActorId = wanted.statedByActorId;
    if (!statedByActorId && wanted.statedRole === 'owner' && ctx.actor.kind === 'person' && ctx.actor.authority === 'owner') {
      statedByActorId = ctx.actor.id;
    }
    if (statedByActorId) {
      const stated = (await exec.select().from(actor).where(and(eq(actor.id, statedByActorId), eq(actor.workspaceId, ctx.workspace.id))))[0];
      if (!stated) throw notFound('Stated-by actor');
      if (wanted.statedRole === 'assistant' && stated.kind !== 'ai_assistant') {
        throw badRequest('attribution_mismatch', 'statedRole assistant must name an ai_assistant actor');
      }
      if (wanted.statedRole === 'owner' && !(stated.kind === 'person' && stated.authority === 'owner')) {
        throw badRequest('attribution_mismatch', 'statedRole owner must name the owner');
      }
      if (stated.kind === 'ai_assistant' && wanted.statedRole !== 'assistant' && wanted.statedRole !== 'unknown') {
        throw badRequest('attribution_mismatch', 'An ai_assistant actor can only be stated in role assistant');
      }
    }
    return { statedByActorId, statedRole: wanted.statedRole, statementMode: wanted.statementMode };
  }

  private async buildEvidence(exec: Exec, ctx: RequestContext, input: Evidence) {
    const src = await findSource(exec, ctx.workspace.id, input.sourceId);
    const revision = input.revisionId
      ? (await exec.select({ id: sourceRevision.id, text: sourceRevision.contentText }).from(sourceRevision)
        .where(and(eq(sourceRevision.id, input.revisionId), eq(sourceRevision.sourceId, src.id))))[0]
      : (await exec.select({ id: sourceRevision.id, text: sourceRevision.contentText }).from(sourceRevision)
        .where(eq(sourceRevision.sourceId, src.id)).orderBy(desc(sourceRevision.revisionNo)).limit(1))[0];
    if (!revision) throw notFound('Revision');
    const locator = computeLocator(revision.text, revision.id, input.startChar, input.endChar);
    return {
      sourceAiAllowed: src.aiAllowed,
      values: {
        id: newId(), sourceId: src.id, originalSourceId: src.id, revisionId: revision.id, locator, role: input.role,
        anchorResult: 'exact' as const,
      },
    };
  }

  async list(ctx: RequestContext, query: ListRecords): Promise<RecordSummary[]> {
    requireCapability(ctx.actor, 'read');
    let idFilter;
    if (query.sourceId) {
      const ids = (await this.db.orm.selectDistinct({ id: recordEvidence.recordId }).from(recordEvidence)
        .where(or(eq(recordEvidence.sourceId, query.sourceId), eq(recordEvidence.originalSourceId, query.sourceId)))).map(r => r.id);
      if (!ids.length) return [];
      idFilter = inArray(record.id, ids);
    }
    const rows = await this.db.orm.select().from(record).where(and(
      eq(record.workspaceId, ctx.workspace.id),
      query.kind ? eq(record.kind, query.kind) : undefined,
      query.reviewState ? eq(record.reviewState, query.reviewState) : undefined,
      query.lifecycleStatus ? eq(record.lifecycleStatus, query.lifecycleStatus) : undefined,
      idFilter,
    )).orderBy(desc(record.recordedAt), desc(record.id)).limit(query.limit).offset(query.offset);
    return toSummaries(this.db.orm, rows);
  }

  async get(ctx: RequestContext, id: string): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'read');
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  /** Edits append a version. A confirmed record's content and attribution are immutable: supersede instead. */
  async update(ctx: RequestContext, id: string, input: UpdateRecord): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      const changed = <K extends keyof RecordRow>(key: K, value: RecordRow[K] | undefined) => value !== undefined && value !== row[key];
      const contentChanged = changed('title', input.title) || changed('body', input.body) || changed('kind', input.kind)
        || changed('statedByActorId', input.statedByActorId) || changed('statedRole', input.statedRole)
        || changed('statementMode', input.statementMode);
      if (row.reviewState === 'confirmed') {
        requireCapability(ctx.actor, 'confirm');
        if (contentChanged) {
          throw conflict('confirmed_record_immutable', 'A confirmed record\'s title, body, kind and attribution cannot change; supersede it instead');
        }
      }
      const patch: Partial<typeof record.$inferInsert> = {};
      if (changed('title', input.title)) patch.title = input.title!;
      if (changed('body', input.body)) patch.body = input.body!;
      if (changed('kind', input.kind)) patch.kind = input.kind!;
      if (changed('statedByActorId', input.statedByActorId) || changed('statedRole', input.statedRole) || changed('statementMode', input.statementMode)) {
        const attribution = await this.resolveAttribution(tx, ctx, {
          statedByActorId: input.statedByActorId !== undefined ? input.statedByActorId : row.statedByActorId,
          statedRole: input.statedRole ?? row.statedRole,
          statementMode: input.statementMode ?? row.statementMode,
        }, changed('statementMode', input.statementMode));
        Object.assign(patch, attribution);
      }
      const statusOnly = !Object.keys(patch).length;
      if (changed('lifecycleStatus', input.lifecycleStatus)) patch.lifecycleStatus = input.lifecycleStatus!;
      const before = timesOf(row);
      const times = mergeTimes(before, input);
      if (JSON.stringify(times) !== JSON.stringify(before)) Object.assign(patch, times);
      if (!Object.keys(patch).length) return;
      await changeRecord(tx, id, patch, statusOnly ? 'status' : 'edit', ctx.actor.id, input.note ?? null);
      await audit(tx, ctx, 'record.updated', 'record', id, { fields: Object.keys(patch) });
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  async addEvidence(ctx: RequestContext, id: string, input: Evidence): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      if (row.reviewState === 'confirmed') requireCapability(ctx.actor, 'confirm');
      const evidence = await this.buildEvidence(tx, ctx, input);
      await tx.insert(recordEvidence).values({ ...evidence.values, recordId: id });
      await recomputeRecordAiAllowed(tx, [id]);
      await changeRecord(tx, id, {}, 'evidence', ctx.actor.id, `Evidence ${evidence.values.id} added`);
      await audit(tx, ctx, 'record.evidence_added', 'record', id, { evidenceId: evidence.values.id, sourceId: input.sourceId });
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  async removeEvidence(ctx: RequestContext, id: string, evidenceId: string): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      if (row.reviewState === 'confirmed') requireCapability(ctx.actor, 'confirm');
      const all = await tx.select({ id: recordEvidence.id }).from(recordEvidence).where(eq(recordEvidence.recordId, id));
      if (!all.some(e => e.id === evidenceId)) throw notFound('Evidence');
      if (all.length <= 1) throw conflict('last_evidence', 'A record keeps at least one evidence row');
      await tx.delete(recordEvidence).where(eq(recordEvidence.id, evidenceId));
      await recomputeRecordAiAllowed(tx, [id]);
      await changeRecord(tx, id, {}, 'evidence', ctx.actor.id, `Evidence ${evidenceId} removed`);
      await audit(tx, ctx, 'record.evidence_removed', 'record', id, { evidenceId });
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  /** The only way a record becomes confirmed: an approval by a person with authority, naming the antecedent. */
  async confirm(ctx: RequestContext, id: string, input: Confirm): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'confirm');
    const authority = ctx.actor.authority;
    if (ctx.actor.kind !== 'person' || !authority) throw new AppError(403, 'authority_required', 'Only a person with authority can confirm');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      if (row.reviewState === 'rejected') throw conflict('record_rejected', 'A rejected record cannot be confirmed');
      if (row.reviewState === 'confirmed') throw conflict('already_confirmed', 'The record is already confirmed');
      const antecedentRecordId = input.antecedentRecordId ?? row.supersedesRecordId ?? null;
      if (antecedentRecordId) {
        if (antecedentRecordId === id) throw badRequest('invalid_antecedent', 'A record cannot replace itself');
        await findRecord(tx, ctx.workspace.id, antecedentRecordId);
      }
      const approvalId = newId();
      await tx.insert(approval).values({
        id: approvalId, recordId: id, approvedByActorId: ctx.actor.id, authority, antecedentRecordId, note: input.note ?? null,
      });
      await changeRecord(tx, id, { reviewState: 'confirmed' }, 'confirm', ctx.actor.id, input.note ?? null);
      await audit(tx, ctx, 'record.confirmed', 'record', id, { approvalId, authority, antecedentRecordId });
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  async reject(ctx: RequestContext, id: string, input: Reject): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'confirm');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      if (row.reviewState === 'rejected') throw conflict('already_rejected', 'The record is already rejected');
      if (row.reviewState === 'confirmed') throw conflict('already_confirmed', 'A confirmed record cannot be rejected; supersede it instead');
      await changeRecord(tx, id, { reviewState: 'rejected', rejectedAt: new Date(), rejectionReason: input.reason }, 'reject', ctx.actor.id, input.reason);
      await audit(tx, ctx, 'record.rejected', 'record', id, { reason: input.reason });
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  async setStatus(ctx: RequestContext, id: string, input: SetStatus): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      if (row.reviewState === 'confirmed') requireCapability(ctx.actor, 'confirm');
      const times = mergeTimes(timesOf(row), { observedAt: input.observedAt, observedAtStatus: input.observedAtStatus });
      await changeRecord(tx, id, {
        lifecycleStatus: input.lifecycleStatus, observedAt: times.observedAt, observedAtStatus: times.observedAtStatus,
      }, 'status', ctx.actor.id, input.note ?? null);
      await audit(tx, ctx, 'record.status_set', 'record', id, {
        from: row.lifecycleStatus, to: input.lifecycleStatus, observedAtStatus: times.observedAtStatus,
      });
    });
    return loadDetail(this.db.orm, ctx.workspace.id, id);
  }

  /** A new candidate that replaces :id once confirmed. The old record is unaffected until then. */
  async supersede(ctx: RequestContext, id: string, input: Supersede): Promise<RecordDetail> {
    requireCapability(ctx.actor, 'propose');
    return this.create(ctx, { ...input, supersedesRecordId: id }, 'supersede');
  }

  async remove(ctx: RequestContext, id: string): Promise<void> {
    requireCapability(ctx.actor, 'delete');
    await this.db.orm.transaction(async tx => {
      const row = await findRecord(tx, ctx.workspace.id, id, true);
      const confirmedSuccessors = await tx.select({ id: record.id }).from(record)
        .where(and(eq(record.supersedesRecordId, id), eq(record.reviewState, 'confirmed')));
      const citingApprovals = await tx.select({ id: approval.id, recordId: approval.recordId }).from(approval)
        .where(and(eq(approval.antecedentRecordId, id), ne(approval.recordId, id)));
      if (confirmedSuccessors.length || citingApprovals.length) {
        throw conflict('record_has_confirmed_successor', 'A confirmed successor cites this record; it cannot be deleted', {
          successorIds: [...new Set([...confirmedSuccessors.map(r => r.id), ...citingApprovals.map(a => a.recordId)])],
        });
      }
      const pendingSuccessors = await tx.select({ id: record.id }).from(record).where(eq(record.supersedesRecordId, id))
        .orderBy(asc(record.recordedAt));
      for (const successor of pendingSuccessors) {
        await changeRecord(tx, successor.id, { supersedesRecordId: null }, 'edit', ctx.actor.id, `Predecessor ${id} was deleted`);
      }
      await tx.delete(record).where(eq(record.id, id));
      await audit(tx, ctx, 'record.deleted', 'record', id, {
        kind: row.kind, reviewState: row.reviewState, detachedSuccessorIds: pendingSuccessors.map(s => s.id),
      });
    });
  }

}
