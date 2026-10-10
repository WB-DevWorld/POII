// Unit tests of the web side of AccessLobby sign-in (ADR-0012): the flow cookie, error codes and the registered
// web paths. The flows themselves are tested against the API in apps/api/test/auth.accesslobby.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessLobbyMessage, errorCode, FLOW_COOKIE_PATH, flowCookieOptions, parseFlowCookie } from '../src/app/signin/accesslobby/flow';

const binding = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

test('the flow cookie is <intent>.<binding> and nothing else', () => {
  assert.deepEqual(parseFlowCookie(`signin.${binding}`), { intent: 'signin', binding });
  assert.deepEqual(parseFlowCookie(`link.${binding}`), { intent: 'link', binding });
  for (const bad of [undefined, '', binding, `admin.${binding}`, `signin.${binding}.x`, `signin.short`, `link.${binding}; Path=/`]) {
    assert.equal(parseFlowCookie(bad), null, String(bad));
  }
});

test('the flow cookie is HttpOnly, Lax, short-lived and scoped to the AccessLobby routes', () => {
  const options = flowCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax', 'Lax: it must arrive with the top-level redirect back from AccessLobby');
  assert.equal(options.path, FLOW_COOKIE_PATH);
  assert.equal(FLOW_COOKIE_PATH, '/signin/accesslobby', 'the registered callback lives under /signin, outside the proxy');
  assert.ok(options.maxAge <= 600);
  assert.equal(flowCookieOptions(0).maxAge, 0);
});

test('API error codes become safe lower-case codes with plain messages', async () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  assert.equal(await errorCode(reply(403, { code: 'NOT_LINKED', message: 'x' })), 'not_linked');
  assert.equal(await errorCode(reply(503, { code: 'ACCESSLOBBY_UNAVAILABLE' })), 'accesslobby_unavailable');
  assert.equal(await errorCode(reply(400, { code: '<script>alert(1)</script>' })), 'scriptalert1script');
  assert.equal(await errorCode(reply(502, null)), 'http_502');
  assert.equal(await errorCode(new Response('', { status: 429 })), 'too_many_attempts');
  assert.match(accessLobbyMessage('not_linked')!, /Connect AccessLobby/);
  assert.match(accessLobbyMessage('accesslobby_unavailable')!, /cannot be reached/);
  assert.equal(accessLobbyMessage('something_else'), null);
});
