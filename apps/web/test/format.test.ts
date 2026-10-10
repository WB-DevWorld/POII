import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conflictLines,
  conflictsFor,
  countLabel,
  describeTime,
  explainCode,
  formatTime,
  headlineParts,
  humanize,
  inputFromIso,
  isoFromInput,
  parseConflictLines,
} from '../src/lib/format';
import { guessMediaType, looksBinary } from '../src/lib/upload';

test('formatTime renders UTC regardless of the server time zone', () => {
  assert.equal(formatTime('2026-03-04T16:02:00+01:00'), '2026-03-04 15:02 UTC');
  assert.equal(formatTime(null), '');
  assert.equal(formatTime('not a date'), 'not a date');
});

test('describeTime keeps unknown, not applicable and conflicting explicit', () => {
  assert.deepEqual(describeTime('2026-03-04T16:02:00Z', 'known'), { text: '2026-03-04 16:02 UTC', tone: 'known', conflicts: [] });
  assert.equal(describeTime(null, 'unknown').text, 'unknown');
  assert.equal(describeTime('2026-03-04T16:02:00Z', 'unknown').text, 'unknown');
  assert.equal(describeTime(null, 'not_applicable').text, 'not applicable');
  assert.equal(describeTime(null, 'known').tone, 'unknown');
  const conflicting = describeTime(null, 'conflicting', [
    { value: '2026-03-04T00:00:00Z', note: 'chat' },
    { value: '2026-03-06T00:00:00Z' },
    { value: null, note: 'ticket has no date' },
  ]);
  assert.equal(conflicting.text, 'conflicting');
  assert.deepEqual(conflicting.conflicts, ['2026-03-04 00:00 UTC (chat)', '2026-03-06 00:00 UTC', 'no value (ticket has no date)']);
  assert.equal(describeTime(null, undefined).text, 'unknown');
});

test('isoFromInput reads datetime-local and dates as UTC and rejects nonsense', () => {
  assert.equal(isoFromInput('2026-03-04T16:02'), '2026-03-04T16:02:00.000Z');
  assert.equal(isoFromInput('2026-03-04'), '2026-03-04T00:00:00.000Z');
  assert.equal(isoFromInput('2026-03-04 16:02:30'), '2026-03-04T16:02:30.000Z');
  assert.equal(isoFromInput('2026-02-30'), null);
  assert.equal(isoFromInput('yesterday'), null);
  assert.equal(isoFromInput(''), null);
  assert.equal(inputFromIso('2026-03-04T16:02:00.000Z'), '2026-03-04T16:02');
  assert.equal(inputFromIso(null), '');
});

test('parseConflictLines reads one value per line and reports bad lines', () => {
  const parsed = parseConflictLines('2026-03-04 16:02 chat says\n\n2026-03-06 — ticket says\nlast week');
  assert.deepEqual(parsed.conflicts, [
    { value: '2026-03-04T16:02:00.000Z', note: 'chat says' },
    { value: '2026-03-06T00:00:00.000Z', note: 'ticket says' },
  ]);
  assert.deepEqual(parsed.invalid, ['last week']);
});

test('conflictsFor separates effective and observed values by note tag', () => {
  const all = [
    { value: '2026-03-04T00:00:00.000Z', note: 'effective: chat' },
    { value: '2026-03-05T00:00:00.000Z', note: 'observed' },
    { value: '2026-03-06T00:00:00.000Z', note: 'imported elsewhere' },
  ];
  assert.deepEqual(conflictsFor('effective', all), [
    { value: '2026-03-04T00:00:00.000Z', note: 'chat' },
    { value: '2026-03-06T00:00:00.000Z', note: 'imported elsewhere' },
  ]);
  assert.deepEqual(conflictsFor('observed', all), [
    { value: '2026-03-05T00:00:00.000Z' },
    { value: '2026-03-06T00:00:00.000Z', note: 'imported elsewhere' },
  ]);
  assert.equal(conflictLines(conflictsFor('effective', all)), '2026-03-04 00:00 chat\n2026-03-06 00:00 imported elsewhere');
});

test('headlineParts only turns <b> markers into hits and leaves other markup as text', () => {
  assert.deepEqual(headlineParts('uses <b>BullMQ</b> on <script>x</script>'), [
    { text: 'uses ', hit: false },
    { text: 'BullMQ', hit: true },
    { text: ' on <script>x</script>', hit: false },
  ]);
});

test('small labels', () => {
  assert.equal(humanize('third_party'), 'third party');
  assert.equal(countLabel(3, 200), '3');
  assert.equal(countLabel(200, 200), '200+');
  assert.match(explainCode('workspace_not_empty') ?? '', /empty workspace/);
  assert.equal(explainCode('something_else'), null);
});

test('upload helpers', () => {
  assert.equal(guessMediaType('notes.MD', ''), 'text/markdown');
  assert.equal(guessMediaType('a.txt', 'text/plain'), 'text/plain');
  assert.equal(guessMediaType('a', ''), 'text/plain');
  assert.equal(looksBinary('abc\u0000def'), true);
  assert.equal(looksBinary('plain text'), false);
});
