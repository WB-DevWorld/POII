import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Locator } from '@poii/contracts';
import { AppError } from '../src/common/errors.js';
import { computeLocator, lineAt, MAX_EXCERPT_CHARS, reanchor } from '../src/domain/locator.js';
import { countLines } from '../src/domain/text.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REV = '01900000-0000-7000-8000-000000000001';

test('locator: offsets, 1-based lines, exact excerpt and hash', () => {
  const text = 'line one\nline two\nline three\n';
  const start = text.indexOf('two');
  const end = text.indexOf('three') + 'three'.length;
  const locator = computeLocator(text, REV, start, end);
  assert.deepEqual(locator, {
    revisionId: REV, startChar: start, endChar: end, startLine: 2, endLine: 3,
    excerpt: 'two\nline three', excerptSha256: sha('two\nline three'),
  });
  Locator.parse(locator);
  assert.equal(lineAt(text, 0), 1);
  assert.equal(lineAt(text, text.indexOf('line two')), 2);
});

test('locator: a span ending with its newline stays on its last line', () => {
  const text = 'a\nb\nc';
  const locator = computeLocator(text, REV, 2, 4); // "b\n"
  assert.equal(locator.startLine, 2);
  assert.equal(locator.endLine, 2);
});

test('locator: offsets are UTF-16 code units', () => {
  const text = 'emoji 😀 then ü and 中文';
  const start = text.indexOf('then');
  const locator = computeLocator(text, REV, start, text.length);
  assert.equal(start, 9); // the emoji is two code units
  assert.equal(locator.excerpt, 'then ü and 中文');
  assert.equal(locator.excerptSha256, sha('then ü and 中文'));
});

test('locator: excerpt is truncated to 4000 chars, hash covers the full span', () => {
  const text = 'x'.repeat(5000) + '\nend';
  const locator = computeLocator(text, REV, 0, text.length);
  assert.equal(locator.excerpt.length, MAX_EXCERPT_CHARS);
  assert.equal(locator.excerptSha256, sha(text));
  assert.equal(locator.endLine, 2);
});

test('locator: empty or out-of-range spans are refused with invalid_span', () => {
  for (const [s, e] of [[3, 3], [5, 2], [0, 100], [-1, 2]] as const) {
    assert.throws(() => computeLocator('short', REV, s, e), (error: unknown) => error instanceof AppError && error.code === 'invalid_span' && error.status === 400);
  }
});

test('re-anchoring: exact, moved (nearest occurrence) and lost', () => {
  const v1 = 'alpha line\nbeta line\ngamma line\n';
  const v2 = 'alpha line\nNEW intro text\ngamma line\n';
  const alpha = { s: 0, e: 'alpha line'.length };
  assert.deepEqual(reanchor(v1, alpha.s, alpha.e, v2), { result: 'exact', startChar: 0, endChar: 10 });
  const gs = v1.indexOf('gamma line');
  assert.deepEqual(reanchor(v1, gs, gs + 10, v2), { result: 'moved', startChar: v2.indexOf('gamma line'), endChar: v2.indexOf('gamma line') + 10 });
  const bs = v1.indexOf('beta line');
  assert.deepEqual(reanchor(v1, bs, bs + 9, v2), { result: 'lost' });
  // Several occurrences: the one nearest the old offset wins.
  const old = 'aaa X bbb';
  const next = 'pre aaa X bbb post X';
  assert.deepEqual(reanchor(old, 4, 5, next), { result: 'moved', startChar: 8, endChar: 9 });
});

test('countLines ignores a trailing newline', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\ntwo'), 2);
  assert.equal(countLines('one\n\n'), 2);
});
