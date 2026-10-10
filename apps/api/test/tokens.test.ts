// Integration tests of owner tokens through real HTTP (ADR-0004, ADR-0009): create, list, revoke, the scope
// matrix on every route class, expiry and immediate revocation, under both identity adapters. Fresh database
// per suite, dropped afterwards. Nothing is mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { CreatedTokenResponse, MeResponse, RecordDetail, TokenView } from '@poii/contracts';
import { eq, sql } from 'drizzle-orm';
import { approval, ownerToken } from '../src/db/schema/index.js';
import { DAY, fromNow, session, startApiWith, startSigninApi, type Browserish } from './auth-helpers.js';
import { createFreshDatabase, skipIntegration, span, type TestApi } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('owner tokens with local-owner (integration)', { skip: skipIntegration }, () => {
  let database: Awaited<ReturnType<typeof createFreshDatabase>>;
  let api: TestApi;
  let owner: Browserish;

  before(async () => {
    database = await createFreshDatabase();
    api = await startApiWith(database.url);
    owner = session(api.base);
  });

  after(async () => {
    await api?.close();
    await database?.drop();
  });

  async function mint(name: string, scopes: Array<'read' | 'propose'>, expiresAt = fromNow(30 * DAY)) {
    const reply = await owner.post('/v1/tokens', { name, scopes, expiresAt });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return CreatedTokenResponse.parse(reply.body);
  }

  /** A confirmed decision and a candidate, both citing one source, created by the owner. */
  async function fixtureRecords(tag: string) {
    const content = `Token fixture ${tag}\nWe decided to keep the queue.\nMaybe we drop the cache.\n`;
    const source = await owner.post('/v1/sources', { title: `Fixture ${tag}`, kind: 'paste', content });
    assert.equal(source.status, 201);
    const make = async (needle: string) => {
      const r = await owner.post('/v1/records', {
        kind: 'decision', title: needle, statementMode: 'quoted', statedRole: 'owner',
        evidence: [{ sourceId: source.body.id, ...span(content, needle) }],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return RecordDetail.parse(r.body);
    };
    const confirmed = await make('We decided to keep the queue.');
    assert.equal((await owner.post(`/v1/records/${confirmed.id}/confirm`, {})).status, 200);
    const candidate = await make('Maybe we drop the cache.');
    return { sourceId: source.body.id as string, content, confirmed, candidate };
  }

  test('create shows the secret once; list never does; only its SHA-256 is stored', async () => {
    const created = await mint('CI reader', ['read']);
    assert.match(created.secret, /^poii_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.token.status, 'active');
    assert.deepEqual(created.token.scopes, ['read']);
    assert.equal(created.token.secretPrefix, created.secret.slice(0, 12));
    const list = await owner.get('/v1/tokens');
    assert.equal(list.status, 200);
    const views = (list.body as unknown[]).map(v => TokenView.parse(v));
    assert.ok(views.some(v => v.id === created.token.id));
    assert.ok(!JSON.stringify(list.body).includes(created.secret));
    const row = (await api.db.orm.select().from(ownerToken).where(eq(ownerToken.id, created.token.id)))[0]!;
    assert.equal(row.secretSha256, sha(created.secret));
    const leaked = await api.db.orm.execute(sql`SELECT count(*)::int AS n FROM owner_token WHERE row_to_json(owner_token)::text LIKE ${`%${created.secret}%`}`);
    assert.equal((leaked.rows[0] as { n: number }).n, 0);
  });

  test('token creation is validated and never replayed from the idempotency store (the secret is not kept)', async () => {
    assert.equal((await owner.post('/v1/tokens', { name: 'x', scopes: ['read'], expiresAt: fromNow(-DAY) })).body.error, 'invalid_expiry');
    assert.equal((await owner.post('/v1/tokens', { name: 'x', scopes: ['read'], expiresAt: fromNow(400 * DAY) })).body.error, 'invalid_expiry');
    assert.equal((await owner.post('/v1/tokens', { name: 'x', scopes: ['confirm'], expiresAt: fromNow(DAY) })).body.error, 'validation_failed');
    assert.equal((await owner.post('/v1/tokens', { name: 'x', scopes: [], expiresAt: fromNow(DAY) })).body.error, 'validation_failed');
    const key = `token-key-${Date.now()}`;
    const first = await owner.post('/v1/tokens', { name: 'idem', scopes: ['read'], expiresAt: fromNow(DAY) }, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    const stored = await api.db.orm.execute(sql`SELECT count(*)::int AS n FROM idempotency_key WHERE key LIKE ${`%:${key}`}`);
    assert.equal((stored.rows[0] as { n: number }).n, 0);
    // Express routes a trailing slash or other letter case to the same handler: still never stored.
    for (const [i, path] of ['/v1/tokens/', '/V1/Tokens', '/v1/tokens//'].entries()) {
      const variantKey = `${key}-variant-${i}`;
      const reply = await owner.post(path, { name: `idem ${i}`, scopes: ['read'], expiresAt: fromNow(DAY) }, { 'idempotency-key': variantKey });
      if (reply.status !== 201) continue; // a path variant Express does not route is fine too
      assert.ok(typeof reply.body.secret === 'string');
      const kept = await api.db.orm.execute(sql`SELECT count(*)::int AS n FROM idempotency_key WHERE key LIKE ${`%:${variantKey}`}`);
      assert.equal((kept.rows[0] as { n: number }).n, 0, path);
    }
    const trailing = await owner.post('/v1/tokens/', { name: 'trailing', scopes: ['read'], expiresAt: fromNow(DAY) }, { 'idempotency-key': `${key}-t` });
    assert.equal(trailing.status, 201, 'the trailing-slash route exists, so the check above was exercised');
  });

  test('read scope: reads sources, records, views, search and context packs; every write is 403', async () => {
    const { sourceId, candidate } = await fixtureRecords('read');
    const { secret } = await mint('reader', ['read']);
    const reader = session(api.base, { bearer: secret });
    const me = MeResponse.parse((await reader.get('/v1/me')).body);
    assert.equal(me.actor.kind, 'agent_token');
    assert.deepEqual(me.capabilities, { canConfirm: false, canDelete: false, canPropose: false });
    for (const path of ['/v1/sources', `/v1/sources/${sourceId}`, `/v1/sources/${sourceId}/records`, '/v1/records', `/v1/records/${candidate.id}`,
      '/v1/decisions/current', '/v1/search?q=queue', '/v1/exports', '/v1/actors']) {
      const r = await reader.get(path);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    }
    const pack = await reader.post('/v1/exports/context-pack', { reviewStates: ['confirmed'] });
    assert.ok(pack.status === 200 || pack.status === 201, JSON.stringify(pack.body));

    const scope = (r: { status: number; body: any }) => { assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body.error, 'scope_required'); };
    scope(await reader.post('/v1/sources', { title: 'nope', kind: 'paste', content: 'reader cannot write' }));
    scope(await reader.post('/v1/records', {
      kind: 'fact', title: 'nope', statementMode: 'quoted', statedRole: 'unknown', evidence: [{ sourceId, startChar: 0, endChar: 5 }],
    }));
    scope(await reader.patch(`/v1/records/${candidate.id}`, { title: 'renamed' }));
    scope(await reader.post('/v1/actors', { kind: 'person', displayName: 'nope' }));
  });

  test('propose scope: creates sources and candidates attributed to the token actor; never confirms, rejects, deletes, restores or changes policy', async () => {
    const { sourceId, confirmed, candidate } = await fixtureRecords('propose');
    const created = await mint('proposer', ['propose']);
    const agent = session(api.base, { bearer: created.secret });
    const me = MeResponse.parse((await agent.get('/v1/me')).body);
    assert.deepEqual(me.capabilities, { canConfirm: false, canDelete: false, canPropose: true });

    const content = `Agent proposal ${Date.now()}\nAdd a retry budget.\n`;
    const source = await agent.post('/v1/sources', { title: 'Agent source', kind: 'paste', content });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    assert.equal(source.body.createdByActorId, created.token.actorId);
    const proposal = await agent.post('/v1/records', {
      kind: 'decision', title: 'Retry budget', statementMode: 'quoted', statedRole: 'unknown',
      evidence: [{ sourceId: source.body.id, ...span(content, 'Add a retry budget.') }],
    });
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    assert.equal(proposal.body.reviewState, 'candidate');
    assert.equal(proposal.body.versions[0].changedByActorId, created.token.actorId);
    assert.equal((await agent.patch(`/v1/records/${proposal.body.id}`, { body: 'edited by the agent' })).status, 200);
    const successor = await agent.post(`/v1/records/${confirmed.id}/supersede`, {
      kind: 'decision', title: 'Drop the queue', statementMode: 'quoted', statedRole: 'unknown',
      evidence: [{ sourceId: source.body.id, ...span(content, 'Add a retry budget.') }],
    });
    assert.equal(successor.status, 201, 'proposing a successor is a candidate');

    const denied = (r: { status: number; body: any }, label: string) => {
      assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body)}`);
      assert.ok(['authority_required', 'owner_required', 'token_not_allowed'].includes(r.body.error), `${label}: ${r.body.error}`);
    };
    for (const id of [proposal.body.id, candidate.id, successor.body.id]) {
      denied(await agent.post(`/v1/records/${id}/confirm`, {}), 'confirm');
      denied(await agent.post(`/v1/records/${id}/confirm`, { antecedentRecordId: confirmed.id }), 'supersede-and-confirm');
      denied(await agent.post(`/v1/records/${id}/reject`, { reason: 'no' }), 'reject');
      denied(await agent.del(`/v1/records/${id}`), 'delete record');
    }
    denied(await agent.post(`/v1/records/${confirmed.id}/status`, { lifecycleStatus: 'implemented' }), 'status of a confirmed record');
    denied(await agent.patch(`/v1/records/${confirmed.id}`, { title: 'rewrite history' }), 'edit a confirmed record');
    denied(await agent.del(`/v1/sources/${sourceId}`, {}), 'delete source');
    denied(await agent.patch(`/v1/sources/${sourceId}`, { aiAllowed: false }), 'change aiAllowed');
    denied(await agent.patch(`/v1/sources/${sourceId}`, { archived: true }), 'archive');
    denied(await agent.post('/v1/restore', { backup: {} }), 'restore');
    denied(await agent.post('/v1/backup', {}), 'backup');
    denied(await agent.post('/v1/tokens', { name: 'child', scopes: ['read'], expiresAt: fromNow(DAY) }), 'create token');
    denied(await agent.get('/v1/tokens'), 'list tokens');
    denied(await agent.del(`/v1/tokens/${created.token.id}`), 'revoke token');
    // local-owner mounts no sign-in endpoints at all (the local-signin suite checks that a token is refused there).
    assert.equal((await agent.signIn()).status, 404, 'sign in');
    assert.equal((await agent.post('/v1/auth/revoke-sessions', {})).status, 404, 'revoke sessions');

    const approvals = await api.db.orm.select().from(approval).where(eq(approval.approvedByActorId, created.token.actorId));
    assert.equal(approvals.length, 0, 'no approval is ever created by a token actor');
    const still = RecordDetail.parse((await owner.get(`/v1/records/${proposal.body.id}`)).body);
    assert.equal(still.reviewState, 'candidate');
    // The owner confirms what the agent proposed.
    assert.equal((await owner.post(`/v1/records/${proposal.body.id}/confirm`, {})).status, 200);
  });

  test('revocation takes effect on the very next request', async () => {
    const created = await mint('short-lived', ['propose']);
    const agent = session(api.base, { bearer: created.secret });
    assert.equal((await agent.get('/v1/me')).status, 200);
    assert.equal((await owner.del(`/v1/tokens/${created.token.id}`)).status, 204);
    const after = await agent.get('/v1/me');
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'token_revoked');
    assert.equal((await agent.post('/v1/sources', { title: 'x', kind: 'paste', content: 'after revoke' })).status, 401);
    assert.equal((await owner.del(`/v1/tokens/${created.token.id}`)).status, 204, 'revoking twice is a no-op');
    const listed = (await owner.get('/v1/tokens')).body.find((t: { id: string }) => t.id === created.token.id);
    assert.equal(listed.status, 'revoked');
    assert.equal((await owner.del('/v1/tokens/00000000-0000-7000-8000-000000000000')).status, 404);
  });

  test('an expired token gets 401 token_expired', async () => {
    const created = await mint('expiring', ['read']);
    const agent = session(api.base, { bearer: created.secret });
    assert.equal((await agent.get('/v1/me')).status, 200);
    await api.db.orm.update(ownerToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(ownerToken.id, created.token.id));
    const reply = await agent.get('/v1/me');
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error, 'token_expired');
    const listed = (await owner.get('/v1/tokens')).body.find((t: { id: string }) => t.id === created.token.id);
    assert.equal(listed.status, 'expired');
  });

  test('a malformed or unknown Authorization header is 401 and never falls back to the owner', async () => {
    for (const value of [`Bearer poii_${'x'.repeat(43)}`, 'Bearer nonsense', 'Basic b3duZXI6cGFzcw==', 'Bearer']) {
      const r = await session(api.base).get('/v1/me', { authorization: value });
      assert.equal(r.status, 401, value);
      assert.equal(r.body.error, 'invalid_token');
    }
  });
});

describe('owner tokens with local-signin (integration)', { skip: skipIntegration }, () => {
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

  test('a signed-in owner creates a token; the token works without a session or CSRF header; signing out does not touch it', async () => {
    assert.equal((await session(api.base).post('/v1/tokens', { name: 'anon', scopes: ['read'], expiresAt: fromNow(DAY) })).status, 401);
    const owner = session(api.base);
    assert.equal((await owner.signIn()).status, 200);
    const created = await owner.post('/v1/tokens', { name: 'agent', scopes: ['propose'], expiresAt: fromNow(DAY) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { secret, token } = CreatedTokenResponse.parse(created.body);
    const agent = session(api.base, { bearer: secret, csrf: false });
    const me = MeResponse.parse((await agent.get('/v1/me')).body);
    assert.equal(me.actor.id, token.actorId);
    const source = await agent.post('/v1/sources', { title: 'From agent', kind: 'paste', content: `agent ${Date.now()}` });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    assert.equal((await agent.post('/v1/auth/revoke-sessions', {})).status, 403, 'a token cannot manage sessions');
    assert.equal((await owner.post('/v1/auth/revoke-sessions', {})).status, 200);
    assert.equal((await owner.get('/v1/me')).status, 401);
    assert.equal((await agent.get('/v1/me')).status, 200, 'tokens are separate from sign-in sessions');
    const owner2 = session(api.base);
    assert.equal((await owner2.signIn()).status, 200);
    assert.equal((await owner2.del(`/v1/tokens/${token.id}`)).status, 204);
    assert.equal((await agent.get('/v1/me')).status, 401);
  });
});

describe('owner tokens and restore (integration)', { skip: skipIntegration }, () => {
  test('an install whose only extra actors are owner tokens still accepts a restore; the tokens go with the replaced workspace', async () => {
    const origin = await createFreshDatabase();
    const target = await createFreshDatabase();
    const originApi = await startApiWith(origin.url);
    const targetApi = await startApiWith(target.url);
    try {
      const o = session(originApi.base);
      assert.equal((await o.post('/v1/sources', { title: 'Backed up', kind: 'paste', content: `restore me ${Date.now()}` })).status, 201);
      const backup = await o.post('/v1/backup', {});
      assert.equal(backup.status, 200, JSON.stringify(backup.body).slice(0, 300));

      const t = session(targetApi.base);
      const created = await t.post('/v1/tokens', { name: 'before restore', scopes: ['read'], expiresAt: fromNow(DAY) });
      assert.equal(created.status, 201);
      const { secret } = CreatedTokenResponse.parse(created.body);
      assert.equal((await session(targetApi.base, { bearer: secret }).get('/v1/me')).status, 200);

      const restored = await t.post('/v1/restore', { backup: backup.body });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      const rows = await targetApi.db.orm.select().from(ownerToken);
      assert.equal(rows.length, 0, 'tokens of the replaced bootstrap workspace are gone');
      assert.equal((await session(targetApi.base, { bearer: secret }).get('/v1/me')).status, 401);
      assert.equal((await t.get('/v1/sources')).body.length, 1);
    } finally {
      await originApi.close();
      await targetApi.close();
      await origin.drop();
      await target.drop();
    }
  });
});
