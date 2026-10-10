// #20 conversation import: the /imports page's selection and file helpers. Pure; nothing mocked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkExportFile, formatSpan, isSelectable, MAX_EXPORT_FILE_BYTES, MAX_SELECTED, orderedSelection, parseExportText, toggleSelection,
} from '../src/app/imports/logic';

const rows = [
  { id: 'a', importState: 'new' as const },
  { id: 'b', importState: 'unchanged' as const },
  { id: 'c', importState: 'deleted' as const },
  { id: 'd', importState: 'changed' as const },
];

test('selection keeps file order, ignores unknown and deleted conversations, and unchecks', () => {
  let selected = toggleSelection(rows, [], 'd', true);
  selected = toggleSelection(rows, selected, 'a', true);
  assert.deepEqual(selected, ['a', 'd']);
  assert.deepEqual(toggleSelection(rows, selected, 'c', true), ['a', 'd'], 'a deleted conversation cannot be selected');
  assert.deepEqual(toggleSelection(rows, selected, 'zzz', true), ['a', 'd'], 'an id not in the file is ignored');
  assert.deepEqual(toggleSelection(rows, selected, 'a', true), ['a', 'd'], 'checking twice changes nothing');
  assert.deepEqual(toggleSelection(rows, selected, 'a', false), ['d']);
  assert.deepEqual(orderedSelection(rows, ['d', 'c', 'x', 'b']), ['b', 'd']);
  assert.equal(isSelectable(rows[2]!), false);
});

test('selection never grows beyond the per-import limit', async () => {
  const contracts = await import('@poii/contracts');
  assert.equal(MAX_SELECTED, contracts.CONVERSATION_IMPORT_MAX_SELECTED);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, importState: 'new' as const }));
  let selected: string[] = [];
  for (const row of many) selected = toggleSelection(many, selected, row.id, true);
  assert.equal(selected.length, MAX_SELECTED);
  assert.deepEqual(selected.slice(-1), ['c49']);
  assert.deepEqual(toggleSelection(rows, ['a', 'b'], 'd', true, 2), ['a', 'b']);
  assert.deepEqual(toggleSelection(rows, ['a', 'b'], 'b', false, 2), ['a']);
});

test('file checks: missing, empty, too large, not JSON', () => {
  assert.match(checkExportFile(null)!, /Choose/);
  assert.match(checkExportFile({ name: 'conversations.json', size: 0 })!, /empty/);
  assert.match(checkExportFile({ name: 'conversations.json', size: MAX_EXPORT_FILE_BYTES + 1 })!, /limit is 50 MB/);
  assert.equal(checkExportFile({ name: 'conversations.json', size: 1024 }), null);
  assert.deepEqual(parseExportText('[{"uuid":"x"}]'), { ok: true, data: [{ uuid: 'x' }] });
  assert.equal(parseExportText('{not json').ok, false);
});

test('date span in UTC: range, single day, unknown', () => {
  assert.equal(formatSpan('2026-03-02T09:14:00.000Z', '2026-03-04T23:59:00.000Z'), '2 Mar 2026 – 4 Mar 2026');
  assert.equal(formatSpan('2026-03-02T09:14:00.000Z', '2026-03-02T23:00:00.000Z'), '2 Mar 2026');
  assert.equal(formatSpan(null, null), 'unknown');
});
