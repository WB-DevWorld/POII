import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { plainRecordLine, plainWordTables } from '../src/domain/plain-words.js';

// ADR-0014: packs and agent files use the same words as the web app, so every word here must be a glossary row.
test('every plain word in packs and agent files is listed in docs/glossary.md with its code', () => {
  const doc = readFileSync(new URL('../../../docs/glossary.md', import.meta.url), 'utf8');
  for (const table of plainWordTables) {
    for (const [code, word] of Object.entries(table)) {
      assert.ok(doc.includes(`| ${word} | \`${code}\` |`), `docs/glossary.md has no row "| ${word} | \`${code}\` |"`);
    }
  }
});

test('the plain line never hides that a record is unconfirmed or replaced', () => {
  assert.equal(
    plainRecordLine({ kind: 'decision', reviewState: 'confirmed', lifecycleStatus: 'decided', current: true }),
    'Decision, confirmed; stage: Decided; still current.',
  );
  assert.match(plainRecordLine({ kind: 'fact', reviewState: 'candidate', lifecycleStatus: 'unknown', current: true }), /awaiting review \(not confirmed, treat as unconfirmed\)/);
  assert.match(plainRecordLine({ kind: 'fact', reviewState: 'confirmed', lifecycleStatus: 'observed', current: false }), /not current \(replaced or rejected\)/);
});
