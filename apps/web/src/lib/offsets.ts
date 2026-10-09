// Pure helpers for exact source spans. Offsets are UTF-16 code units into the raw revision text
// (the same text the API serves), never into the rendered DOM.

export type Span = { start: number; end: number };
export type LineInfo = { lineNo: number; start: number; end: number };
export type LineSegment = { start: number; text: string; highlighted: boolean };
export type SourceLine = LineInfo & { segments: LineSegment[] };

/** Splits on \r\n, \r or \n. `end` excludes the line terminator. */
export function splitLines(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  let lineNo = 1;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    if (ch === 10 || ch === 13) {
      lines.push({ lineNo: lineNo++, start, end: i });
      if (ch === 13 && content.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  lines.push({ lineNo, start, end: content.length });
  return lines;
}

/** Lines cut into segments so that a highlighted span can be wrapped in <mark> per line. */
export function renderLines(content: string, highlight: Span | null = null): SourceLine[] {
  return splitLines(content).map(line => {
    const text = content.slice(line.start, line.end);
    if (!highlight || highlight.end <= line.start || highlight.start >= line.end || highlight.start === highlight.end) {
      return { ...line, segments: text ? [{ start: line.start, text, highlighted: false }] : [] };
    }
    const from = Math.max(highlight.start, line.start);
    const to = Math.min(highlight.end, line.end);
    const segments: LineSegment[] = [];
    if (from > line.start) segments.push({ start: line.start, text: content.slice(line.start, from), highlighted: false });
    if (to > from) segments.push({ start: from, text: content.slice(from, to), highlighted: true });
    if (to < line.end) segments.push({ start: to, text: content.slice(to, line.end), highlighted: false });
    return { ...line, segments };
  });
}

/** Orders and clamps two offsets into a span inside `length`. */
export function normalizeSpan(a: number, b: number, length: number): Span {
  const clamp = (n: number) => Math.min(Math.max(0, Math.trunc(n)), length);
  const x = clamp(a);
  const y = clamp(b);
  return x <= y ? { start: x, end: y } : { start: y, end: x };
}

/** Moves the span edges inward past whitespace. Returns null when nothing but whitespace is selected. */
export function trimSpan(content: string, span: Span): Span | null {
  let { start, end } = normalizeSpan(span.start, span.end, content.length);
  while (start < end && /\s/.test(content[start] ?? '')) start++;
  while (end > start && /\s/.test(content[end - 1] ?? '')) end--;
  return end > start ? { start, end } : null;
}

/** Reads `start`/`end` from search params; null when absent or invalid for this content. */
export function parseSpanParams(start: string | undefined, end: string | undefined, length: number): Span | null {
  if (start === undefined || end === undefined) return null;
  if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return null;
  const s = Number(start);
  const e = Number(end);
  if (e <= s || s >= length) return null;
  return { start: s, end: Math.min(e, length) };
}

/** 1-based line number that contains `offset`. */
export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, content.length);
  for (let i = 0; i < limit; i++) {
    const ch = content.charCodeAt(i);
    if (ch === 10) line++;
    else if (ch === 13 && content.charCodeAt(i + 1) !== 10) line++;
  }
  return line;
}

/** Deep link that opens a source revision at the exact span. */
export function spanHref(sourceId: string, revisionId: string | null | undefined, start: number, end: number): string {
  const params = new URLSearchParams();
  if (revisionId) params.set('revision', revisionId);
  params.set('start', String(start));
  params.set('end', String(end));
  return `/sources/${sourceId}?${params.toString()}#span`;
}

/** Prefill for a candidate title: the selected text, whitespace collapsed, cut to the API's 500-char limit. */
export function titleFromExcerpt(excerpt: string, max = 500): string {
  const text = excerpt.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Resolves a DOM selection point to a raw offset, given what the DOM tells us about it.
 * `chunkStart` is the raw offset where the text node's chunk begins (from its data attribute) and
 * `offsetInChunk` the UTF-16 offset inside that text node. Kept pure so it can be unit tested.
 */
export function pointToOffset(chunkStart: number, offsetInChunk: number, chunkLength: number): number {
  return chunkStart + Math.min(Math.max(0, offsetInChunk), chunkLength);
}
