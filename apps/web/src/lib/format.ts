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
        const when = c.value ? formatTime(c.value) : 'no value';
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

/** Parses "one value per line": `2026-03-04 16:02 note…` or `2026-03-04 note…`. Bad lines are reported. */
export function parseConflictLines(text: string | null | undefined): { conflicts: TimeConflictValue[]; invalid: string[] } {
  const conflicts: TimeConflictValue[] = [];
  const invalid: string[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?)\s*(?:[-–—:|]\s*)?(.*)$/.exec(line);
    const iso = match ? isoFromInput(match[1]) : null;
    if (!match || !iso) {
      invalid.push(line);
      continue;
    }
    const note = (match[2] ?? '').trim();
    conflicts.push(note ? { value: iso, note: note.slice(0, 500) } : { value: iso });
  }
  return { conflicts, invalid };
}

/** Inverse of parseConflictLines, for prefilling a textarea. */
export function conflictLines(conflicts: TimeConflictValue[] | null | undefined): string {
  return (conflicts ?? [])
    .map(c => [c.value ? inputFromIso(c.value).replace('T', ' ') : '', c.note ?? ''].filter(Boolean).join(' '))
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
    default:
      return null;
  }
}
