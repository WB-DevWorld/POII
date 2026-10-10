// Unit tests of the identity primitives, the Better Auth configuration surface and token scopes (ADR-0009).
// Pure functions; no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_SESSION_COOKIE, AUTH_SESSION_COOKIE_SECURE, CSRF_HEADER as CONTRACT_CSRF_HEADER } from '@poii/contracts';
import { AUTH_BASE_PATH, AUTH_COOKIE_PREFIX, HTTP_AUTH_PATHS } from '../src/adapters/better-auth.identity.js';
import {
  assertNotCrossSite, bearerSecret, clientAddress, CSRF_HEADER, isTokenSecret, newTokenSecret, sameDigest, sha256,
} from '../src/adapters/identity-secrets.js';
import { can, canManageAccess, requireAccessManagement, requireCapability, type AuthorizableActor } from '../src/authorization/authorization.js';
import { AppError } from '../src/common/errors.js';
import { config } from '../src/config.js';

const code = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error.code;
  }
};

test('token secrets: 32 random bytes with the poii_ prefix; digests compare in constant time', () => {
  const token = newTokenSecret();
  assert.ok(isTokenSecret(token));
  assert.equal(token.length, 5 + 43);
  assert.notEqual(newTokenSecret(), newTokenSecret());
  assert.equal(sameDigest(sha256('x'), sha256('x')), true);
  assert.equal(sameDigest(sha256('x'), sha256('y')), false);
  assert.equal(sameDigest('', ''), false);
});

test('bearer parsing', () => {
  assert.equal(bearerSecret({ headers: { authorization: 'Bearer poii_x' } }), 'poii_x');
  assert.equal(bearerSecret({ headers: {} }), undefined);
  assert.equal(code(() => bearerSecret({ headers: { authorization: 'Basic abc' } })), 'invalid_token');
});

test('CSRF check: safe methods pass; mutations need the header, a trusted Origin and no cross-site fetch metadata', () => {
  const trusted = ['https://poii.example.test'];
  const check = (method: string, headers: Record<string, string>) => code(() => assertNotCrossSite({ method, headers }, trusted));
  assert.equal(check('GET', {}), null);
  assert.equal(check('POST', {}), 'csrf_rejected');
  assert.equal(check('POST', { 'x-poii-csrf': '1' }), null);
  assert.equal(check('DELETE', { 'x-poii-csrf': '1', origin: 'https://poii.example.test' }), null);
  assert.equal(check('POST', { 'x-poii-csrf': '1', origin: 'https://evil.example' }), 'csrf_rejected');
  assert.equal(check('POST', { 'x-poii-csrf': '1', origin: 'null' }), 'csrf_rejected');
  assert.equal(check('POST', { 'x-poii-csrf': '1', 'sec-fetch-site': 'cross-site' }), 'csrf_rejected');
  assert.equal(check('POST', { 'x-poii-csrf': '1', 'sec-fetch-site': 'same-site' }), 'csrf_rejected');
  assert.equal(check('PATCH', { 'x-poii-csrf': '1', 'sec-fetch-site': 'same-origin' }), null);
});

test('client address for the rate limiter: the socket address unless a trusted proxy is configured', () => {
  const headers = { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' };
  assert.equal(clientAddress(headers, '10.0.0.5', false), '10.0.0.5');
  assert.equal(clientAddress(headers, '10.0.0.5', true), '198.51.100.7', 'the right-most entry, appended by the trusted proxy');
  assert.equal(clientAddress({}, '10.0.0.5', true), '10.0.0.5');
  assert.equal(clientAddress({}, undefined, false), undefined);
});

test('Better Auth surface: mounted at /v1/auth, cookie names match the contract, only the endpoints POII uses', () => {
  assert.equal(AUTH_BASE_PATH, '/v1/auth');
  assert.equal(`${AUTH_COOKIE_PREFIX}.session_token`, AUTH_SESSION_COOKIE);
  assert.equal(`__Secure-${AUTH_COOKIE_PREFIX}.session_token`, AUTH_SESSION_COOKIE_SECURE);
  assert.equal(CSRF_HEADER, CONTRACT_CSRF_HEADER);
  for (const path of ['/sign-in/username', '/sign-out', '/revoke-sessions', '/change-password', '/get-session']) assert.ok(HTTP_AUTH_PATHS.has(path), path);
  for (const path of ['/sign-up/email', '/sign-in/email', '/sign-in/social', '/update-user', '/delete-user', '/request-password-reset', '/link-social']) {
    assert.equal(HTTP_AUTH_PATHS.has(path), false, path);
  }
});

test('token scopes: read reads; propose reads and proposes; neither confirms, deletes or manages access', () => {
  const reader: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: null, details: { scopes: ['read'] } };
  const proposer: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: null, details: { scopes: ['propose'] } };
  const forged: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: null, details: { scopes: ['confirm', 'delete'] } };
  const owner: AuthorizableActor = { kind: 'person', authority: 'owner', revokedAt: null, details: {} };
  const delegated: AuthorizableActor = { kind: 'person', authority: 'delegated', revokedAt: null, details: {} };
  assert.deepEqual([can(reader, 'read'), can(reader, 'propose'), can(reader, 'confirm'), can(reader, 'delete')], [true, false, false, false]);
  assert.deepEqual([can(proposer, 'read'), can(proposer, 'propose'), can(proposer, 'confirm'), can(proposer, 'delete')], [true, true, false, false]);
  assert.deepEqual([can(forged, 'read'), can(forged, 'propose'), can(forged, 'confirm'), can(forged, 'delete')], [false, false, false, false]);
  assert.equal(code(() => requireCapability(reader, 'propose')), 'scope_required');
  assert.equal(code(() => requireCapability(proposer, 'confirm')), 'authority_required');
  assert.equal(code(() => requireCapability(forged, 'read')), 'forbidden');
  assert.equal(canManageAccess(owner), true);
  assert.equal(canManageAccess(delegated), false);
  assert.equal(code(() => requireAccessManagement(proposer)), 'owner_required');
  assert.equal(code(() => requireAccessManagement({ ...owner, revokedAt: new Date() })), 'forbidden');
  const noScopes: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: null, details: {} };
  const noDetails: AuthorizableActor = { kind: 'agent_token', authority: null, revokedAt: null };
  for (const t of [noScopes, noDetails]) {
    assert.equal(can(t, 'read'), false, 'no scopes array means no scopes');
    assert.equal(code(() => requireCapability(t, 'read')), 'forbidden');
  }
});

test('config: local-signin needs a session secret of at least 32 characters; bootstrap password and login are validated', () => {
  const base = { DATABASE_URL: 'postgres://x@localhost/x' };
  const secret = { POII_SESSION_SECRET: 's'.repeat(32) };
  const signin = { ...base, ...secret, POII_IDENTITY_ADAPTER: 'local-signin' };
  assert.equal(config(signin).identityAdapter, 'local-signin');
  assert.equal(config(base).auth.ownerLogin, 'owner');
  assert.equal(config(base).auth.sessionTtlHours, 336);
  assert.equal(config(base).auth.apiBaseUrl, 'http://localhost:3001');
  assert.equal(config({ ...base, POII_API_BASE_URL: 'https://api.example.test/' }).auth.apiBaseUrl, 'https://api.example.test');
  assert.throws(() => config({ ...base, POII_API_BASE_URL: 'https://api.example.test/v1' }), /POII_API_BASE_URL/);
  assert.equal(config(base).auth.sessionSecret, undefined, 'local-owner does not need one');
  assert.throws(() => config({ ...base, POII_IDENTITY_ADAPTER: 'local-signin' }), /POII_SESSION_SECRET/);
  assert.throws(() => config({ ...signin, POII_SESSION_SECRET: 's'.repeat(31) }), /at least 32/);
  assert.throws(() => config({ ...signin, POII_OWNER_BOOTSTRAP_PASSWORD: 'short' }), /12 to 128/);
  assert.throws(() => config({ ...signin, POII_OWNER_BOOTSTRAP_PASSWORD: 'x'.repeat(129) }), /12 to 128/);
  assert.throws(() => config({ ...base, POII_OWNER_LOGIN: 'ow' }), /POII_OWNER_LOGIN/);
  assert.throws(() => config({ ...base, POII_OWNER_LOGIN: 'owner@example' }), /POII_OWNER_LOGIN/);
  assert.throws(() => config({ ...signin, BETTER_AUTH_TELEMETRY: '1' }), /telemetry/);
  assert.equal(config({ ...signin, BETTER_AUTH_TELEMETRY: 'false' }).identityAdapter, 'local-signin');
  assert.throws(() => config({ ...base, POII_IDENTITY_ADAPTER: 'oidc' }), /Unsupported/);
});
