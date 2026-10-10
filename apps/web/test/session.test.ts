import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, toProblem } from '../src/lib/api';
import {
  API_SESSION_COOKIE, API_SESSION_COOKIE_SECURE, CSRF_HEADER, isSecureBaseUrl, parseSessionSetCookie, safeNextPath, sessionCookieOptions,
  sessionHeaders, webOrigin,
} from '../src/lib/session';

/** Better Auth's signed session token as it appears in its cookie: `<token>.<HMAC>`, URL-encoded. */
// Deliberately low-entropy test value of the real shape (32-char token, dot, URL-encoded base64 signature); not a secret.
const secret = 'testtokentesttokentesttokentest1.testsignaturetestsignaturetestsigna%2Bure%2Btest%3D';

test('the API session cookie names and the CSRF header match the shared contract', async () => {
  const contracts = await import('@poii/contracts');
  assert.equal(API_SESSION_COOKIE, contracts.AUTH_SESSION_COOKIE);
  assert.equal(API_SESSION_COOKIE_SECURE, contracts.AUTH_SESSION_COOKIE_SECURE);
  assert.equal(CSRF_HEADER, contracts.CSRF_HEADER);
});

test("parses Better Auth's session cookie (plain or __Secure-) from the API Set-Cookie lines, with expiry and max-age", () => {
  const issued = parseSessionSetCookie([
    'other=1; Path=/',
    `poii.session_token=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600; Expires=Sat, 24 Oct 2026 10:00:00 GMT`,
  ]);
  assert.ok(issued);
  assert.equal(issued.value, secret);
  assert.equal(issued.maxAge, 1209600);
  assert.equal(issued.expires?.toISOString(), '2026-10-24T10:00:00.000Z');
  const secure = parseSessionSetCookie([`__Secure-poii.session_token=${secret}; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax`]);
  assert.equal(secure?.value, secret);
  assert.equal(secure?.maxAge, 60);
});

test('a cleared, missing or malformed session cookie parses to null', () => {
  assert.equal(parseSessionSetCookie(['poii.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax']), null);
  assert.equal(parseSessionSetCookie([]), null);
  assert.equal(parseSessionSetCookie(['poii_session=abc']), null, 'the old in-house cookie is not a Better Auth session');
  assert.equal(parseSessionSetCookie(['xpoii.session_token=abc']), null);
  assert.equal(parseSessionSetCookie(['poii.session_token=a b; Path=/']), null);
  assert.equal(parseSessionSetCookie(['poii.session_token=abc\r\nSet-Cookie: x=y']), null);
  assert.equal(parseSessionSetCookie([`poii.session_token=${'a'.repeat(513)}`]), null);
});


test('cookies are Secure except on loopback addresses', () => {
  assert.equal(isSecureBaseUrl('http://localhost:3000'), false);
  assert.equal(isSecureBaseUrl('http://127.0.0.1:3000'), false);
  assert.equal(isSecureBaseUrl('http://poii.localhost'), false);
  assert.equal(isSecureBaseUrl('https://poii.example.test'), true);
  assert.equal(isSecureBaseUrl('not a url'), true);
  assert.equal(isSecureBaseUrl(undefined), true, 'an unset WEB_BASE_URL fails closed');
  assert.equal(isSecureBaseUrl(''), true);
  const options = sessionCookieOptions({ value: secret, maxAge: 60 }, 'https://poii.example.test');
  assert.deepEqual(options, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 });
});

test('API calls carry the CSRF header and the web Origin always, and the session token only when it looks like one', () => {
  const web = 'https://poii.example.test/some/path';
  assert.equal(webOrigin(web), 'https://poii.example.test');
  assert.equal(webOrigin(''), undefined);
  assert.equal(webOrigin('not a url'), undefined);
  assert.deepEqual(sessionHeaders(undefined, web), { 'x-poii-csrf': '1', origin: 'https://poii.example.test' });
  assert.deepEqual(sessionHeaders(secret, web), {
    'x-poii-csrf': '1', origin: 'https://poii.example.test',
    cookie: `poii.session_token=${secret}; __Secure-poii.session_token=${secret}`,
  });
  assert.deepEqual(sessionHeaders('evil; other=1', web), { 'x-poii-csrf': '1', origin: 'https://poii.example.test' });
  assert.deepEqual(sessionHeaders(undefined, ''), { 'x-poii-csrf': '1' }, 'no WEB_BASE_URL: no Origin');
});

test('after sign-in only same-site paths are followed', () => {
  assert.equal(safeNextPath('/records?kind=decision'), '/records?kind=decision');
  assert.equal(safeNextPath(undefined), '/');
  assert.equal(safeNextPath('https://evil.example'), '/');
  assert.equal(safeNextPath('//evil.example'), '/');
  assert.equal(safeNextPath('/\\evil.example'), '/');
  assert.equal(safeNextPath('/signin'), '/');
  assert.equal(safeNextPath('/x\r\nLocation: y'), '/');
  assert.equal(safeNextPath('/\t/evil.com'), '/', 'a tab is stripped by URL parsers and would make //evil.com');
  assert.equal(safeNextPath(decodeURIComponent('/%09/evil.com')), '/');
  assert.equal(safeNextPath('/ /evil.com'), '/');
  assert.equal(safeNextPath('/\u007f'), '/');
  assert.equal(safeNextPath('/a/../sources?x=1'), '/sources?x=1', 'normalized by the URL parser');
  assert.equal(safeNextPath('/%2F%2Fevil.com'), '/%2F%2Fevil.com', 'encoded slashes stay a same-origin path');
});

test('a 401 from the API reads as signed out', () => {
  const problem = toProblem(new ApiError(401, { error: 'unauthenticated', message: 'Sign in first', requestId: 'r' }));
  assert.equal(problem.code, 'unauthenticated');
  assert.equal(problem.status, 401);
  assert.match(problem.message, /signed out/);
});
