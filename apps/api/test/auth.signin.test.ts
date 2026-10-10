// Integration tests of the local-signin identity adapter (Better Auth) through real HTTP (ADR-0009). Each suite
// uses its own freshly created and migrated database, dropped afterwards. Nothing is mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MeResponse, SignInResponse } from '@poii/contracts';
import { count, eq, sql } from 'drizzle-orm';
import { BetterAuthIdentity, SYNTHETIC_OWNER_EMAIL } from '../src/adapters/better-auth.identity.js';
import { signInAdapter } from '../src/app.module.js';
import { actor, auditEvent, authAccount, authSession, authUser } from '../src/db/schema/index.js';
import { OWNER_PASSWORD, session, startApiWith, startSigninApi, WEB_ORIGIN } from './auth-helpers.js';
import { createFreshDatabase, skipIntegration, type TestApi } from './helpers.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const adapterOf = (api: TestApi): BetterAuthIdentity => {
  const adapter = signInAdapter(api.ports);
  assert.ok(adapter, 'local-signin is configured');
  return adapter;
};

describe('local sign-in with Better Auth (integration)', { skip: skipIntegration }, () => {
  let database: Awaited<ReturnType<typeof createFreshDatabase>>;
  let api: TestApi;

  before(async () => {
    database = await createFreshDatabase();
    api = await startSigninApi(database.url);
  });

  after(async () => {
    await api?.close();
    await database?.drop();
  });

  test('without a session every /v1 call is 401; health stays public; a forged cookie is refused', async () => {
    const anon = session(api.base);
    const me = await anon.get('/v1/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error, 'unauthenticated');
    assert.equal((await anon.get('/v1/sources')).status, 401);
    assert.equal((await anon.post('/v1/sources', { title: 'x', kind: 'paste', content: 'x' })).status, 401);
    assert.equal((await anon.get('/health/live')).status, 200);
    const forged = session(api.base);
    forged.cookie = `poii.session_token=${'A'.repeat(32)}.${'B'.repeat(43)}%3D`;
    assert.equal((await forged.get('/v1/me')).status, 401);
    const unsigned = session(api.base);
    unsigned.cookie = `poii.session_token=${'A'.repeat(32)}`;
    assert.equal((await unsigned.get('/v1/me')).status, 401);
  });

  test('bootstrap created exactly one Better Auth user, the owner, with a synthetic email and a hashed password', async () => {
    const users = await api.db.orm.select().from(authUser);
    assert.equal(users.length, 1);
    const user = users[0]!;
    assert.equal(user.username, 'owner');
    assert.equal(user.email, SYNTHETIC_OWNER_EMAIL);
    const owner = (await api.db.orm.select().from(actor).where(eq(actor.id, user.actorId!)))[0]!;
    assert.equal(owner.kind, 'person');
    assert.equal(owner.authority, 'owner');
    const accounts = await api.db.orm.select().from(authAccount).where(eq(authAccount.userId, user.id));
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.providerId, 'credential');
    assert.ok(accounts[0]!.password && !accounts[0]!.password.includes(OWNER_PASSWORD));
    assert.match(accounts[0]!.password!, /^[0-9a-f]+:[0-9a-f]+$/, "Better Auth's scrypt salt:key");
    assert.equal((await api.db.orm.select().from(authSession)).length, 0, 'the bootstrap leaves no session behind');
    const bootstrapped = await api.db.orm.select().from(auditEvent).where(eq(auditEvent.action, 'identity.owner_password_bootstrapped'));
    assert.equal(bootstrapped.length, 1);
  });

  test('sign-in with the right password sets an HttpOnly SameSite=Lax session cookie; /v1 then resolves the owner', async () => {
    const browser = session(api.base);
    const reply = await browser.signIn();
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const body = SignInResponse.parse(reply.body);
    const cookie = reply.headers.getSetCookie().find(c => c.startsWith('poii.session_token='))!;
    assert.ok(cookie, 'Better Auth session cookie with the poii prefix');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=1209600/, 'POII_SESSION_TTL_HOURS default 336 h');
    assert.doesNotMatch(cookie, /Secure/, 'loopback WEB_BASE_URL: no Secure flag so http://127.0.0.1 works');
    const me = MeResponse.parse((await browser.get('/v1/me')).body);
    assert.equal(me.actor.id, body.user.actorId);
    assert.equal(me.actor.authority, 'owner');
    assert.equal(me.capabilities.canConfirm, true);
    const signedIn = await api.db.orm.select().from(auditEvent).where(eq(auditEvent.action, 'auth.signed_in'));
    assert.ok(signedIn.length >= 1, 'sign-ins are audited');
  });

  test('wrong password and unknown username both fail with 401 and no cookie; the username is case-insensitive', async () => {
    const browser = session(api.base);
    const wrong = await browser.signIn('owner', 'not the password at all');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'INVALID_USERNAME_OR_PASSWORD');
    assert.equal(browser.cookie, undefined);
    const unknown = await session(api.base).signIn('nobody', OWNER_PASSWORD);
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.code, 'INVALID_USERNAME_OR_PASSWORD');
    assert.equal((await session(api.base).signIn('OWNER', OWNER_PASSWORD)).status, 200);
    assert.equal((await session(api.base).post('/v1/auth/sign-in/username', { username: 'owner' })).status, 400);
  });

  test('rate limit: the fourth sign-in attempt within 10 s from one address is refused, even with the right password', async () => {
    const address = '198.51.100.7';
    for (let i = 0; i < 3; i++) {
      assert.equal((await session(api.base, { address }).signIn('owner', `wrong password ${i}`)).status, 401);
    }
    const blocked = await session(api.base, { address }).signIn();
    assert.equal(blocked.status, 429);
    const retry = Number(blocked.headers.get('x-retry-after'));
    assert.ok(retry > 0 && retry <= 10, `X-Retry-After ${retry}`);
    assert.equal((await session(api.base, { address: '198.51.100.8' }).signIn()).status, 200, 'other addresses are unaffected');
  });

  test('CSRF on POII endpoints: cookie-authenticated changes need x-poii-csrf and are refused cross-site', async () => {
    const browser = session(api.base);
    assert.equal((await browser.signIn()).status, 200);
    const evilOrigin = await browser.post('/v1/sources', { title: 'csrf', kind: 'paste', content: 'csrf origin' }, { origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403);
    assert.equal(evilOrigin.body.error, 'csrf_rejected');
    const crossSite = await browser.post('/v1/sources', { title: 'csrf', kind: 'paste', content: 'csrf site' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const sameSite = await browser.post('/v1/sources', { title: 'csrf', kind: 'paste', content: 'csrf same' }, { 'sec-fetch-site': 'same-site' });
    assert.equal(sameSite.status, 403);

    // The same cookie without the header: reads work, changes do not (what a forged HTML form would send).
    const forgedForm = session(api.base, { csrf: false, origin: null });
    forgedForm.cookie = browser.cookie;
    assert.equal((await forgedForm.get('/v1/sources')).status, 200);
    const posted = await forgedForm.post('/v1/sources', { title: 'csrf', kind: 'paste', content: 'csrf missing header' });
    assert.equal(posted.status, 403);
    assert.equal(posted.body.error, 'csrf_rejected');

    const trusted = await browser.post('/v1/sources', { title: 'csrf ok', kind: 'paste', content: `csrf ok ${Date.now()}` });
    assert.equal(trusted.status, 201, JSON.stringify(trusted.body));
    assert.equal((await browser.del(`/v1/sources/${trusted.body.id}`, {})).status, 204);
  });

  test("Better Auth's Origin check: a cookie-carrying sign-out from another origin or without an Origin is refused", async () => {
    const browser = session(api.base);
    assert.equal((await browser.signIn()).status, 200);
    const foreign = await browser.post('/v1/auth/sign-out', {}, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 'INVALID_ORIGIN');
    const missing = session(api.base, { origin: null });
    missing.cookie = browser.cookie;
    const noOrigin = await missing.post('/v1/auth/sign-out', {});
    assert.equal(noOrigin.status, 403);
    assert.equal((await browser.get('/v1/me')).status, 200, 'the refused sign-outs did not end the session');
  });

  test('sign-out ends that session on the very next request; other sessions keep working', async () => {
    const laptop = session(api.base);
    const phone = session(api.base);
    assert.equal((await laptop.signIn()).status, 200);
    assert.equal((await phone.signIn()).status, 200);
    const laptopCookie = laptop.cookie;
    const out = await laptop.post('/v1/auth/sign-out', {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok(out.headers.getSetCookie().some(c => /^poii\.session_token=;/.test(c) && /Max-Age=0/.test(c)), 'cookie cleared');
    const replay = session(api.base);
    replay.cookie = laptopCookie;
    assert.equal((await replay.get('/v1/me')).status, 401, 'the old cookie is dead immediately');
    assert.equal((await phone.get('/v1/me')).status, 200);
  });

  test('revoke-sessions ends every session of the owner immediately', async () => {
    const a = session(api.base);
    const b = session(api.base);
    const c = session(api.base);
    for (const s of [a, b, c]) assert.equal((await s.signIn()).status, 200);
    const result = await b.post('/v1/auth/revoke-sessions', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    for (const s of [a, b, c]) assert.equal((await s.get('/v1/me')).status, 401);
    assert.equal((await api.db.orm.select({ n: count() }).from(authSession))[0]!.n, 0);
    assert.equal((await session(api.base).post('/v1/auth/revoke-sessions', {})).status, 401, 'needs a session');
    assert.equal((await api.db.orm.select().from(auditEvent).where(eq(auditEvent.action, 'auth.signed_out_all'))).length, 1, 'audited');
  });

  test('changing the password revokes the other sessions; the old password stops working', async () => {
    const keep = session(api.base);
    const other = session(api.base);
    assert.equal((await keep.signIn()).status, 200);
    assert.equal((await other.signIn()).status, 200);
    const newPassword = 'a different long passphrase';
    const wrongCurrent = await keep.post('/v1/auth/change-password', { currentPassword: 'wrong wrong wrong', newPassword, revokeOtherSessions: true });
    assert.equal(wrongCurrent.status, 400);
    assert.equal(wrongCurrent.body.code, 'INVALID_PASSWORD');
    const short = await keep.post('/v1/auth/change-password', { currentPassword: OWNER_PASSWORD, newPassword: 'short', revokeOtherSessions: true });
    assert.equal(short.status, 400);
    assert.equal(short.body.code, 'PASSWORD_TOO_SHORT');
    const changed = await keep.post('/v1/auth/change-password', { currentPassword: OWNER_PASSWORD, newPassword, revokeOtherSessions: true });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await keep.get('/v1/me')).status, 200, 'the changing browser received a fresh session');
    assert.equal((await other.get('/v1/me')).status, 401);
    assert.equal((await session(api.base).signIn('owner', OWNER_PASSWORD)).status, 401);
    assert.equal((await api.db.orm.select().from(auditEvent).where(eq(auditEvent.action, 'auth.password_changed'))).length, 1, 'audited');
    // Back to the bootstrap password for the remaining tests (from a fresh address: change-password is rate limited too).
    const again = session(api.base);
    assert.equal((await again.signIn('owner', newPassword)).status, 200);
    const back = await again.post('/v1/auth/change-password', { currentPassword: newPassword, newPassword: OWNER_PASSWORD, revokeOtherSessions: true });
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });

  test('HTTP sign-up is refused, Better Auth endpoints POII does not use answer 404, and a token never reaches Better Auth', async () => {
    const signUp = await session(api.base).post('/v1/auth/sign-up/email', {
      name: 'Intruder', email: 'intruder@example.test', password: 'a long enough password', username: 'intruder',
    });
    assert.equal(signUp.status, 403);
    assert.equal(signUp.body.code, 'SIGN_UP_DISABLED');
    assert.equal((await api.db.orm.select({ n: count() }).from(authUser))[0]!.n, 1);
    const byEmail = await session(api.base).post('/v1/auth/sign-in/email', { email: SYNTHETIC_OWNER_EMAIL, password: OWNER_PASSWORD });
    assert.equal(byEmail.status, 404, 'the synthetic email is never a way in');
    for (const path of ['/v1/auth/update-user', '/v1/auth/request-password-reset', '/v1/auth/delete-user', '/v1/auth/is-username-available']) {
      assert.equal((await session(api.base).post(path, {})).status, 404, path);
    }
    const asToken = session(api.base, { bearer: `poii_${'a'.repeat(43)}` });
    const tokenSignIn = await asToken.signIn();
    assert.equal(tokenSignIn.status, 403);
    assert.equal(tokenSignIn.body.code, 'TOKEN_NOT_ALLOWED');
    assert.equal((await asToken.post('/v1/auth/revoke-sessions', {})).status, 403);
  });

  test('owner-only: a second Better Auth user cannot be created, server-side or in the database', async () => {
    await assert.rejects(
      adapterOf(api).auth.api.signUpEmail({ body: { name: 'Second', email: 'second@poii.invalid', password: 'another long password', username: 'second' } }),
      (error: { body?: { code?: string } }) => error.body?.code === 'OWNER_ONLY',
    );
    await assert.rejects(
      api.db.orm.insert(authUser).values({ id: 'second-user', name: 'Second', email: 'second@poii.invalid', username: 'second' }),
      (error: { cause?: { constraint?: string } }) => error.cause?.constraint === 'auth_user_single_owner',
    );
    assert.equal((await api.db.orm.select({ n: count() }).from(authUser))[0]!.n, 1);
  });

  test('the bootstrap password applies only while no user exists: a different value on a later start is ignored', async () => {
    const lines: string[] = [];
    const second = await startSigninApi(database.url, { POII_OWNER_BOOTSTRAP_PASSWORD: 'an attacker supplied value' });
    const original = console.info;
    console.info = (line: string) => { lines.push(line); };
    try {
      await adapterOf(second).ensureReady();
    } finally {
      console.info = original;
    }
    try {
      assert.ok(lines.some(l => l.includes('identity.bootstrap_password_ignored')), 'a warning asks to remove the variable');
      assert.equal((await session(second.base).signIn('owner', 'an attacker supplied value')).status, 401);
      assert.equal((await session(second.base).signIn()).status, 200);
      assert.equal((await second.db.orm.select({ n: count() }).from(authUser))[0]!.n, 1);
    } finally {
      await second.close();
    }
  });

  test('a session expires after POII_SESSION_TTL_HOURS (absolute lifetime)', async () => {
    const shortLived = await startSigninApi(database.url, { POII_SESSION_TTL_HOURS: String(2 / 3600) });
    try {
      const browser = session(shortLived.base);
      const reply = await browser.signIn();
      assert.equal(reply.status, 200);
      assert.match(reply.headers.getSetCookie().join('\n'), /Max-Age=2;/);
      assert.equal((await browser.get('/v1/me')).status, 200);
      await sleep(2500);
      assert.equal((await browser.get('/v1/me')).status, 401);
    } finally {
      await shortLived.close();
    }
  });
});

describe('local sign-in configuration (integration)', { skip: skipIntegration }, () => {
  test('without a bootstrap password sign-in answers 409 SIGNIN_NOT_CONFIGURED and no user exists', async () => {
    const database = await createFreshDatabase();
    const api = await startSigninApi(database.url, { POII_OWNER_BOOTSTRAP_PASSWORD: '' });
    try {
      const reply = await session(api.base).signIn();
      assert.equal(reply.status, 409);
      assert.equal(reply.body.code, 'SIGNIN_NOT_CONFIGURED');
      assert.equal((await api.db.orm.select({ n: count() }).from(authUser))[0]!.n, 0);
    } finally {
      await api.close();
      await database.drop();
    }
  });

  test('a non-loopback WEB_BASE_URL makes the cookie __Secure- prefixed and Secure, and only that origin is trusted', async () => {
    const database = await createFreshDatabase();
    const web = 'https://poii.example.test';
    const api = await startSigninApi(database.url, { WEB_BASE_URL: web });
    try {
      const browser = session(api.base, { origin: web });
      const reply = await browser.signIn('owner', OWNER_PASSWORD);
      assert.equal(reply.status, 200);
      const cookie = reply.headers.getSetCookie().find(c => c.startsWith('__Secure-poii.session_token='));
      assert.ok(cookie, 'secure cookie name');
      assert.match(cookie, /; Secure/);
      assert.equal(reply.headers.getSetCookie().some(c => c.startsWith('poii.session_token=')), false);
      const ok = await browser.post('/v1/actors', { kind: 'person', displayName: 'Origin check' });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const bad = await browser.post('/v1/actors', { kind: 'person', displayName: 'Origin check' }, { origin: WEB_ORIGIN });
      assert.equal(bad.status, 403);
      const signOutFromLoopback = await browser.post('/v1/auth/sign-out', {}, { origin: WEB_ORIGIN });
      assert.equal(signOutFromLoopback.status, 403, 'Better Auth trusts only the configured web origin');
    } finally {
      await api.close();
      await database.drop();
    }
  });

  test('local-signin refuses to start without a POII_SESSION_SECRET of at least 32 characters', async () => {
    const database = await createFreshDatabase();
    try {
      await assert.rejects(startSigninApi(database.url, { POII_SESSION_SECRET: '' }), /POII_SESSION_SECRET/);
      await assert.rejects(startSigninApi(database.url, { POII_SESSION_SECRET: 'x'.repeat(31) }), /POII_SESSION_SECRET/);
    } finally {
      await database.drop();
    }
  });

  test('local-owner mounts no sign-in endpoints and keeps answering /v1/me without a session', async () => {
    const database = await createFreshDatabase();
    const api = await startApiWith(database.url);
    try {
      const anon = session(api.base);
      assert.equal((await anon.get('/v1/me')).status, 200);
      assert.equal((await anon.signIn()).status, 404);
      assert.equal((await anon.post('/v1/auth/sign-out', {})).status, 404);
    } finally {
      await api.close();
      await database.drop();
    }
  });
});

describe('local sign-in and restore (integration)', { skip: skipIntegration }, () => {
  test('after a restore replaced the owner actor, the signed-in session is re-attached to the restored owner', async () => {
    const origin = await createFreshDatabase();
    const target = await createFreshDatabase();
    const originApi = await startApiWith(origin.url);
    const targetApi = await startSigninApi(target.url);
    try {
      const o = session(originApi.base);
      assert.equal((await o.post('/v1/sources', { title: 'Backed up', kind: 'paste', content: `restore me ${Date.now()}` })).status, 201);
      const backup = await o.post('/v1/backup', {});
      assert.equal(backup.status, 200);
      const restoredOwner = (backup.body.actors as Array<{ id: string; kind: string; authority: string | null }>)
        .find(a => a.kind === 'person' && a.authority === 'owner')!;

      const browser = session(targetApi.base);
      assert.equal((await browser.signIn()).status, 200);
      const before = MeResponse.parse((await browser.get('/v1/me')).body);
      assert.notEqual(before.actor.id, restoredOwner.id);
      const restored = await browser.post('/v1/restore', { backup: backup.body });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));

      const user = (await targetApi.db.orm.select().from(authUser))[0]!;
      assert.equal(user.actorId, null, 'the replaced owner actor is gone (ON DELETE SET NULL)');
      const me = MeResponse.parse((await browser.get('/v1/me')).body);
      assert.equal(me.actor.id, restoredOwner.id, 're-attached to the restored owner');
      assert.equal((await targetApi.db.orm.select().from(authUser))[0]!.actorId, restoredOwner.id);
      const reattached = await targetApi.db.orm.select().from(auditEvent).where(eq(auditEvent.action, 'identity.credential_reattached'));
      assert.equal(reattached.length, 1);
      assert.equal((await browser.get('/v1/sources')).body.length, 1);
      // A fresh sign-in lands on the restored owner too.
      const fresh = session(targetApi.base);
      assert.equal((await fresh.signIn()).status, 200);
      assert.equal(MeResponse.parse((await fresh.get('/v1/me')).body).actor.id, restoredOwner.id);
    } finally {
      await originApi.close();
      await targetApi.close();
      await origin.drop();
      await target.drop();
    }
  });
});

// Last in this file: it uses the socket address 127.0.0.1, whose rate-limit bucket is shared in this process.
describe('local sign-in without a trusted proxy (integration)', { skip: skipIntegration }, () => {
  test('X-Forwarded-For is ignored: every attempt from this socket shares one rate-limit bucket', async () => {
    const database = await createFreshDatabase();
    const api = await startSigninApi(database.url, { POII_TRUST_PROXY: 'false' });
    try {
      for (let i = 0; i < 3; i++) {
        const reply = await session(api.base, { address: `192.0.2.${i + 1}` }).signIn('owner', `wrong password ${i}`);
        assert.equal(reply.status, 401);
      }
      const fourth = await session(api.base, { address: '192.0.2.99' }).signIn();
      assert.equal(fourth.status, 429, 'a spoofed X-Forwarded-For does not escape the limit');
      const sessions = await api.db.orm.execute(sql`SELECT count(*)::int AS n FROM auth_session`);
      assert.equal((sessions.rows[0] as { n: number }).n, 0);
    } finally {
      await api.close();
      await database.drop();
    }
  });
});
