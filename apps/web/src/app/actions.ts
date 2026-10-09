'use server';

// Server actions: every write goes to the API over HTTP. Successful actions redirect; failures come back
// as readable problems (API error code and message) for the form to show.
import { redirect } from 'next/navigation';
import type {
  ActorView,
  ContextPackResponse,
  CreateRecordRequest,
  EvidenceInput,
  RecordDetail,
  SourceView,
  UpdateRecordRequest,
} from '@poii/contracts';
import { lifecycleStatuses, recordKinds, reviewStates, statedRoles, statementModes, timeStatuses } from '@poii/contracts';
import type { ActionState } from '@/lib/action-state';
import { apiJson, toProblem, type Problem } from '@/lib/api';
import { isoFromInput, parseConflictLines, type TimeConflictValue } from '@/lib/format';
import { guessMediaType, looksBinary } from '@/lib/upload';

class InputProblem extends Error {
  constructor(message: string) {
    super(message);
  }
}

const fail = (problem: Problem): ActionState => ({ ok: false, problem });
const invalid = (message: string): ActionState => fail({ code: 'invalid_input', message });
const failure = (error: unknown): ActionState =>
  error instanceof InputProblem ? invalid(error.message) : fail(toProblem(error));

const text = (fd: FormData, name: string): string => {
  const value = fd.get(name);
  return typeof value === 'string' ? value : '';
};
const trimmed = (fd: FormData, name: string) => text(fd, name).trim();

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InputProblem(`Choose a valid ${label}.`);
}

function allOf<T extends string>(fd: FormData, name: string, allowed: readonly T[]): T[] {
  return fd
    .getAll(name)
    .filter((v): v is string => typeof v === 'string')
    .filter((v): v is T => (allowed as readonly string[]).includes(v));
}

function int(fd: FormData, name: string, label: string): number {
  const raw = trimmed(fd, name);
  if (!/^\d+$/.test(raw)) throw new InputProblem(`${label} must be a whole number.`);
  return Number(raw);
}

async function readUpload(fd: FormData, name: string): Promise<{ content: string; fileName: string; mediaType: string } | null> {
  const file = fd.get(name);
  if (!file || typeof file === 'string' || file.size === 0) return null;
  const content = await file.text();
  if (looksBinary(content)) throw new InputProblem('Only text or Markdown files can be imported.');
  return { content, fileName: file.name, mediaType: guessMediaType(file.name, file.type) };
}

// ----- actors -----------------------------------------------------------------------------------

/** Resolves the stated-by actor: an existing id, none, or a person/assistant added inline. */
async function statedByFrom(fd: FormData): Promise<string | null | undefined> {
  const newName = trimmed(fd, 'newActorName');
  if (newName) {
    const kind = oneOf(trimmed(fd, 'newActorKind') || 'person', ['person', 'ai_assistant'] as const, 'actor kind');
    const actor = await apiJson<ActorView>('/v1/actors', { method: 'POST', body: { kind, displayName: newName, details: {} } });
    return actor.id;
  }
  if (!fd.has('statedByActorId')) return undefined;
  const id = trimmed(fd, 'statedByActorId');
  return id ? id : null;
}

// ----- times ------------------------------------------------------------------------------------

type TimeFields = Pick<
  UpdateRecordRequest,
  'effectiveAt' | 'effectiveAtStatus' | 'observedAt' | 'observedAtStatus' | 'timeConflicts'
>;

function timeField(fd: FormData, field: 'effective' | 'observed', conflicts: TimeConflictValue[]) {
  const statusName = `${field}AtStatus`;
  if (!fd.has(statusName)) return undefined;
  const status = oneOf(trimmed(fd, statusName), timeStatuses, `${field} time status`);
  const label = field === 'effective' ? 'Effective time' : 'Observed time';
  if (status === 'known') {
    const iso = isoFromInput(trimmed(fd, `${field}At`));
    if (!iso) throw new InputProblem(`${label} is marked known: enter a date (UTC), or choose unknown.`);
    return { at: iso, status };
  }
  if (status === 'conflicting') {
    const parsed = parseConflictLines(text(fd, `${field}Conflicts`));
    if (parsed.invalid.length) throw new InputProblem(`${label}: could not read "${parsed.invalid[0]}". Use one "YYYY-MM-DD HH:MM note" per line.`);
    if (parsed.conflicts.length < 2) throw new InputProblem(`${label} is marked conflicting: list at least two competing values, one per line.`);
    for (const c of parsed.conflicts) conflicts.push({ ...c, note: c.note ? `${field}: ${c.note}` : field });
    return { at: null, status };
  }
  return { at: null, status };
}

function timesFrom(fd: FormData): TimeFields {
  const conflicts: TimeConflictValue[] = [];
  const out: TimeFields = {};
  const effective = timeField(fd, 'effective', conflicts);
  const observed = timeField(fd, 'observed', conflicts);
  if (effective) {
    out.effectiveAt = effective.at;
    out.effectiveAtStatus = effective.status;
  }
  if (observed) {
    out.observedAt = observed.at;
    out.observedAtStatus = observed.status;
  }
  if (effective || observed) out.timeConflicts = conflicts.length ? conflicts : null;
  return out;
}

// ----- sources ----------------------------------------------------------------------------------

export async function createSourceAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  let source: SourceView;
  try {
    const upload = await readUpload(fd, 'file');
    // A textarea cannot carry the clipboard's original line endings (browsers submit CRLF), so pasted text is
    // stored with LF. Uploaded files are stored byte-for-byte as read.
    const pasted = text(fd, 'content').replace(/\r\n?/g, '\n');
    const content = upload?.content ?? pasted;
    if (!content.trim()) throw new InputProblem('Paste some text or choose a file.');
    const title = trimmed(fd, 'title') || upload?.fileName || '';
    if (!title) throw new InputProblem('Give the source a title.');
    const origin: Record<string, string> = {};
    for (const key of ['platform', 'url', 'conversationId'] as const) {
      const value = trimmed(fd, key);
      if (value) origin[key] = value;
    }
    source = await apiJson<SourceView>('/v1/sources', {
      method: 'POST',
      body: {
        title,
        kind: upload ? 'upload' : 'paste',
        content,
        mediaType: upload?.mediaType ?? (trimmed(fd, 'mediaType') || 'text/markdown'),
        ...(upload ? { fileName: upload.fileName } : {}),
        origin,
        aiAllowed: fd.get('neverSendToAi') !== 'on',
      },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/sources/${source.id}?notice=${source.deduplicated ? 'deduplicated' : 'created'}`);
}

export async function addRevisionAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'sourceId');
  try {
    const upload = await readUpload(fd, 'file');
    const content = upload?.content ?? text(fd, 'content').replace(/\r\n?/g, '\n');
    if (!content.trim()) throw new InputProblem('Paste the new content or choose a file.');
    const note = trimmed(fd, 'note');
    await apiJson(`/v1/sources/${id}/revisions`, { method: 'POST', body: { content, ...(note ? { note } : {}) } });
  } catch (error) {
    return failure(error);
  }
  redirect(`/sources/${id}?notice=revision`);
}

export async function updateSourceAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'sourceId');
  const body: Record<string, unknown> = {};
  if (fd.has('aiAllowed')) body.aiAllowed = trimmed(fd, 'aiAllowed') === 'true';
  if (fd.has('archived')) body.archived = trimmed(fd, 'archived') === 'true';
  if (fd.has('title')) body.title = trimmed(fd, 'title');
  try {
    await apiJson(`/v1/sources/${id}`, { method: 'PATCH', body });
  } catch (error) {
    return failure(error);
  }
  redirect(`/sources/${id}?notice=updated`);
}

export async function deleteSourceAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'sourceId');
  if (fd.get('confirmDelete') !== 'on') return invalid('Tick the box to confirm the deletion.');
  try {
    const reason = trimmed(fd, 'reason');
    await apiJson(`/v1/sources/${id}`, { method: 'DELETE', body: reason ? { reason } : {} });
  } catch (error) {
    return failure(error);
  }
  redirect('/sources?notice=deleted');
}

// ----- records ----------------------------------------------------------------------------------

function evidenceFrom(fd: FormData): EvidenceInput[] {
  const evidence: EvidenceInput[] = [];
  // Kept evidence on the supersede form: "sourceId|revisionId|start|end|role".
  for (const value of fd.getAll('keepEvidence')) {
    if (typeof value !== 'string') continue;
    const [sourceId, revisionId, start, end, role] = value.split('|');
    if (!sourceId || !start || !end) continue;
    evidence.push({
      sourceId,
      ...(revisionId ? { revisionId } : {}),
      startChar: Number(start),
      endChar: Number(end),
      role: role === 'supporting' ? 'supporting' : 'primary',
    });
  }
  // A span picked on the source page (or typed in).
  const sourceId = trimmed(fd, 'sourceId');
  if (sourceId && (trimmed(fd, 'startChar') || trimmed(fd, 'endChar'))) {
    const startChar = int(fd, 'startChar', 'Start offset');
    const endChar = int(fd, 'endChar', 'End offset');
    if (endChar <= startChar) throw new InputProblem('Select a span first: the end offset must be after the start offset.');
    const revisionId = trimmed(fd, 'revisionId');
    evidence.push({
      sourceId,
      ...(revisionId ? { revisionId } : {}),
      startChar,
      endChar,
      role: trimmed(fd, 'evidenceRole') === 'supporting' ? 'supporting' : 'primary',
    });
  }
  if (!evidence.length) throw new InputProblem('A record needs at least one cited source span.');
  return evidence;
}

async function recordFieldsFrom(fd: FormData): Promise<Omit<CreateRecordRequest, 'evidence' | 'supersedesRecordId'>> {
  const title = trimmed(fd, 'title');
  if (!title) throw new InputProblem('Give the record a title.');
  const statementMode = oneOf(trimmed(fd, 'statementMode'), statementModes, 'statement mode');
  if (statementMode === 'ai_extracted') throw new InputProblem('"AI extracted" is reserved for AI output; choose quoted, pasted or paraphrased.');
  const statedBy = await statedByFrom(fd);
  return {
    kind: oneOf(trimmed(fd, 'kind'), recordKinds, 'kind'),
    title,
    body: text(fd, 'body'),
    lifecycleStatus: oneOf(trimmed(fd, 'lifecycleStatus') || 'unknown', lifecycleStatuses, 'lifecycle status'),
    statedRole: oneOf(trimmed(fd, 'statedRole') || 'unknown', statedRoles, 'stated role'),
    statementMode,
    ...(statedBy !== undefined ? { statedByActorId: statedBy } : {}),
    ...timesFrom(fd),
  };
}

export async function createRecordAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  let record: RecordDetail;
  try {
    const evidence = evidenceFrom(fd);
    const fields = await recordFieldsFrom(fd);
    const supersedes = trimmed(fd, 'supersedesRecordId');
    record = await apiJson<RecordDetail>('/v1/records', {
      method: 'POST',
      body: { ...fields, evidence, ...(supersedes ? { supersedesRecordId: supersedes } : {}) },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/records/${record.id}?notice=created`);
}

export async function supersedeRecordAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const oldId = trimmed(fd, 'recordId');
  let record: RecordDetail;
  try {
    const evidence = evidenceFrom(fd);
    const fields = await recordFieldsFrom(fd);
    record = await apiJson<RecordDetail>(`/v1/records/${oldId}/supersede`, { method: 'POST', body: { ...fields, evidence } });
  } catch (error) {
    return failure(error);
  }
  redirect(`/records/${record.id}?notice=superseding`);
}

export async function updateRecordAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'recordId');
  try {
    const body: UpdateRecordRequest = { ...timesFrom(fd) };
    if (fd.has('lifecycleStatus')) body.lifecycleStatus = oneOf(trimmed(fd, 'lifecycleStatus'), lifecycleStatuses, 'lifecycle status');
    if (fd.has('title')) {
      const title = trimmed(fd, 'title');
      if (!title) throw new InputProblem('Give the record a title.');
      body.title = title;
    }
    if (fd.has('body')) body.body = text(fd, 'body');
    if (fd.has('kind')) body.kind = oneOf(trimmed(fd, 'kind'), recordKinds, 'kind');
    if (fd.has('statedRole')) body.statedRole = oneOf(trimmed(fd, 'statedRole'), statedRoles, 'stated role');
    if (fd.has('statementMode')) {
      const mode = oneOf(trimmed(fd, 'statementMode'), statementModes, 'statement mode');
      if (mode === 'ai_extracted') throw new InputProblem('"AI extracted" is reserved for AI output.');
      body.statementMode = mode;
    }
    const statedBy = await statedByFrom(fd);
    if (statedBy !== undefined) body.statedByActorId = statedBy;
    const note = trimmed(fd, 'note');
    if (note) body.note = note;
    await apiJson(`/v1/records/${id}`, { method: 'PATCH', body });
  } catch (error) {
    return failure(error);
  }
  redirect(`/records/${id}?notice=edited`);
}

export async function confirmRecordAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'recordId');
  try {
    const note = trimmed(fd, 'note');
    await apiJson(`/v1/records/${id}/confirm`, { method: 'POST', body: note ? { note } : {} });
  } catch (error) {
    return failure(error);
  }
  redirect(`/records/${id}?notice=confirmed`);
}

export async function rejectRecordAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'recordId');
  const reason = trimmed(fd, 'reason');
  if (!reason) return invalid('Say why the candidate is rejected.');
  try {
    await apiJson(`/v1/records/${id}/reject`, { method: 'POST', body: { reason } });
  } catch (error) {
    return failure(error);
  }
  redirect(`/records/${id}?notice=rejected`);
}

export async function setStatusAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'recordId');
  try {
    const lifecycleStatus = oneOf(trimmed(fd, 'lifecycleStatus'), lifecycleStatuses, 'lifecycle status');
    const observedAtStatus = oneOf(trimmed(fd, 'observedAtStatus') || 'unknown', timeStatuses, 'observed time status');
    if (observedAtStatus === 'conflicting') throw new InputProblem('Use "Edit" to record conflicting observed times.');
    let observedAt: string | null = null;
    if (observedAtStatus === 'known') {
      observedAt = isoFromInput(trimmed(fd, 'observedAt'));
      if (!observedAt) throw new InputProblem('Observed time is marked known: enter a date (UTC), or choose unknown.');
    }
    const note = trimmed(fd, 'note');
    await apiJson(`/v1/records/${id}/status`, {
      method: 'POST',
      body: { lifecycleStatus, observedAt, observedAtStatus, ...(note ? { note } : {}) },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/records/${id}?notice=status`);
}

export async function deleteRecordAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  const id = trimmed(fd, 'recordId');
  if (fd.get('confirmDelete') !== 'on') return invalid('Tick the box to confirm the deletion.');
  try {
    await apiJson(`/v1/records/${id}`, { method: 'DELETE' });
  } catch (error) {
    return failure(error);
  }
  redirect('/records?notice=deleted');
}

// ----- exports and backup -----------------------------------------------------------------------

export async function createContextPackAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  let pack: ContextPackResponse;
  try {
    const destination = oneOf(trimmed(fd, 'destination') || 'person', ['person', 'ai'] as const, 'destination');
    const kinds = allOf(fd, 'kinds', recordKinds);
    const states = allOf(fd, 'reviewStates', reviewStates);
    const statuses = allOf(fd, 'lifecycleStatuses', lifecycleStatuses);
    const title = trimmed(fd, 'title');
    pack = await apiJson<ContextPackResponse>('/v1/exports/context-pack', {
      method: 'POST',
      body: {
        destination,
        ...(kinds.length ? { kinds } : {}),
        reviewStates: states.length ? states : ['confirmed'],
        ...(statuses.length ? { lifecycleStatuses: statuses } : {}),
        includeExcerpts: fd.get('includeExcerpts') === 'on',
        ...(title ? { title } : {}),
      },
    });
  } catch (error) {
    return failure(error);
  }
  redirect(`/export?run=${pack.exportRunId}`);
}

type RestoreResult = { restored: Record<string, number>; workspaceId: string };

export async function restoreAction(_state: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const upload = await readUpload(fd, 'backup');
    if (!upload) throw new InputProblem('Choose a backup JSON file.');
    let backup: unknown;
    try {
      backup = JSON.parse(upload.content);
    } catch {
      throw new InputProblem('That file is not valid JSON. Choose a file downloaded from "Download backup".');
    }
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new InputProblem('That file is not a POII backup.');
    const result = await apiJson<RestoreResult>('/v1/restore', { method: 'POST', body: { backup } });
    const parts = Object.entries(result.restored).map(([key, n]) => `${n} ${key}`);
    return { ok: true, message: `Restore finished into workspace ${result.workspaceId}: ${parts.join(', ')}.` };
  } catch (error) {
    return failure(error);
  }
}
