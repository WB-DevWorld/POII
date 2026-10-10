// #13 AI disclosure (ADR-0007, BUILD-BASELINE §4.2 and §8 item 8). The only way material reaches a prompt.
// A source with aiAllowed=false, and any record derived from one, is refused with 409 ai_not_allowed here,
// before any prompt is built and before any provider client is constructed. Enforced on the server for
// every caller, whatever the UI offers. Runs again at execute time, so a source marked never-send after
// its preview is never sent.
import { AI_CONTEXT_HEADER, WITHHELD_REASON, type RecordSummary, type WithheldRecord } from '@poii/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { AppError, badRequest, notFound } from '../common/errors.js';
import { record, recordEvidence, source, sourceRevision } from '../db/schema/index.js';
import type { Exec, SourceRow } from '../db/types.js';
import type { ContextRecord } from './prompt.js';

export const MAX_CONTEXT_RECORDS = 20;

export interface DisclosureRequest {
  workspaceId: string;
  sourceId: string;
  revisionId?: string;
  startChar?: number;
  endChar?: number;
  recordIds?: string[];
}

export interface DisclosedMaterial {
  source: SourceRow;
  revisionId: string;
  revisionText: string;
  startChar: number;
  endChar: number;
  /** revisionText.slice(startChar, endChar): the only source text that can reach a prompt. */
  documentText: string;
  recordIds: string[];
  records: Array<ContextRecord & { id: string }>;
}

/** True when `offset` falls between the two halves of a UTF-16 surrogate pair. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export const aiNotAllowed = (message: string, details: Record<string, unknown>) => new AppError(409, 'ai_not_allowed', message, details);

export async function discloseForAi(exec: Exec, input: DisclosureRequest, maxInputChars: number): Promise<DisclosedMaterial> {
  const src = (await exec.select().from(source).where(and(eq(source.id, input.sourceId), eq(source.workspaceId, input.workspaceId))))[0];
  if (!src) throw notFound('Source');
  if (!src.aiAllowed) {
    throw aiNotAllowed('This source is marked never send to AI; nothing from it is ever sent to a provider', { sourceId: src.id });
  }

  const recordIds = [...new Set(input.recordIds ?? [])];
  if (recordIds.length > MAX_CONTEXT_RECORDS) {
    throw badRequest('too_many_records', `At most ${MAX_CONTEXT_RECORDS} context records can be included`);
  }
  let records: DisclosedMaterial['records'] = [];
  if (recordIds.length) {
    const rows = await exec.select({ id: record.id, kind: record.kind, title: record.title, body: record.body, aiAllowed: record.aiAllowed })
      .from(record).where(and(eq(record.workspaceId, input.workspaceId), inArray(record.id, recordIds)));
    if (rows.length !== recordIds.length) throw notFound('Record');
    // The stored flag, and independently every live cited source (defence in depth: permissions pass down).
    const neverSend = await exec.selectDistinct({ recordId: recordEvidence.recordId }).from(recordEvidence)
      .innerJoin(source, eq(source.id, recordEvidence.sourceId))
      .where(and(inArray(recordEvidence.recordId, recordIds), eq(source.aiAllowed, false)));
    const refused = [...new Set([...rows.filter(r => !r.aiAllowed).map(r => r.id), ...neverSend.map(r => r.recordId)])];
    if (refused.length) {
      throw aiNotAllowed('A selected record is derived from a never-send-to-AI source and is never sent to a provider', { recordIds: refused });
    }
    const byId = new Map(rows.map(r => [r.id, r]));
    records = recordIds.map(id => {
      const r = byId.get(id)!;
      return { id: r.id, kind: r.kind, title: r.title, body: r.body };
    });
  }

  const revision = input.revisionId
    ? (await exec.select({ id: sourceRevision.id, text: sourceRevision.contentText }).from(sourceRevision)
      .where(and(eq(sourceRevision.id, input.revisionId), eq(sourceRevision.sourceId, src.id))))[0]
    : (await exec.select({ id: sourceRevision.id, text: sourceRevision.contentText }).from(sourceRevision)
      .where(eq(sourceRevision.sourceId, src.id)).orderBy(sourceRevision.revisionNo)).at(-1);
  if (!revision) throw notFound('Revision');

  const startChar = input.startChar ?? 0;
  const endChar = input.endChar ?? revision.text.length;
  if (!Number.isInteger(startChar) || !Number.isInteger(endChar) || startChar < 0 || endChar <= startChar || endChar > revision.text.length) {
    throw badRequest('invalid_span', `Span ${startChar}-${endChar} is outside the revision text (length ${revision.text.length}) or empty`, {
      startChar, endChar, textLength: revision.text.length,
    });
  }
  if (splitsSurrogatePair(revision.text, startChar) || splitsSurrogatePair(revision.text, endChar)) {
    throw badRequest('invalid_span', `Span ${startChar}-${endChar} splits a character (a UTF-16 surrogate pair); move the boundary by one`, {
      startChar, endChar,
    });
  }
  if (endChar - startChar > maxInputChars) {
    throw badRequest('span_too_large', `At most ${maxInputChars} characters can be sent in one AI action; choose a smaller span`, {
      maxInputChars, spanChars: endChar - startChar,
    });
  }
  if (!revision.text.slice(startChar, endChar).trim()) throw badRequest('invalid_span', 'The selected span contains only whitespace');

  return {
    source: src,
    revisionId: revision.id,
    revisionText: revision.text,
    startChar,
    endChar,
    documentText: revision.text.slice(startChar, endChar),
    recordIds,
    records,
  };
}

// #18 read-only API and MCP ----------------------------------------------------------------------------
// The same rule on the read endpoints, for a caller that is itself an AI (`X-POII-AI-Context: 1`, which the
// MCP server always sends): a never-send source answers 409 ai_not_allowed or is left out of a list, and a
// record derived from one shows its title and ids only. Without the header nothing changes.

/** Parses the X-POII-AI-Context header: `1` is an AI context, absent or `0` is not, anything else is 400. */
export function aiContextRequested(value: string | string[] | undefined): boolean {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  throw badRequest('invalid_ai_context_header', `${AI_CONTEXT_HEADER} must be 1 or 0`);
}

/** 409 ai_not_allowed for a never-send source read in AI context. */
export function assertSourceReadableByAi(src: { id: string; aiAllowed: boolean }): void {
  if (!src.aiAllowed) {
    throw aiNotAllowed('This source is marked never send to AI; an AI client never receives it', { sourceId: src.id });
  }
}

/** Of the given live sources, those marked never send to AI. */
export async function neverSendSourceIds(exec: Exec, workspaceId: string, sourceIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(sourceIds)];
  if (!ids.length) return new Set();
  const rows = await exec.select({ id: source.id }).from(source)
    .where(and(eq(source.workspaceId, workspaceId), inArray(source.id, ids), eq(source.aiAllowed, false)));
  return new Set(rows.map(r => r.id));
}

/**
 * Of the given records, those derived from never-send material: the stored flag, and independently every live
 * cited source (defence in depth, as in discloseForAi).
 */
export async function neverSendRecordIds(exec: Exec, recordIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(recordIds)];
  if (!ids.length) return new Set();
  const flagged = await exec.select({ id: record.id }).from(record).where(and(inArray(record.id, ids), eq(record.aiAllowed, false)));
  const cited = await exec.selectDistinct({ id: recordEvidence.recordId }).from(recordEvidence)
    .innerJoin(source, eq(source.id, recordEvidence.sourceId))
    .where(and(inArray(recordEvidence.recordId, ids), eq(source.aiAllowed, false)));
  return new Set([...flagged.map(r => r.id), ...cited.map(r => r.id)]);
}

/** Title and ids only. */
export function withheldRecord(r: Pick<RecordSummary, 'id' | 'kind' | 'title' | 'supersedesRecordId' | 'supersededByRecordId'>): WithheldRecord {
  return {
    id: r.id, kind: r.kind, title: r.title, supersedesRecordId: r.supersedesRecordId, supersededByRecordId: r.supersededByRecordId,
    contentWithheld: true, reason: WITHHELD_REASON,
  };
}

/** Records as an AI context may see them: never-send-derived ones replaced by their title and ids. */
export async function recordsForAi<T extends RecordSummary>(exec: Exec, records: T[]): Promise<Array<T | WithheldRecord>> {
  const withheld = await neverSendRecordIds(exec, records.map(r => r.id));
  return records.map(r => (withheld.has(r.id) ? withheldRecord(r) : r));
}

/**
 * Why a stored context pack may not go to an AI context, or null when it may: only packs built for
 * `destination: ai` qualify, and only while none of their records or included sources has become never-send since.
 */
export async function contextPackWithheldReason(
  exec: Exec,
  workspaceId: string,
  run: { kind: string; manifest: unknown },
  content?: unknown,
): Promise<string | null> {
  const manifest = (run.manifest ?? {}) as { destination?: unknown; included?: Array<{ sourceId?: unknown }> };
  if (run.kind !== 'context_pack' || manifest.destination !== 'ai') return 'not_an_ai_pack';
  const sourceIds = (manifest.included ?? []).map(s => s.sourceId).filter((id): id is string => typeof id === 'string');
  if ((await neverSendSourceIds(exec, workspaceId, sourceIds)).size) return 'source_now_never_send';
  const records = ((content as { json?: { records?: Array<{ id?: unknown }> } } | undefined)?.json?.records ?? [])
    .map(r => r.id).filter((id): id is string => typeof id === 'string');
  if ((await neverSendRecordIds(exec, records)).size) return 'record_now_never_send';
  return null;
}
// end #18 read-only API and MCP ------------------------------------------------------------------------
