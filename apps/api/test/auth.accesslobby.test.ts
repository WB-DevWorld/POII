// Integration tests of AccessLobby sign-in, explicit linking, sign-out and back-channel logout (ADR-0012) through
// real HTTP against a fresh, migrated database. AccessLobby itself is MOCKED (test/accesslobby-mock.ts): a local
// OIDC provider with a generated RSA key. Nothing in POII is mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MeResponse } from '@poii/contracts';
import { count, eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { accessLobbySession, actor, auditEvent, authAccount, authSession, authUser, identityLink } from '../src/db/schema/index.js';
import { startMockAccessLobby, type MockAccessLobby, type MockLogin } from './accesslobby-mock.js';
import { OWNER_PASSWORD, session, startSigninApi, WEB_ORIGIN, type Browserish } from './auth-helpers.js';
import { createFreshDatabase, skipIntegration, type TestApi } from './helpers.js';

const CLIENT_ID = 'poii-test';
const REDIRECT_URI = `${WEB_ORIGIN}/signin/accesslobby/callback`;
const SIGNED_OUT_URI = `${WEB_ORIGIN}/signin/accesslobby/signed-out`;

const LOGIN_A: MockLogin = { sub: 'subject-a', personId: '0b0e5a51-0000-4000-8000-00000000000a', sid: 'issuer-session-1' };

/** What AccessLobby posts to the backchannel endpoint: a form body, no cookie, no Origin, no CSRF header. */
async function backchannel(base: string, logoutToken: string, form = true) {
  const response = await fetch(`${base}/v1/auth/accesslobby/backchannel-logout`, form
    ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: logoutToken }) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logout_token: logoutToken }) });
  return { status: response.status, body: await response.text(), cacheControl: response.headers.get('cache-control') };
}

describe('AccessLobby OIDC with explicit linking (integration; AccessLobby MOCKED)', { skip: skipIntegration }, () => {
  let database: Awaited<ReturnType<typeof createFreshDatabase>>;
  let api: TestApi;
  let mock: MockAccessLobby;

  /** Starts a flow from `browser`, lets the MOCKED AccessLobby sign `login` in, and posts the callback like the web app does. */
  async function flow(browser: Browserish, intent: 'sign-in' | 'link', login: MockLogin, tweak: Record<string, string> = {}) {
    const started = await browser.post(`/v1/auth/accesslobby/${intent}`, intent === 'sign-in' ? { next: '/records' } : {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    return finish(browser, started.body, login, tweak);
  }

  async function finish(browser: Browserish, started: { url: string; binding: string }, login: MockLogin, tweak: Record<string, string> = {}) {
    mock.nextLogin = login;
    const back = await mock.authorize(started.url);
    return browser.post('/v1/auth/accesslobby/callback', { code: back.code, state: back.state, iss: back.iss, binding: started.binding, ...tweak });
  }

  const ownerUser = async () => (await api.db.orm.select().from(authUser))[0]!;
  const links = () => api.db.orm.select().from(identityLink);
  const sessionCount = async () => (await api.db.orm.select({ n: count() }).from(authSession))[0]!.n;
  const audits = (action: string) => api.db.orm.select().from(auditEvent).where(eq(auditEvent.action, action));

  before(async () => {
    database = await createFreshDatabase();
    mock = await startMockAccessLobby({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
    api = await startSigninApi(database.url, {
      POII_ACCESSLOBBY_ISSUER: mock.issuer, POII_ACCESSLOBBY_CLIENT_ID: CLIENT_ID, POII_ACCESSLOBBY_API_URL: mock.base,
    });
  });

  after(async () => {
    await api?.close();
    await mock?.close();
    await database?.drop();
  });

  test('status is public; the authorization request is code + PKCE S256 with state, nonce, scope openid and the exact redirect URI', async () => {
    const status = await session(api.base).get('/v1/auth/accesslobby/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { enabled: true, signedIn: false, link: null, sessionVia: null });
    const started = await session(api.base).post('/v1/auth/accesslobby/sign-in', { next: '/records' });
    assert.equal(started.status, 200);
    const url = new URL(started.body.url);
    assert.equal(url.origin + url.pathname, `${mock.issuer}/protocol/openid-connect/auth`);
    const q = url.searchParams;
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), CLIENT_ID);
    assert.equal(q.get('redirect_uri'), REDIRECT_URI);
    assert.equal(q.get('scope'), 'openid');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.ok((q.get('state') ?? '').length >= 43 && (q.get('nonce') ?? '').length >= 43);
    assert.equal(q.get('prompt'), null, 'sign-in does not force a fresh AccessLobby login');
    assert.match(started.body.binding, /^[A-Za-z0-9_-]{43}$/);
  });

  test('sign-in with an AccessLobby identity that is not linked is refused (403 NOT_LINKED) and creates nothing', async () => {
    const browser = session(api.base);
    const reply = await flow(browser, 'sign-in', LOGIN_A);
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, 'NOT_LINKED');
    assert.equal(browser.cookie, undefined, 'no session cookie');
    assert.equal((await api.db.orm.select({ n: count() }).from(authUser))[0]!.n, 1);
    assert.equal((await api.db.orm.select({ n: count() }).from(authAccount))[0]!.n, 1, 'only the password account');
    assert.equal((await links()).length, 0);
    assert.equal(await sessionCount(), 0);
    assert.equal((await audits('identity.accesslobby_signin_refused')).length, 1);
  });

  test('no email-based auto-link: an AccessLobby identity with the owner user\'s email but another sub is refused', async () => {
    const owner = await ownerUser();
    const sameEmail: MockLogin = { sub: 'subject-email', personId: '0b0e5a51-0000-4000-8000-0000000000e1', email: owner.email };
    const reply = await flow(session(api.base), 'sign-in', sameEmail);
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, 'NOT_LINKED');
    assert.equal((await links()).length, 0);
    assert.equal((await api.db.orm.select({ n: count() }).from(authAccount))[0]!.n, 1);
  });

  test('a callback needs the flow\'s browser binding, is single use, and must come from our issuer', async () => {
    const browser = session(api.base);
    const started = (await browser.post('/v1/auth/accesslobby/sign-in', {})).body;
    const wrongBinding = await finish(browser, { ...started, binding: 'x'.repeat(43) }, LOGIN_A);
    assert.equal(wrongBinding.status, 400);
    assert.equal(wrongBinding.body.code, 'INVALID_FLOW');
    // The state is single use: the failed attempt consumed it, so even the right binding cannot reuse it.
    const replay = await finish(browser, started, LOGIN_A);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.code, 'INVALID_FLOW');
    const other = (await browser.post('/v1/auth/accesslobby/sign-in', {})).body;
    const mixedUp = await finish(browser, other, LOGIN_A, { iss: 'https://evil.example/realms/x' });
    assert.equal(mixedUp.status, 400);
    assert.equal(mixedUp.body.code, 'ISSUER_MISMATCH');
    const denied = (await browser.post('/v1/auth/accesslobby/sign-in', {})).body;
    const cancelled = await browser.post('/v1/auth/accesslobby/callback', { state: new URL(denied.url).searchParams.get('state'), binding: denied.binding, error: 'access_denied' });
    assert.equal(cancelled.status, 400);
    assert.equal(cancelled.body.code, 'ACCESSLOBBY_DENIED');
  });

  test('an ID token with a wrong nonce is refused', async () => {
    mock.idTokenOverrides = { nonce: 'not-the-flow-nonce' };
    const reply = await flow(session(api.base), 'sign-in', LOGIN_A);
    assert.equal(reply.status, 400);
    assert.equal(reply.body.code, 'INVALID_ID_TOKEN');
  });

  test('linking needs a signed-in session, and the callback must arrive in that same session', async () => {
    assert.equal((await session(api.base).post('/v1/auth/accesslobby/link', {})).status, 401);
    const owner = session(api.base);
    assert.equal((await owner.signIn()).status, 200);
    const started = (await owner.post('/v1/auth/accesslobby/link', {})).body;
    // Another browser with another valid owner session presents the flow: not both proofs in one session.
    const other = session(api.base);
    assert.equal((await other.signIn()).status, 200);
    const reply = await finish(other, started, LOGIN_A);
    assert.equal(reply.status, 401);
    assert.equal(reply.body.code, 'LINK_SESSION_MISMATCH');
    assert.equal((await links()).length, 0);
  });

  test('link from a password session stores issuer, sub, person.id and the owner actor; a second link of the same person is refused', async () => {
    const owner = session(api.base);
    assert.equal((await owner.signIn()).status, 200);
    // Two connect attempts started while nothing is linked; the first wins.
    const first = (await owner.post('/v1/auth/accesslobby/link', {})).body;
    const second = (await owner.post('/v1/auth/accesslobby/link', {})).body;
    const linked = await finish(owner, first, LOGIN_A);
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(linked.body, { intent: 'link' });
    assert.equal(mock.lastAuthorize?.get('prompt'), 'login', 'linking proves the AccessLobby account with a fresh login');

    const rows = await links();
    assert.equal(rows.length, 1);
    const user = await ownerUser();
    assert.equal(rows[0]!.issuer, mock.issuer);
    assert.equal(rows[0]!.subject, LOGIN_A.sub);
    assert.equal(rows[0]!.personId, LOGIN_A.personId);
    assert.equal(rows[0]!.authUserId, user.id);
    assert.equal(rows[0]!.actorId, user.actorId);
    assert.equal((await audits('identity.accesslobby_linked')).length, 1);

    const samePerson = await finish(owner, second, { sub: 'subject-b', personId: LOGIN_A.personId });
    assert.equal(samePerson.status, 409);
    assert.equal(samePerson.body.code, 'PERSON_ALREADY_LINKED');
    assert.equal((await owner.post('/v1/auth/accesslobby/link', {})).body.code, 'ALREADY_LINKED', 'connect is refused once linked');
    assert.equal((await links()).length, 1);

    const status = await owner.get('/v1/auth/accesslobby/status');
    assert.equal(status.body.link.personId, LOGIN_A.personId);
    assert.equal(status.body.sessionVia, 'password');
    // The password session that linked keeps working.
    assert.equal((await owner.get('/v1/me')).status, 200);
  });

  test('the unique indexes hold in the database: (issuer, sub) and person.id are linked at most once', async () => {
    const user = await ownerUser();
    await assert.rejects(
      api.db.orm.insert(identityLink).values({ id: crypto.randomUUID(), issuer: mock.issuer, subject: LOGIN_A.sub, personId: 'another-person', authUserId: user.id }),
      (error: { cause?: { code?: string } }) => error.cause?.code === '23505',
    );
  });

  test('sign-in after linking resolves to the owner actor and records the AccessLobby session', async () => {
    const browser = session(api.base);
    const reply = await flow(browser, 'sign-in', LOGIN_A);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body, { intent: 'signin', next: '/records' });
    assert.ok(browser.cookie?.startsWith('poii.session_token='), 'Better Auth session cookie');
    const me = MeResponse.parse((await browser.get('/v1/me')).body);
    const user = await ownerUser();
    assert.equal(me.actor.id, user.actorId);
    assert.equal(me.actor.authority, 'owner');
    const status = await browser.get('/v1/auth/accesslobby/status');
    assert.equal(status.body.sessionVia, 'accesslobby');
    const recorded = await api.db.orm.select().from(accessLobbySession);
    assert.ok(recorded.some(r => r.subject === LOGIN_A.sub && r.sid === LOGIN_A.sid && r.idToken === mock.issuedIdTokens.at(-1)));
    assert.ok((await audits('auth.signed_in')).some(a => (a.details as { method?: string }).method === 'accesslobby'));
    assert.equal((await api.db.orm.select({ n: count() }).from(authUser))[0]!.n, 1);
  });

  test('a linked sub for which AccessLobby now reports another person.id is refused (IDENTITY_CONFLICT)', async () => {
    const reply = await flow(session(api.base), 'sign-in', { ...LOGIN_A, personId: '0b0e5a51-0000-4000-8000-0000000000ff' });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'IDENTITY_CONFLICT');
  });

  test('a suspended AccessLobby person is refused', async () => {
    const reply = await flow(session(api.base), 'sign-in', { ...LOGIN_A, suspended: true });
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, 'PERSON_SUSPENDED');
  });

  test('back-channel logout: invalid tokens answer 400 and revoke nothing; a valid one revokes every session of the linked user', async () => {
    const viaAccessLobby = session(api.base);
    assert.equal((await flow(viaAccessLobby, 'sign-in', LOGIN_A)).status, 200);
    const viaPassword = session(api.base);
    assert.equal((await viaPassword.signIn()).status, 200);
    const before = await sessionCount();
    assert.ok(before >= 2);

    const now = Math.floor(Date.now() / 1000);
    const bad = {
      signature: await mock.logoutToken({ sub: LOGIN_A.sub }, { foreignKey: true }),
      audience: await mock.logoutToken({ sub: LOGIN_A.sub, aud: 'another-client' }),
      issuer: await mock.logoutToken({ sub: LOGIN_A.sub, iss: 'https://evil.example/realms/x' }),
      noEvents: await mock.logoutToken({ sub: LOGIN_A.sub, events: undefined }),
      wrongEvent: await mock.logoutToken({ sub: LOGIN_A.sub, events: { 'http://example.com/other': {} } }),
      extraEvent: await mock.logoutToken({ sub: LOGIN_A.sub, events: { 'http://schemas.openid.net/event/backchannel-logout': {}, x: {} } }),
      nonce: await mock.logoutToken({ sub: LOGIN_A.sub, nonce: 'n' }),
      noSubOrSid: await mock.logoutToken({}),
      noJti: await mock.logoutToken({ sub: LOGIN_A.sub, jti: undefined }),
      noIat: await mock.logoutToken({ sub: LOGIN_A.sub, iat: undefined }),
      tooOld: await mock.logoutToken({ sub: LOGIN_A.sub, iat: now - 600, exp: now + 60 }),
      garbage: 'not.a.jwt',
    };
    for (const [name, token] of Object.entries(bad)) {
      const reply = await backchannel(api.base, token);
      assert.equal(reply.status, 400, `${name}: ${reply.body}`);
      assert.match(reply.body, /INVALID_LOGOUT_TOKEN/, name);
    }
    assert.equal((await backchannel(api.base, '')).status, 400, 'missing token');
    assert.equal(await sessionCount(), before, 'nothing was revoked');
    assert.equal((await viaPassword.get('/v1/me')).status, 200);

    // An unknown subject gets the same 200 and revokes nothing (no oracle for which subjects exist).
    const unknown = await backchannel(api.base, await mock.logoutToken({ sub: 'nobody-here' }));
    assert.equal(unknown.status, 200);
    assert.equal(await sessionCount(), before);

    const valid = await mock.logoutToken({ sub: LOGIN_A.sub, sid: LOGIN_A.sid });
    const reply = await backchannel(api.base, valid);
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.cacheControl, 'no-store');
    assert.equal((await viaAccessLobby.get('/v1/me')).status, 401);
    assert.equal((await viaPassword.get('/v1/me')).status, 401, 'every session of the linked user ends');
    assert.equal(await sessionCount(), 0);
    assert.equal((await audits('identity.accesslobby_backchannel_logout')).length, 1);

    // The same token again is a replay: refused, and it cannot end sessions created since.
    const fresh = session(api.base);
    assert.equal((await fresh.signIn()).status, 200);
    assert.equal((await backchannel(api.base, valid)).status, 400);
    assert.equal((await fresh.get('/v1/me')).status, 200);

    // A sid-only token (JSON body, as the web relay sends it) ends the sessions of the user that sid belongs to.
    const again = session(api.base);
    assert.equal((await flow(again, 'sign-in', { ...LOGIN_A, sid: 'issuer-session-2' })).status, 200);
    const bySid = await backchannel(api.base, await mock.logoutToken({ sid: 'issuer-session-2' }), false);
    assert.equal(bySid.status, 200, bySid.body);
    assert.equal((await again.get('/v1/me')).status, 401);
    assert.equal((await fresh.get('/v1/me')).status, 401);
  });

  test('"all connected apps" ends every POII session and returns AccessLobby\'s end-session URL with id_token_hint', async () => {
    const browser = session(api.base);
    assert.equal((await flow(browser, 'sign-in', LOGIN_A)).status, 200);
    const idToken = mock.issuedIdTokens.at(-1)!;
    const laptop = session(api.base);
    assert.equal((await laptop.signIn()).status, 200);
    const reply = await browser.post('/v1/auth/accesslobby/sign-out-all', {});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const url = new URL(reply.body.endSessionUrl);
    assert.equal(url.origin + url.pathname, `${mock.issuer}/protocol/openid-connect/logout`);
    assert.equal(url.searchParams.get('id_token_hint'), idToken);
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), SIGNED_OUT_URI);
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(browser.cookie, undefined, 'cookie cleared');
    assert.equal((await browser.get('/v1/me')).status, 401);
    assert.equal((await laptop.get('/v1/me')).status, 401);
    assert.equal(await sessionCount(), 0);
    // From a password session there is no ID token: the URL still names the client and the post-logout URI.
    const password = session(api.base);
    assert.equal((await password.signIn()).status, 200);
    const plain = new URL((await password.post('/v1/auth/accesslobby/sign-out-all', {})).body.endSessionUrl);
    assert.equal(plain.searchParams.get('id_token_hint'), null);
    assert.equal(plain.searchParams.get('client_id'), CLIENT_ID);
    assert.equal((await session(api.base).post('/v1/auth/accesslobby/sign-out-all', {})).status, 401);
  });

  test('AccessLobby down: the AccessLobby button fails with a clear 503 and nothing changes; password sign-in still works', async () => {
    mock.down = true;
    try {
      const signIn = await session(api.base).post('/v1/auth/accesslobby/sign-in', {});
      assert.equal(signIn.status, 503);
      assert.equal(signIn.body.code, 'ACCESSLOBBY_UNAVAILABLE');
      assert.match(signIn.body.message, /cannot be reached/);
      const owner = session(api.base);
      assert.equal((await owner.signIn()).status, 200, 'the password path is unchanged');
      assert.equal((await owner.get('/v1/me')).status, 200);
      assert.equal((await owner.post('/v1/auth/accesslobby/link', {})).status, 409, 'already linked is still answered locally');
      const out = await owner.post('/v1/auth/accesslobby/sign-out-all', {});
      assert.equal(out.status, 200, 'POII still signs out');
      assert.equal(out.body.endSessionUrl, null, 'no AccessLobby redirect while it is unreachable; the web app says so');
      assert.equal((await owner.get('/v1/me')).status, 401);
    } finally {
      mock.down = false;
    }
    // The identity API alone is down: the callback fails closed with the same clear error.
    mock.identityDown = true;
    try {
      const reply = await flow(session(api.base), 'sign-in', LOGIN_A);
      assert.equal(reply.status, 503);
      assert.equal(reply.body.code, 'ACCESSLOBBY_UNAVAILABLE');
    } finally {
      mock.identityDown = false;
    }
  });

  test('disconnect needs the local password; afterwards AccessLobby sign-in is refused again', async () => {
    const viaAccessLobby = session(api.base);
    assert.equal((await flow(viaAccessLobby, 'sign-in', LOGIN_A)).status, 200);
    const owner = session(api.base);
    assert.equal((await owner.signIn()).status, 200);
    assert.equal((await session(api.base).post('/v1/auth/accesslobby/unlink', { password: OWNER_PASSWORD })).status, 401);
    const wrong = await owner.post('/v1/auth/accesslobby/unlink', { password: 'not the password at all' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'INVALID_PASSWORD');
    assert.equal((await links()).length, 1);
    const done = await owner.post('/v1/auth/accesslobby/unlink', { password: OWNER_PASSWORD });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await links()).length, 0);
    assert.equal((await viaAccessLobby.get('/v1/me')).status, 401, 'sessions that came from AccessLobby end');
    assert.equal((await owner.get('/v1/me')).status, 200, 'the password session stays');
    assert.equal((await audits('identity.accesslobby_unlinked')).length, 1);
    assert.equal((await owner.post('/v1/auth/accesslobby/unlink', { password: OWNER_PASSWORD })).body.code, 'NO_LINK');
    const refused = await flow(session(api.base), 'sign-in', LOGIN_A);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'NOT_LINKED');
    // The owner actor is untouched by all of this.
    const user = await ownerUser();
    assert.equal((await api.db.orm.select().from(actor).where(eq(actor.id, user.actorId!))).length, 1);
  });
});

describe('AccessLobby configuration', () => {
  const base = { DATABASE_URL: 'postgres://unused', WEB_BASE_URL: 'http://localhost:3000' };
  const signin = { ...base, POII_IDENTITY_ADAPTER: 'local-signin', POII_SESSION_SECRET: 's'.repeat(32) };
  const accesslobby = { POII_ACCESSLOBBY_ISSUER: 'https://lobby.example.test/realms/first-party', POII_ACCESSLOBBY_CLIENT_ID: 'poii', POII_ACCESSLOBBY_API_URL: 'https://api.lobby.example.test' };

  test('off by default; on with issuer, client ID and API URL; derived web-origin URIs; public client unless a secret is set', () => {
    assert.equal(config(signin).accesslobby, null);
    const settings = config({ ...signin, ...accesslobby })!.accesslobby!;
    assert.equal(settings.issuer, accesslobby.POII_ACCESSLOBBY_ISSUER);
    assert.equal(settings.redirectUri, 'http://localhost:3000/signin/accesslobby/callback');
    assert.equal(settings.postLogoutRedirectUri, 'http://localhost:3000/signin/accesslobby/signed-out');
    assert.equal(settings.apiAudience, 'accesslobby-api');
    assert.deepEqual(settings.scopes, ['openid']);
    assert.equal(settings.clientSecret, undefined);
  });

  test('refused: under local-owner, without client ID or API URL, plain http off localhost, partial settings without an issuer', () => {
    assert.throws(() => config({ ...base, ...accesslobby }), /local-signin/);
    assert.throws(() => config({ ...signin, ...accesslobby, POII_ACCESSLOBBY_CLIENT_ID: '' }), /CLIENT_ID/);
    assert.throws(() => config({ ...signin, ...accesslobby, POII_ACCESSLOBBY_API_URL: '' }), /API_URL/);
    assert.throws(() => config({ ...signin, ...accesslobby, POII_ACCESSLOBBY_ISSUER: 'http://lobby.example.test/realms/x' }), /https/);
    assert.throws(() => config({ ...signin, POII_ACCESSLOBBY_CLIENT_ID: 'poii' }), /ISSUER/);
  });
});

describe('AccessLobby not configured (integration)', { skip: skipIntegration }, () => {
  test('the AccessLobby endpoints answer 404 under local-signin without an issuer', async () => {
    const database = await createFreshDatabase();
    const api = await startSigninApi(database.url);
    try {
      assert.equal((await session(api.base).get('/v1/auth/accesslobby/status')).status, 404);
      assert.equal((await session(api.base).post('/v1/auth/accesslobby/sign-in', {})).status, 404);
      assert.equal((await backchannel(api.base, 'x')).status, 404);
    } finally {
      await api.close();
      await database.drop();
    }
  });
});
