// Locating the first matching span of a search in a source's text, so the UI can open the original there.
import { lineAt } from './locator.js';

/** The first positive term of a websearch-style query (skips `-negated` terms and the `or` operator). */
export function firstQueryTerm(query: string): string | null {
  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    if (raw.startsWith('-')) continue;
    if (raw.toLowerCase() === 'or') continue;
    const word = raw.replace(/"/g, '').match(/[\p{L}\p{N}_]+/u);
    if (word) return word[0];
  }
  return null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export interface TextSpan {
  startChar: number;
  endChar: number;
  startLine: number;
}

/**
 * Case-insensitive search of the first query term. Full-text search stems words, so when the literal term
 * is absent the term is shortened (down to 3 characters) before giving up. The span covers the whole word.
 */
export function findFirstSpan(text: string, query: string): TextSpan | null {
  const term = firstQueryTerm(query);
  if (!term) return null;
  for (let length = term.length; length >= Math.min(3, term.length); length--) {
    const pattern = new RegExp(escapeRegExp(term.slice(0, length)), 'iu');
    const match = pattern.exec(text);
    if (!match) continue;
    const startChar = match.index;
    let endChar = startChar + match[0].length;
    while (endChar < text.length && WORD_CHAR.test(text[endChar]!)) endChar++;
    return { startChar, endChar, startLine: lineAt(text, startChar) };
  }
  return null;
}

/** Escapes HTML in a ts_headline result whose highlights were marked with \u0002 and \u0003, then restores <b> marks. */
export function safeHeadline(raw: string): string {
  return raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\u0002/g, '<b>').replace(/\u0003/g, '</b>');
}
