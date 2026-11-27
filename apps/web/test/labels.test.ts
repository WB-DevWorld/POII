import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  actorKindTerms,
  anchorResultTerms,
  authorityTerms,
  codeTitle,
  evidenceRoleTerms,
  glossary,
  labelOf,
  lifecycleStatusTerms,
  recordKindTerms,
  reviewStateTerms,
  statedRoleTerms,
  statementModeTerms,
  timeStatusTerms,
  type Term,
} from '../src/lib/labels';

// The unit tests run without building the contracts package, so the codes are read from its source.
const vocabulary = readFileSync(new URL('../../../packages/contracts/src/vocabulary.ts', import.meta.url), 'utf8');
function codes(name: string): string[] {
  const match = new RegExp(String.raw`export const ${name} = \[([^\]]*)\] as const`).exec(vocabulary);
  assert.ok(match?.[1], `${name} not found in vocabulary.ts`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1] ?? '');
}
const recordKinds = codes('recordKinds');
const reviewStates = codes('reviewStates');
const lifecycleStatuses = codes('lifecycleStatuses');
const statedRoles = codes('statedRoles');
const statementModes = codes('statementModes');
const timeStatuses = codes('timeStatuses');
const actorKinds = codes('actorKinds');
const authorities = codes('authorities');
const evidenceRoles = codes('evidenceRoles');
const anchorResults = codes('anchorResults');

// ADR-0014: every contract code has exactly one label, and no two codes of a field share a label.
const pairs: [readonly string[], Record<string, Term>, string][] = [
  [recordKinds, recordKindTerms, 'kind'],
  [reviewStates, reviewStateTerms, 'reviewState'],
  [lifecycleStatuses, lifecycleStatusTerms, 'lifecycleStatus'],
  [statedRoles, statedRoleTerms, 'statedRole'],
  [statementModes, statementModeTerms, 'statementMode'],
  [timeStatuses, timeStatusTerms, 'timeStatus'],
  [actorKinds, actorKindTerms, 'actorKind'],
  [authorities, authorityTerms, 'authority'],
  [evidenceRoles, evidenceRoleTerms, 'evidenceRole'],
  [anchorResults, anchorResultTerms, 'anchorResult'],
];

test('every contract code has a label and a meaning, and labels are unique per field', () => {
  for (const [codes, terms, field] of pairs) {
    assert.deepEqual(Object.keys(terms).sort(), [...codes].sort(), `${field}: labels and contract codes differ`);
    const labels = Object.values(terms).map(t => t.label.toLowerCase());
    assert.equal(new Set(labels).size, labels.length, `${field}: two codes share a label`);
    for (const [code, term] of Object.entries(terms)) {
      assert.ok(term.label.trim() && term.meaning.trim(), `${field}.${code} needs a label and a meaning`);
    }
  }
});

test('the code stays visible next to the word', () => {
  assert.equal(labelOf(reviewStateTerms, 'candidate'), 'Awaiting review');
  assert.match(codeTitle(reviewStateTerms, 'candidate') ?? '', /\(code: candidate\)$/);
  // A code the web app does not know yet is shown as it is, never hidden.
  assert.equal(labelOf(reviewStateTerms, 'brand_new_state'), 'brand new state');
  assert.equal(codeTitle(reviewStateTerms, 'brand_new_state'), 'code: brand_new_state');
});

test('docs/glossary.md lists every label with its code', () => {
  const doc = readFileSync(new URL('../../../docs/glossary.md', import.meta.url), 'utf8');
  for (const group of glossary) {
    for (const [code, term] of Object.entries(group.terms)) {
      assert.ok(doc.includes(`| ${term.label} | \`${code}\` |`), `docs/glossary.md is missing the row "| ${term.label} | \`${code}\` |"`);
    }
  }
});
