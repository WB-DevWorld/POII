import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStaleBuildError, pageErrorText } from '../src/lib/update-error';

test('a Server Action from the previous release is recognised as an update', () => {
  const byName = Object.assign(new Error('x'), { name: 'UnrecognizedActionError' });
  const byMessage = new Error(
    'Server Action "7f3a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
  );
  assert.equal(isStaleBuildError(byName), true);
  assert.equal(isStaleBuildError(byMessage), true);
  assert.match(pageErrorText(byName).title, /updated while this page was open/);
  assert.match(pageErrorText(byName).body, /nothing was saved/);
});

test('any other error gets the general text and never claims nothing was saved', () => {
  for (const other of [new Error('boom'), new TypeError('x'), null, undefined, 'text', { message: 42 }]) {
    assert.equal(isStaleBuildError(other), false, String(other));
    const text = pageErrorText(other);
    assert.equal(text.title, 'This page could not load');
    assert.doesNotMatch(text.body, /nothing was saved/);
  }
});
