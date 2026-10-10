import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lineOfOffset,
  normalizeSpan,
  parseSpanParams,
  pointToOffset,
  renderLines,
  spanHref,
  splitLines,
  titleFromExcerpt,
  trimSpan,
} from '../src/lib/offsets';

test('splitLines keeps raw offsets for \\n, \\r\\n and \\r terminators', () => {
  const content = 'ab\r\ncd\nef\rg';
  assert.deepEqual(splitLines(content), [
    { lineNo: 1, start: 0, end: 2 },
    { lineNo: 2, start: 4, end: 6 },
    { lineNo: 3, start: 7, end: 9 },
    { lineNo: 4, start: 10, end: 11 },
  ]);
  for (const line of splitLines(content)) assert.ok(!/[\r\n]/.test(content.slice(line.start, line.end)));
});

test('a trailing newline yields an empty last line', () => {
  assert.deepEqual(splitLines('a\n').at(-1), { lineNo: 2, start: 2, end: 2 });
  assert.deepEqual(splitLines(''), [{ lineNo: 1, start: 0, end: 0 }]);
});

test('renderLines segments reassemble the content and mark exactly the span', () => {
  const content = 'first line\nsecond line\nthird';
  const span = { start: 6, end: 17 }; // "line\nsecond"
  const lines = renderLines(content, span);
  const marked = lines.flatMap(l => l.segments.filter(s => s.highlighted).map(s => s.text));
  assert.deepEqual(marked, ['line', 'second']);
  for (const line of lines) {
    for (const seg of line.segments) assert.equal(content.slice(seg.start, seg.start + seg.text.length), seg.text);
  }
  const rebuilt = lines.map(l => l.segments.map(s => s.text).join('')).join('\n');
  assert.equal(rebuilt, content);
});

test('offsets are UTF-16 code units, so astral characters count as two', () => {
  const content = 'a😀b\nc';
  const lines = renderLines(content, { start: 1, end: 3 });
  const seg = lines[0]?.segments.find(s => s.highlighted);
  assert.equal(seg?.text, '😀');
  assert.equal(seg?.start, 1);
  // A point inside the text node after the emoji is offset 3, the "b".
  assert.equal(pointToOffset(0, 3, 4), 3);
  assert.equal(content.slice(3, 4), 'b');
});

test('pointToOffset clamps into the chunk', () => {
  assert.equal(pointToOffset(100, 5, 10), 105);
  assert.equal(pointToOffset(100, 50, 10), 110);
  assert.equal(pointToOffset(100, -1, 10), 100);
});

test('normalizeSpan orders and clamps; trimSpan drops surrounding whitespace', () => {
  assert.deepEqual(normalizeSpan(9, 2, 5), { start: 2, end: 5 });
  const content = '  hello world \n';
  assert.deepEqual(trimSpan(content, { start: 0, end: content.length }), { start: 2, end: 13 });
  assert.equal(trimSpan(content, { start: 13, end: 15 }), null);
});

test('parseSpanParams accepts only valid integer spans inside the content', () => {
  assert.deepEqual(parseSpanParams('2', '5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseSpanParams('2', '50', 10), { start: 2, end: 10 });
  assert.equal(parseSpanParams('5', '5', 10), null);
  assert.equal(parseSpanParams('-1', '5', 10), null);
  assert.equal(parseSpanParams('x', '5', 10), null);
  assert.equal(parseSpanParams('10', '12', 10), null);
  assert.equal(parseSpanParams(undefined, '5', 10), null);
});

test('lineOfOffset matches splitLines', () => {
  const content = 'a\r\nb\nc\rd';
  for (const line of splitLines(content)) assert.equal(lineOfOffset(content, line.start), line.lineNo);
});

test('spanHref builds the deep link with the #span anchor', () => {
  assert.equal(spanHref('s1', 'r1', 3, 9), '/sources/s1?revision=r1&start=3&end=9#span');
  assert.equal(spanHref('s1', null, 3, 9), '/sources/s1?start=3&end=9#span');
});

test('titleFromExcerpt collapses whitespace and respects the 500-char limit', () => {
  assert.equal(titleFromExcerpt('  Decision:\n  use   BullMQ '), 'Decision: use BullMQ');
  assert.equal(titleFromExcerpt('x'.repeat(600)).length, 500);
});
