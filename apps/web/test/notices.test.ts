import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addToParam, noticeText } from '../src/lib/notices';

test('addToParam accepts a record id and nothing else', () => {
  const id = '0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b';
  assert.equal(addToParam(id), id);
  assert.equal(addToParam(id.toUpperCase()), id);
  assert.equal(addToParam([id, 'x']), id);
  for (const bad of [undefined, '', 'abc', `${id}/../x`, `${id}?x=1`, '../records', 'javascript:alert(1)']) {
    assert.equal(addToParam(bad), undefined, String(bad));
  }
});

test('the evidence notices have a text; an unknown key has none', () => {
  assert.match(noticeText('evidence-added') ?? '', /Passage added/);
  assert.match(noticeText('evidence-removed') ?? '', /Citation removed/);
  assert.equal(noticeText('<b>x</b>'), null);
});
