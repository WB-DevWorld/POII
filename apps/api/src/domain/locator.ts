// Locators and re-anchoring (ADR-0005). Pure functions; offsets are UTF-16 code units of the stored text.
import type { AnchorResult, Locator } from '@poii/contracts';
import { AppError } from '../common/errors.js';
import { sha256Hex } from '../common/util.js';

export const MAX_EXCERPT_CHARS = 4000;
/** Shown in place of an excerpt once the source was deleted. The excerpt hash stays for verification. */
export const DELETED_EXCERPT = '[unavailable: source deleted]';

/** 1-based line number of the character at `offset`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Builds the locator for [startChar, endChar) in a revision's text. Throws 400 invalid_span. */
export function computeLocator(text: string, revisionId: string, startChar: number, endChar: number): Locator {
  if (!Number.isInteger(startChar) || !Number.isInteger(endChar) || startChar < 0 || endChar <= startChar || endChar > text.length) {
    throw new AppError(400, 'invalid_span', `Span ${startChar}-${endChar} is outside the revision text (length ${text.length}) or empty`, {
      startChar, endChar, textLength: text.length,
    });
  }
  const span = text.slice(startChar, endChar);
  const startLine = lineAt(text, startChar);
  // The line of the last character in the span.
  const endLine = startLine + countNewlines(span.slice(0, span.length - 1));
  return {
    revisionId,
    startChar,
    endChar,
    startLine,
    endLine,
    excerpt: span.length > MAX_EXCERPT_CHARS ? span.slice(0, MAX_EXCERPT_CHARS) : span,
    excerptSha256: sha256Hex(span),
  };
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export interface ReanchorOutcome {
  result: AnchorResult;
  /** Present for exact and moved. */
  startChar?: number;
  endChar?: number;
}

/**
 * Finds the span [oldStart, oldEnd) of oldText in newText. `exact` when the same offsets hold the same
 * text, `moved` when the text is found elsewhere (the occurrence nearest the old offset wins), `lost` otherwise.
 */
export function reanchor(oldText: string, oldStart: number, oldEnd: number, newText: string): ReanchorOutcome {
  const span = oldText.slice(oldStart, oldEnd);
  if (!span) return { result: 'lost' };
  if (newText.slice(oldStart, oldEnd) === span) return { result: 'exact', startChar: oldStart, endChar: oldEnd };
  let best = -1;
  let from = 0;
  for (;;) {
    const found = newText.indexOf(span, from);
    if (found === -1) break;
    if (best === -1 || Math.abs(found - oldStart) < Math.abs(best - oldStart)) best = found;
    if (found > oldStart) break; // later occurrences are only further away
    from = found + 1;
  }
  if (best === -1) return { result: 'lost' };
  return { result: 'moved', startChar: best, endChar: best + span.length };
}
