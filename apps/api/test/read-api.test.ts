// #18 read-only API for external clients: the X-POII-AI-Context header on every read endpoint, the span route,
// and that tokens still cannot write or confirm through any of it. Real HTTP against a fresh database with real
// owner tokens; nothing is mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  AI_CONTEXT_HEADER, AiCurrentDecision, AiRecordDetail, AiRecordSummary, CreatedTokenResponse, RecordDetail, SourceSpanView,
  WITHHELD_HEADER, WithheldRecord,
} from '@poii/contracts';
import { sql } from 'drizzle-orm';
import { DAY, fromNow, session, startApiWith, type Browserish } from './auth-helpers.js';
import { createFreshDatabase, nonce, skipIntegration, span, type TestApi } from './helpers.js';

const AI = { [AI_CONTEXT_HEADER]: '1' };
/** Appears only in the never-send source; must never appear in any AI-context reply. */
const SECRET = 'Zanzibarquokka';

describe('read-only API in AI context (integration)', { skip: skipIntegration }, () => {
  let database: Awaited<ReturnType<typeof createFreshDatabase>>;
  let api: TestApi;
  let owner: Browserish;
  let reader: Browserish;
  let proposer: Browserish;
  const aiBodies: string[] = [];
  const fx = {} as {
    allowedId: string; allowedRev: string; allowedText: string;
    neverId: string; neverRev: string; neverText: string; neverTitle: string;
    allowedRecord: RecordDetail; neverRecord: RecordDetail; mixedRecord: RecordDetail;
    aiPackId: string; personPackId: string;
  };

  /** A GET in AI context as the read token; every body is kept for the leak check at the end. */
  async function aiGet(path: string, who: Browserish = reader) {
    const reply = await who.get(path, AI);
    aiBodies.push(JSON.stringify(reply.body) + JSON.stringify([...reply.headers.entries()]));
    return reply;
  }

  async function mint(name: string, scopes: Array<'read' | 'propose'>) {
    const reply = await owner.post('/v1/tokens', { name, scopes, expiresAt: fromNow(30 * DAY) });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return CreatedTokenResponse.parse(reply.body).secret;
  }

  async function record(sources: Array<{ id: string; text: string; needle: string }>, title: string, confirm: boolean) {
    const r = await owner.post('/v1/records', {
      kind: 'decision', title, body: `Body of ${title}`, statementMode: 'quoted', statedRole: 'owner',
      evidence: sources.map((s, i) => ({ sourceId: s.id, ...span(s.text, s.needle), role: i === 0 ? 'primary' : 'supporting' })),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (confirm) assert.equal((await owner.post(`/v1/records/${r.body.id}/confirm`, {})).status, 200);
    return RecordDetail.parse((await owner.get(`/v1/records/${r.body.id}`)).body);
  }

  before(async () => {
    database = await createFreshDatabase();
    api = await startApiWith(database.url);
    owner = session(api.base);
    reader = session(api.base, { bearer: await mint('reader', ['read']) });
    proposer = session(api.base, { bearer: await mint('proposer', ['propose']) });
    const tag = nonce();
    fx.allowedText = `Allowed notes ${tag}\nWe keep the nightly backup window at 02:00.\nLine three.\n`;
    fx.neverText = `Private notes ${tag}\nThe ${SECRET} supplier contract renews in March.\n`;
    fx.neverTitle = `Never-send ${tag}`;
    const a = await owner.post('/v1/sources', { title: `Allowed ${tag}`, kind: 'paste', content: fx.allowedText });
    const n = await owner.post('/v1/sources', { title: fx.neverTitle, kind: 'paste', content: fx.neverText, aiAllowed: false });
    assert.equal(a.status, 201);
    assert.equal(n.status, 201);
    fx.allowedId = a.body.id;
    fx.allowedRev = a.body.currentRevision.id;
    fx.neverId = n.body.id;
    fx.neverRev = n.body.currentRevision.id;
    const allowed = { id: fx.allowedId, text: fx.allowedText, needle: 'We keep the nightly backup window at 02:00.' };
    const never = { id: fx.neverId, text: fx.neverText, needle: `The ${SECRET} supplier contract renews in March.` };
    fx.allowedRecord = await record([allowed], 'Backup window stays at 02:00', true);
    fx.neverRecord = await record([never], 'Supplier contract decision', true);
    fx.mixedRecord = await record([allowed, never], 'Mixed candidate', false);
    const aiPack = await owner.post('/v1/exports/context-pack', { destination: 'ai' });
    const personPack = await owner.post('/v1/exports/context-pack', { destination: 'person' });
    assert.equal(aiPack.status, 201, JSON.stringify(aiPack.body));
    assert.equal(personPack.status, 201);
    fx.aiPackId = aiPack.body.exportRunId;
    fx.personPackId = personPack.body.exportRunId;
    assert.ok(JSON.stringify(personPack.body).includes(SECRET), 'the person pack carries the never-send excerpt');
  });

  after(async () => {
    await api?.close();
    await database?.drop();
  });

  test('the header accepts 1 and 0 only', async () => {
    assert.equal((await reader.get('/v1/decisions/current', { [AI_CONTEXT_HEADER]: '0' })).status, 200);
    const bad = await reader.get('/v1/decisions/current', { [AI_CONTEXT_HEADER]: 'yes' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_ai_context_header');
  });

  test('GET /v1/me works in AI context and still reports no confirm, delete or propose for a read token', async () => {
    const me = await aiGet('/v1/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.capabilities, { canConfirm: false, canDelete: false, canPropose: false });
  });

  test('current decisions: the allowed decision in full, the derived one as title and ids only', async () => {
    const plain = await reader.get('/v1/decisions/current');
    assert.ok(JSON.stringify(plain.body).includes(SECRET), 'without the header the never-send decision is served in full');
    const reply = await aiGet('/v1/decisions/current');
    assert.equal(reply.status, 200);
    const list = (reply.body as unknown[]).map(d => AiCurrentDecision.parse(d));
    const full = list.find(d => d.record.id === fx.allowedRecord.id)!;
    assert.ok(!('contentWithheld' in full));
    assert.equal((full as { primaryEvidence: { locator: { excerpt: string } } }).primaryEvidence.locator.excerpt, 'We keep the nightly backup window at 02:00.');
    const withheld = list.find(d => d.record.id === fx.neverRecord.id)!;
    assert.deepEqual(withheld, {
      record: WithheldRecord.parse({
        id: fx.neverRecord.id, kind: 'decision', title: 'Supplier contract decision', supersedesRecordId: null, supersededByRecordId: null,
        contentWithheld: true, reason: 'never_send_to_ai',
      }),
      contentWithheld: true,
    });
  });

  test('record detail and lists: derived records withheld, allowed ones served without version snapshots', async () => {
    for (const r of [fx.neverRecord, fx.mixedRecord]) {
      const reply = await aiGet(`/v1/records/${r.id}`);
      assert.equal(reply.status, 200);
      const view = WithheldRecord.parse(reply.body);
      assert.equal(view.title, r.title);
      assert.deepEqual(Object.keys(reply.body).sort(), ['contentWithheld', 'id', 'kind', 'reason', 'supersededByRecordId', 'supersedesRecordId', 'title']);
    }
    const allowed = await aiGet(`/v1/records/${fx.allowedRecord.id}`);
    const detail = AiRecordDetail.parse(allowed.body);
    assert.ok(!('contentWithheld' in detail));
    assert.equal((detail as RecordDetail).body, 'Body of Backup window stays at 02:00');
    assert.ok((detail as RecordDetail).versions.length >= 2);
    assert.ok((detail as RecordDetail).versions.every(v => Object.keys(v.snapshot).length === 0));
    const plain = await reader.get(`/v1/records/${fx.neverRecord.id}`);
    assert.equal(plain.body.body, 'Body of Supplier contract decision', 'without the header the record is served in full');

    for (const path of ['/v1/records', `/v1/sources/${fx.allowedId}/records`]) {
      const list = await aiGet(path);
      assert.equal(list.status, 200, path);
      const items = (list.body as unknown[]).map(i => AiRecordSummary.parse(i));
      const mixed = items.find(i => i.id === fx.mixedRecord.id)!;
      assert.equal((mixed as WithheldRecord).contentWithheld, true, path);
      const ok = items.find(i => i.id === fx.allowedRecord.id)!;
      assert.ok(!('contentWithheld' in ok), path);
    }
  });

  test('sources: never-send left out of the list with a withheld count; every never-send source route is 409 ai_not_allowed', async () => {
    const plain = await reader.get('/v1/sources');
    assert.ok((plain.body as Array<{ id: string }>).some(s => s.id === fx.neverId));
    assert.equal(plain.headers.get(WITHHELD_HEADER), null);
    const list = await aiGet('/v1/sources');
    assert.equal(list.status, 200);
    const ids = (list.body as Array<{ id: string }>).map(s => s.id);
    assert.ok(ids.includes(fx.allowedId));
    assert.ok(!ids.includes(fx.neverId));
    assert.equal(list.headers.get(WITHHELD_HEADER), '1');

    for (const path of [`/v1/sources/${fx.neverId}`, `/v1/sources/${fx.neverId}/revisions/${fx.neverRev}`,
      `/v1/sources/${fx.neverId}/revisions/${fx.neverRev}/span?startChar=0&endChar=10`, `/v1/sources/${fx.neverId}/records`]) {
      const r = await aiGet(path);
      assert.equal(r.status, 409, path);
      assert.equal(r.body.error, 'ai_not_allowed', path);
      assert.deepEqual(r.body.details, { sourceId: fx.neverId });
    }
    assert.equal((await reader.get(`/v1/sources/${fx.neverId}`)).status, 200, 'without the header the owner token reads it');
    assert.equal((await aiGet(`/v1/sources/${fx.allowedId}`)).status, 200);
    assert.equal((await aiGet(`/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}`)).status, 200);
  });

  test('span: exact text, lines and hash; invalid spans are 400', async () => {
    const needle = span(fx.allowedText, 'nightly backup window');
    const r = await aiGet(`/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}/span?startChar=${needle.startChar}&endChar=${needle.endChar}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const view = SourceSpanView.parse(r.body);
    assert.equal(view.text, 'nightly backup window');
    assert.equal(view.startLine, 2);
    assert.equal(view.endLine, 2);
    assert.equal(view.isCurrentRevision, true);
    const evidence = fx.allowedRecord.evidence[0]!.locator;
    const same = SourceSpanView.parse((await reader.get(`/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}/span?startChar=${evidence.startChar}&endChar=${evidence.endChar}`)).body);
    assert.equal(same.textSha256, evidence.excerptSha256, 'the span hash equals the evidence locator hash');
    for (const q of ['startChar=5&endChar=5', `startChar=0&endChar=${fx.allowedText.length + 1}`, 'startChar=-1&endChar=3', 'startChar=a&endChar=3']) {
      const bad = await reader.get(`/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}/span?${q}`);
      assert.equal(bad.status, 400, q);
    }
    const emoji = await owner.post('/v1/sources', { title: 'emoji', kind: 'paste', content: `a\u{1F600}b ${nonce()}` });
    const split = await reader.get(`/v1/sources/${emoji.body.id}/revisions/${emoji.body.currentRevision.id}/span?startChar=0&endChar=2`);
    assert.equal(split.status, 400);
    assert.equal(split.body.error, 'invalid_span');
  });

  test('search: never-send sources and derived records are not searched in AI context, and nothing counts them', async () => {
    const plain = await reader.get(`/v1/search?q=${SECRET}`);
    const plainIds = (plain.body.hits as Array<{ id: string }>).map(h => h.id);
    assert.ok(plainIds.includes(fx.neverId));
    // The reply echoes the caller's own query, so it is kept out of the leak check below.
    const reply = await reader.get(`/v1/search?q=${SECRET}`, AI);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.hits, []);
    assert.equal(reply.headers.get(WITHHELD_HEADER), null);
    const recordHit = await aiGet('/v1/search?q=supplier contract decision');
    assert.ok(!(recordHit.body.hits as Array<{ id: string }>).some(h => h.id === fx.neverRecord.id));
    const allowed = await aiGet('/v1/search?q=backup window');
    const ids = (allowed.body.hits as Array<{ id: string }>).map(h => h.id);
    assert.ok(ids.includes(fx.allowedId));
    assert.ok(ids.includes(fx.allowedRecord.id));
  });

  test('context packs: only destination-ai packs are listed and readable; building one needs destination ai', async () => {
    const list = await aiGet('/v1/exports');
    assert.equal(list.status, 200);
    const ids = (list.body as Array<{ id: string }>).map(r => r.id);
    assert.ok(ids.includes(fx.aiPackId));
    assert.ok(!ids.includes(fx.personPackId));
    assert.equal(list.headers.get(WITHHELD_HEADER), '1');
    const person = await aiGet(`/v1/exports/${fx.personPackId}`);
    assert.equal(person.status, 409);
    assert.equal(person.body.error, 'ai_not_allowed');
    assert.equal(person.body.details.reason, 'not_an_ai_pack');
    const pack = await aiGet(`/v1/exports/${fx.aiPackId}`);
    assert.equal(pack.status, 200);
    assert.equal(pack.body.manifest.destination, 'ai');

    const implicit = await reader.post('/v1/exports/context-pack', {}, AI);
    assert.equal(implicit.status, 409);
    assert.equal(implicit.body.error, 'ai_not_allowed');
    assert.equal((await reader.post('/v1/exports/context-pack', { destination: 'person' }, AI)).status, 409);
    const built = await reader.post('/v1/exports/context-pack', { destination: 'ai' }, AI);
    assert.equal(built.status, 201, JSON.stringify(built.body));
    aiBodies.push(JSON.stringify(built.body));
  });

  test('a propose token in AI context writes nothing through any read route and still cannot confirm or change policy', async () => {
    const counts = async () => (await api.db.orm.execute(sql`SELECT
      (SELECT count(*) FROM audit_event)::int AS audit, (SELECT count(*) FROM record)::int AS records,
      (SELECT count(*) FROM record_version)::int AS versions, (SELECT count(*) FROM source)::int AS sources,
      (SELECT count(*) FROM approval)::int AS approvals, (SELECT count(*) FROM export_run)::int AS exports`)).rows[0];
    const before = await counts();
    const reads = ['/v1/me', '/v1/actors', '/v1/decisions/current', '/v1/records', `/v1/records/${fx.allowedRecord.id}`,
      `/v1/records/${fx.neverRecord.id}`, '/v1/sources', `/v1/sources/${fx.allowedId}`, `/v1/sources/${fx.allowedId}/records`,
      `/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}`, `/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}/span?startChar=0&endChar=5`,
      '/v1/search?q=backup', '/v1/exports', `/v1/exports/${fx.aiPackId}`];
    for (const path of reads) {
      const r = await aiGet(path, proposer);
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    }
    // Write verbs on read paths are not routes at all.
    for (const path of ['/v1/decisions/current', '/v1/search?q=x', `/v1/sources/${fx.allowedId}/revisions/${fx.allowedRev}/span?startChar=0&endChar=5`]) {
      assert.equal((await proposer.post(path, {}, AI)).status, 404, path);
    }
    assert.deepEqual(await counts(), before, 'no read route wrote anything');

    const candidate = fx.mixedRecord.id;
    for (const who of [proposer, reader]) {
      const confirm = await who.post(`/v1/records/${candidate}/confirm`, {}, AI);
      assert.equal(confirm.status, 403);
      assert.equal(confirm.body.error, 'authority_required');
      assert.equal((await who.post(`/v1/records/${candidate}/reject`, { reason: 'no' }, AI)).status, 403);
      assert.equal((await who.patch(`/v1/sources/${fx.neverId}`, { aiAllowed: true }, AI)).status, 403);
      assert.equal((await who.del(`/v1/sources/${fx.allowedId}`, {}, AI)).status, 403);
    }
    const readWrite = await reader.post('/v1/records', {
      kind: 'fact', title: 'nope', statementMode: 'quoted', statedRole: 'unknown', evidence: [{ sourceId: fx.allowedId, startChar: 0, endChar: 5 }],
    }, AI);
    assert.equal(readWrite.status, 403);
    assert.equal(readWrite.body.error, 'scope_required');
    const n = await api.db.orm.execute(sql`SELECT count(*)::int AS n FROM approval WHERE record_id = ${candidate}`);
    assert.equal((n.rows[0] as { n: number }).n, 0);
  });

  test('a pack whose included source later became never-send is no longer served in AI context', async () => {
    assert.equal((await owner.patch(`/v1/sources/${fx.allowedId}`, { aiAllowed: false })).status, 200);
    try {
      const r = await aiGet(`/v1/exports/${fx.aiPackId}`);
      assert.equal(r.status, 409);
      assert.equal(r.body.details.reason, 'source_now_never_send');
      const list = await aiGet('/v1/exports');
      assert.ok(!(list.body as Array<{ id: string }>).some(x => x.id === fx.aiPackId));
      const decisions = (await aiGet('/v1/decisions/current')).body as Array<{ contentWithheld?: boolean; record: { id: string } }>;
      assert.equal(decisions.find(d => d.record.id === fx.allowedRecord.id)?.contentWithheld, true, 'permissions pass down at once');
    } finally {
      assert.equal((await owner.patch(`/v1/sources/${fx.allowedId}`, { aiAllowed: true })).status, 200);
    }
  });

  test('no AI-context reply ever contained never-send content or the never-send source title', () => {
    assert.ok(aiBodies.length > 20);
    for (const body of aiBodies) {
      assert.ok(!body.includes(SECRET), body.slice(0, 300));
      assert.ok(!body.includes(fx.neverTitle), body.slice(0, 300));
      assert.ok(!body.includes('Body of Supplier contract decision'), body.slice(0, 300));
    }
  });
});
