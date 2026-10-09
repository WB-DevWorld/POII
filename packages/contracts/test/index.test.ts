import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Locator, RecordKind, StatementMode, statedRoles } from '../src/index.js';

test('vocabulary keeps attribution separate from approval', () => {
  assert.ok(statedRoles.includes('assistant'));
  assert.equal(RecordKind.safeParse('opinion').success, false);
  assert.equal(StatementMode.parse('pasted'), 'pasted');
});

test('locators require a hashed excerpt', () => {
  const sha = 'a'.repeat(64);
  assert.equal(Locator.safeParse({ revisionId: '019277a0-0000-7000-8000-000000000000', startChar: 0, endChar: 5,
    startLine: 1, endLine: 1, excerpt: 'hello', excerptSha256: sha }).success, true);
  assert.equal(Locator.safeParse({ revisionId: 'nope', startChar: 0, endChar: 5, startLine: 1, endLine: 1,
    excerpt: 'hello', excerptSha256: 'short' }).success, false);
});
