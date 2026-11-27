import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conflictLines,
  conflictSourceList,
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
  assert.equal(describeTime(null, 'unknown').text, 'not known');
  assert.equal(describeTime('2026-03-04T16:02:00Z', 'unknown').text, 'not known');
  assert.equal(describeTime(null, 'not_applicable').text, 'not applicable');
  assert.equal(describeTime(null, 'known').tone, 'unknown');
  const conflicting = describeTime(null, 'conflicting', [
    { value: '2026-03-04T00:00:00Z', note: 'chat' },
    { value: '2026-03-06T00:00:00Z' },
    { value: null, note: 'ticket has no date' },
  ]);
  assert.equal(conflicting.text, 'sources disagree');
  assert.deepEqual(conflicting.conflicts, ['2026-03-04 00:00 UTC (chat)', '2026-03-06 00:00 UTC', 'no date (ticket has no date)']);
  assert.equal(describeTime(null, undefined).text, 'not known');
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

test('parseConflictLines reads a value without a date, and conflictLines writes it back the same way', () => {
  const parsed = parseConflictLines('2026-07-08 supplier e-mail\nno date catalogue page\nUndated: scan\nNo date\nnodate x\nundatedly');
  assert.deepEqual(parsed.conflicts, [
    { value: '2026-07-08T00:00:00.000Z', note: 'supplier e-mail' },
    { value: null, note: 'catalogue page' },
    { value: null, note: 'scan' },
    { value: null },
  ]);
  assert.deepEqual(parsed.invalid, ['nodate x', 'undatedly']);
  // What the API journey test stores: a note that itself starts with "undated" survives the round trip.
  const stored = [{ value: '2026-07-08T00:00:00.000Z', note: 'supplier e-mail' }, { value: null, note: 'undated catalogue' }, { value: null }];
  const lines = conflictLines(stored);
  assert.equal(lines, '2026-07-08 00:00 supplier e-mail\nno date undated catalogue\nno date');
  assert.deepEqual(parseConflictLines(lines), { conflicts: stored, invalid: [], unknownSource: [] });
});

test('a competing value names its source by number, and only among the sources offered', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const typed = [
    '2026-07-08 supplier e-mail [1]',
    'no date catalogue page [2]',
    'no date [1]',
    '2026-07-15 memo',
    '2026-07-16 other [3]',
    '2026-07-17 [0]',
    '[1]',
  ].join('\n');
  const parsed = parseConflictLines(typed, [a, b]);
  const stored = [
    { value: '2026-07-08T00:00:00.000Z', sourceId: a, note: 'supplier e-mail' },
    { value: null, sourceId: b, note: 'catalogue page' },
    { value: null, sourceId: a },
    { value: '2026-07-15T00:00:00.000Z', note: 'memo' },
  ];
  assert.deepEqual(parsed.conflicts, stored);
  // A number that is not offered is reported as such; a line that is only a number says nothing.
  assert.deepEqual(parsed.unknownSource, ['2026-07-16 other [3]', '2026-07-17 [0]']);
  assert.deepEqual(parsed.invalid, ['[1]']);

  // The edit form writes the numbers back, and reading that gives the same values.
  const lines = conflictLines(stored, [a, b]);
  assert.equal(lines, '2026-07-08 00:00 supplier e-mail [1]\nno date catalogue page [2]\nno date [1]\n2026-07-15 00:00 memo');
  assert.deepEqual(parseConflictLines(lines, [a, b]), { conflicts: stored, invalid: [], unknownSource: [] });

  // Where no source is offered, "[1]" is ordinary note text and a stored source is not written out.
  assert.deepEqual(parseConflictLines('2026-07-08 see footnote [1]').conflicts, [{ value: '2026-07-08T00:00:00.000Z', note: 'see footnote [1]' }]);
  assert.equal(conflictLines(stored.slice(0, 1)), '2026-07-08 00:00 supplier e-mail');
});

test('conflictSourceList offers the cited sources first, once each, then any other source a stored value names', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const list = conflictSourceList(
    [{ id: a, title: 'Widget prices' }, { id: a, title: 'Widget prices' }],
    [{ value: null, sourceId: b }, { value: null, sourceId: a }, { value: null }, { value: null, sourceId: b }],
  );
  assert.deepEqual(list, [{ id: a, title: 'Widget prices' }, { id: b, title: null }]);
  assert.deepEqual(conflictSourceList([], null), []);
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
