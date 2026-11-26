// Pure presentation helpers. Times are shown and entered in UTC so server rendering is unambiguous.

export type TimeStatusValue = 'known' | 'unknown' | 'not_applicable' | 'conflicting';
export type TimeConflictValue = { value: string | null; sourceId?: string; note?: string };

/** "2026-03-04 16:02 UTC", or an empty string for null. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export type TimeDisplay = { text: string; tone: 'known' | 'unknown' | 'na' | 'conflicting'; conflicts: string[] };

/** Renders a record time with its status. Unknown and conflicting are always explicit. */
export function describeTime(
  value: string | null | undefined,
  status: TimeStatusValue | string | null | undefined,
  conflicts: TimeConflictValue[] | null | undefined = null,
): TimeDisplay {
  switch (status) {
    case 'known':
      return value
        ? { text: formatTime(value), tone: 'known', conflicts: [] }
        : { text: 'known, but no value recorded', tone: 'unknown', conflicts: [] };
    case 'not_applicable':
      return { text: 'not applicable', tone: 'na', conflicts: [] };
    case 'conflicting': {
      const list = (conflicts ?? []).map(c => {
        const when = c.value ? formatTime(c.value) : NO_DATE;
        return c.note ? `${when} (${c.note})` : when;
      });
      if (value && list.length === 0) list.push(formatTime(value));
      return { text: 'conflicting', tone: 'conflicting', conflicts: list };
    }
    default:
      return { text: 'unknown', tone: 'unknown', conflicts: [] };
  }
}

/** A `datetime-local` (or date) input value, read as UTC, to an ISO time with offset. Null when empty or invalid. */
export function isoFromInput(input: string | null | undefined): string | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d) || date.getUTCMonth() !== Number(mo) - 1) return null;
  return date.toISOString();
}

/** An ISO time to a `datetime-local` value in UTC ("2026-03-04T16:02"). */
export function inputFromIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

/** How a competing value without a date is written and shown: "no date catalogue page". */
export const NO_DATE = 'no date';
const UNDATED_LINE = /^(?:no date|undated)\b\s*(?:[-–—:|]\s*)?(.*)$/i;
const DATED_LINE = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?)\s*(?:[-–—:|]\s*)?(.*)$/;
/** "[2]" at the end of a line: the second of the sources listed under the box. */
const SOURCE_REF = /\s*\[(\d{1,3})\]$/;

/** A source a competing value can be said to come from. The title is null when the record does not cite it. */
export type ConflictSource = { id: string; title: string | null };

/**
 * The sources a form offers for competing values, in the order their numbers are shown: the sources the record
 * cites, then any other source a stored value already names (so that it stays visible and can be removed).
 */
export function conflictSourceList(cited: ConflictSource[], conflicts: TimeConflictValue[] | null | undefined): ConflictSource[] {
  const list: ConflictSource[] = [];
  for (const source of cited) if (!list.some(s => s.id === source.id)) list.push(source);
  for (const c of conflicts ?? []) if (c.sourceId && !list.some(s => s.id === c.sourceId)) list.push({ id: c.sourceId, title: null });
  return list;
}

export type ConflictLines = {
  conflicts: TimeConflictValue[];
  /** Lines that are neither a date nor "no date". */
  invalid: string[];
  /** Lines whose `[n]` is not one of the offered sources. */
  unknownSource: string[];
};

/**
 * Parses "one value per line": `2026-03-04 16:02 note…`, `2026-03-04 note…`, or `no date note…` (also
 * `undated note…`) for a competing value whose source carries no date. When `sourceIds` are offered, a line may
 * end with `[n]` to name the n-th of them as the source of that value. Bad lines are reported.
 */
export function parseConflictLines(text: string | null | undefined, sourceIds: readonly string[] = []): ConflictLines {
  const conflicts: TimeConflictValue[] = [];
  const invalid: string[] = [];
  const unknownSource: string[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let rest = line;
    let sourceId: string | undefined;
    const ref = sourceIds.length ? SOURCE_REF.exec(line) : null;
    if (ref) {
      sourceId = sourceIds[Number(ref[1]) - 1];
      if (!sourceId) {
        unknownSource.push(line);
        continue;
      }
      rest = line.slice(0, ref.index).trim();
    }
    const undated = UNDATED_LINE.exec(rest);
    const dated = undated ? null : DATED_LINE.exec(rest);
    const value = undated ? null : dated ? isoFromInput(dated[1]) : undefined;
    if (value === undefined || (dated && !value)) {
      invalid.push(line);
      continue;
    }
    const note = ((undated ?? dated)?.[undated ? 1 : 2] ?? '').trim();
    conflicts.push({ value, ...(sourceId ? { sourceId } : {}), ...(note ? { note: note.slice(0, 500) } : {}) });
  }
  return { conflicts, invalid, unknownSource };
}

/** Inverse of parseConflictLines, for prefilling a textarea. */
export function conflictLines(conflicts: TimeConflictValue[] | null | undefined, sourceIds: readonly string[] = []): string {
  return (conflicts ?? [])
    .map(c => {
      const at = c.sourceId ? sourceIds.indexOf(c.sourceId) : -1;
      return [c.value ? inputFromIso(c.value).replace('T', ' ') : NO_DATE, c.note ?? '', at >= 0 ? `[${at + 1}]` : ''].filter(Boolean).join(' ');
    })
    .join('\n');
}

/**
 * The contract keeps one `timeConflicts` list per record. The web app tags each value's note with the field
 * it belongs to ("effective: …" / "observed: …"); untagged values are shown under every conflicting field.
 */
export function conflictsFor(field: 'effective' | 'observed', conflicts: TimeConflictValue[] | null | undefined): TimeConflictValue[] {
  const all = conflicts ?? [];
  const tag = (c: TimeConflictValue) => /^(effective|observed)\b:?\s*/.exec(c.note ?? '')?.[1];
  return all
    .filter(c => {
      const t = tag(c);
      return !t || t === field;
    })
    .map(c => {
      const note = (c.note ?? '').replace(/^(effective|observed)\b:?\s*/, '');
      const { note: _drop, ...rest } = c;
      return note ? { ...rest, note } : rest;
    });
}

/** "third_party" → "third party". */
export function humanize(value: string | null | undefined): string {
  return (value ?? '').replace(/_/g, ' ');
}

export type HeadlinePart = { text: string; hit: boolean };

/**
 * Splits a ts_headline snippet on its <b>…</b> markers. Everything else stays plain text, so markup that
 * happens to be inside a source is shown, never executed.
 */
export function headlineParts(headline: string): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  let hit = false;
  for (const piece of headline.split(/(<\/?b>)/)) {
    if (piece === '<b>') hit = true;
    else if (piece === '</b>') hit = false;
    else if (piece) parts.push({ text: piece, hit });
  }
  return parts;
}

/** Count label that is honest about a capped list. */
export function countLabel(count: number, limit: number): string {
  return count >= limit ? `${limit}+` : String(count);
}

/** Plain-words explanation for API error codes the UI meets; falls back to the API's own message. */
export function explainCode(code: string): string | null {
  switch (code) {
    case 'workspace_not_empty':
      return 'Restore only works into an empty workspace. This workspace already has data, so nothing was changed. Restore into a clean install instead.';
    case 'confirmed_record_immutable':
      return 'A confirmed record keeps its wording and attribution. Supersede it with a new candidate instead; status and times can still change.';
    case 'authority_required':
      return 'Only a person with authority can do this.';
    case 'idempotency_mismatch':
      return 'This request was already sent with different content. Reload the page and try again.';
    case 'validation_failed':
      return 'Some values did not match what POII expects:';
    case 'invalid_backup':
      return 'That file is not a POII backup this version can restore.';
    case 'attribution_mismatch':
      return 'The stated role does not fit the person chosen as "stated by". Role owner is only for the workspace owner, role assistant only for an AI assistant, and an AI assistant can only speak as assistant.';
    case 'record_has_confirmed_successor':
      return 'A confirmed successor names this record as the one it replaced, so it cannot be deleted. The history must stay intact.';
    case 'last_evidence':
      return 'A record keeps at least one cited span.';
    case 'cannot_supersede_rejected':
    case 'record_rejected':
      return 'This record was rejected, so it cannot be confirmed or superseded.';
    case 'already_confirmed':
      return 'This record is already confirmed.';
    case 'api_unreachable':
      return 'The POII API is not reachable right now. Nothing was changed.';
    case 'api_timeout':
      return 'The POII API did not answer in time. If you were making a change, check whether it was saved before you try again.';
    default:
      return null;
  }
}
