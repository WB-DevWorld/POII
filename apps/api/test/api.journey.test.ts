// The ND-1 manual journey end to end on the three public fixtures, with AI and peers off, in a fresh database:
// paste → candidates → confirm/edit/reject/supersede → status → search → current decisions → context pack →
// backup → restore into a second fresh database (identical ids, history and approvals) → idempotent re-restore.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  BackupDocument, ContextPackResponse, CurrentDecision, MeResponse, RecordDetail, RestoreResponse, RevisionView, SearchResponse,
  SourceDetail,
} from '@poii/contracts';
import { client, createFreshDatabase, fixture, skipIntegration, span, startApi, type Client, type TestApi } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('manual journey with backup and restore (integration, fresh databases)', { skip: skipIntegration }, () => {
  let first: { url: string; drop: () => Promise<void> } | undefined;
  let second: { url: string; drop: () => Promise<void> } | undefined;
  let api1: TestApi | undefined;
  let api2: TestApi | undefined;
  let c1: Client;
  let c2: Client;

  before(async () => {
    first = await createFreshDatabase();
    second = await createFreshDatabase();
    api1 = await startApi(first.url);
    api2 = await startApi(second.url);
    c1 = client(api1.base);
    c2 = client(api2.base);
  });

  after(async () => {
    await api1?.close();
    await api2?.close();
    await first?.drop();
    await second?.drop();
  });

  test('ND-1 journey, backup, restore into an empty install, idempotent second restore', async () => {
    const me = MeResponse.parse((await c1.get('/v1/me')).body);
    assert.equal(me.workspace.name, 'Owner workspace');

    // 1. Paste the three fixtures.
    const texts = { chain: fixture('decision-chain', 'journey'), rate: fixture('intent-vs-observed', 'journey'), price: fixture('price-conflict', 'journey') };
    const paste = async (title: string, content: string) => {
      const r = await c1.post('/v1/sources', { title, kind: 'paste', content, origin: { fixture: title } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body as { id: string; currentRevision: { id: string } };
    };
    const chain = await paste('decision-chain', texts.chain);
    const rate = await paste('intent-vs-observed', texts.rate);
    const price = await paste('price-conflict', texts.price);
    const assistant = (await c1.post('/v1/actors', { kind: 'ai_assistant', displayName: 'Chat assistant (pasted)' })).body;
    const jonas = (await c1.post('/v1/actors', { kind: 'person', displayName: 'Jonas (head of purchasing)' })).body;

    // 2. Candidates by hand, each citing exact spans.
    const create = async (body: Record<string, unknown>) => {
      const r = await c1.post('/v1/records', body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return RecordDetail.parse(r.body);
    };
    const ev = (source: { id: string }, text: string, needle: string, role: 'primary' | 'supporting' = 'primary') => ({ sourceId: source.id, ...span(text, needle), role });
    const recommendation = await create({
      kind: 'fact', title: 'The assistant recommended RabbitMQ', statementMode: 'pasted', statedRole: 'assistant', statedByActorId: assistant.id,
      effectiveAt: '2026-03-02T09:15:00Z', evidence: [ev(chain, texts.chain, 'I recommend RabbitMQ.')],
    });
    const rabbitQuestion = await create({
      kind: 'question', title: 'Adopt RabbitMQ?', statementMode: 'paraphrased', statedRole: 'assistant', statedByActorId: assistant.id,
      evidence: [ev(chain, texts.chain, 'You should adopt RabbitMQ for Lanternfish.')],
    });
    const bull = await create({
      kind: 'decision', title: 'Lanternfish uses BullMQ', statementMode: 'quoted', statedRole: 'owner', lifecycleStatus: 'decided',
      effectiveAt: '2026-03-04T16:02:00Z',
      evidence: [ev(chain, texts.chain, 'Decision: Lanternfish uses BullMQ on the existing Redis for release one.')],
    });
    const limit = await create({
      kind: 'requirement', title: 'Partner tokens: 100 requests per minute', statementMode: 'quoted', statedRole: 'owner',
      lifecycleStatus: 'decided', effectiveAt: '2026-04-10T00:00:00Z',
      evidence: [ev(rate, texts.rate, 'Each partner token is limited to **100 requests per minute** on the public routing API.')],
    });
    const observed = await create({
      kind: 'fact', title: 'Staging gateway allows 1000 per minute', statementMode: 'quoted', statedRole: 'third_party',
      lifecycleStatus: 'observed', observedAt: '2026-06-02T14:07:00Z',
      evidence: [
        ev(rate, texts.rate, 'gateway: rate limit policy loaded: partner_token 1000 req/min, burst 200'),
        ev(rate, texts.rate, 'a partner token made 640 requests in one minute without a 429', 'supporting'),
      ],
    });
    const openQuestion = await create({
      kind: 'question', title: 'Which rate limit is right?', statementMode: 'paraphrased', statedRole: 'third_party',
      evidence: [ev(rate, texts.rate, 'Which is right is unknown until the owner says so.')],
    });
    const priceFact = await create({
      kind: 'fact', title: 'Type-B widget price', statementMode: 'quoted', statedRole: 'third_party', effectiveAtStatus: 'conflicting',
      timeConflicts: [{ value: '2026-07-08T00:00:00.000Z', sourceId: price.id, note: 'supplier e-mail' }, { value: null, sourceId: price.id, note: 'undated catalogue' }],
      evidence: [ev(price, texts.price, 'EUR 12.40'), ev(price, texts.price, '| Type-B brass widget | EUR 11.90 |', 'supporting')],
    });
    const priceDecision = await create({
      kind: 'decision', title: 'Use EUR 12.40 per Type-B widget for Q3', statementMode: 'quoted', statedRole: 'third_party',
      statedByActorId: jonas.id, effectiveAt: '2026-07-15T00:00:00Z', lifecycleStatus: 'decided',
      evidence: [ev(price, texts.price, 'We use **EUR 12.40** per Type-B widget for the Q3 budget and the first order of 500 units.')],
    });

    // 3. Edit, confirm, reject, supersede.
    const edited = await c1.patch(`/v1/records/${bull.id}`, { body: 'Revisit if cross-language consumers appear.', note: 'context from the chat' });
    assert.equal(edited.status, 200);
    const confirm = async (id: string, body: Record<string, unknown> = {}) => {
      const r = await c1.post(`/v1/records/${id}/confirm`, body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return RecordDetail.parse(r.body);
    };
    for (const r of [recommendation, bull, limit, observed, priceFact, priceDecision]) await confirm(r.id);
    const rejected = await c1.post(`/v1/records/${rabbitQuestion.id}/reject`, { reason: 'Answered by the BullMQ decision' });
    assert.equal(rejected.body.reviewState, 'rejected');
    const nats = RecordDetail.parse((await c1.post(`/v1/records/${bull.id}/supersede`, {
      kind: 'decision', title: 'Lanternfish moves to NATS JetStream from release two', statementMode: 'quoted', statedRole: 'owner',
      lifecycleStatus: 'proposed', effectiveAt: '2026-05-19T11:40:00Z',
      evidence: [ev(chain, texts.chain, 'Decision: Lanternfish moves to NATS JetStream for order routing from release two.')],
    })).body);
    const natsConfirmed = await confirm(nats.id, { note: 'Go consumers cannot use BullMQ' });
    assert.equal(natsConfirmed.approvals[0]!.antecedentRecordId, bull.id);
    assert.equal(natsConfirmed.approvals[0]!.approvedByActorId, me.actor.id);

    // 4. Lifecycle status.
    const status = await c1.post(`/v1/records/${nats.id}/status`, { lifecycleStatus: 'decided', note: 'scheduled for release two' });
    assert.equal(status.body.lifecycleStatus, 'decided');

    // 5. Search, then open the original at the exact span.
    const search = SearchResponse.parse((await c1.get(`/v1/search?q=${encodeURIComponent('JetStream')}`)).body);
    const hit = search.hits.find(h => h.type === 'source' && h.id === chain.id)!;
    assert.ok(hit && hit.span);
    const revision = RevisionView.parse((await c1.get(`/v1/sources/${chain.id}/revisions/${hit.span.revisionId}`)).body);
    assert.equal(revision.contentText.slice(hit.span.startChar, hit.span.endChar), 'JetStream');
    assert.ok(search.hits.some(h => h.type === 'record' && h.id === nats.id));

    // 6. Current decisions: derived from approvals plus supersession.
    const currentList = ((await c1.get('/v1/decisions/current')).body as unknown[]).map(d => CurrentDecision.parse(d));
    assert.deepEqual(currentList.map(d => d.record.id).sort(), [nats.id, priceDecision.id].sort());
    const natsCurrent = currentList.find(d => d.record.id === nats.id)!;
    assert.deepEqual(natsCurrent.replaced.map(r => r.id), [bull.id]);
    assert.equal(natsCurrent.approval.approvedByDisplayName, 'Owner');

    // 7. Context pack: Markdown and JSON from one manifest; every citation resolves.
    const packReply = await c1.post('/v1/exports/context-pack', { title: 'Lanternfish and Harbor context' });
    assert.equal(packReply.status, 201);
    const pack = ContextPackResponse.parse(packReply.body);
    assert.deepEqual(pack.manifest.included.map(s => s.sourceId).sort(), [chain.id, rate.id, price.id].sort());
    assert.equal(pack.manifest.recordCount, 7, 'all confirmed records, current or superseded');
    const records = pack.json.records as Array<{ id: string; current: boolean; evidence: Array<{ revisionId: string; startChar: number; endChar: number; excerptSha256: string; sourceId: string; status: string }> }>;
    assert.equal(records.find(r => r.id === bull.id)!.current, false);
    for (const record of records) {
      for (const e of record.evidence) {
        assert.equal(e.status, 'included');
        const rev = RevisionView.parse((await c1.get(`/v1/sources/${e.sourceId}/revisions/${e.revisionId}`)).body);
        assert.equal(sha(rev.contentText.slice(e.startChar, e.endChar)), e.excerptSha256, 'citation resolves');
      }
    }
    assert.match(pack.markdown, /Stated by: Chat assistant \(pasted\) \(role assistant, pasted\)/);
    assert.match(pack.markdown, /Approved by: Owner \(owner\)/);
    assert.match(pack.markdown, /Conflicting times: 2026-07-08T00:00:00.000Z/);

    // 8. Backup and restore into a clean install.
    const backupReply = await c1.post('/v1/backup', {});
    assert.equal(backupReply.status, 200);
    const backup = BackupDocument.parse(backupReply.body);
    assert.equal(backup.workspace.id, me.workspace.id);
    assert.equal(backup.records.length, 9);
    assert.equal(backup.sources.length, 3);
    assert.ok(backup.revisions.every(r => typeof r.originalBase64 === 'string'));
    assert.ok((await c1.get('/v1/exports')).body.some((r: { id: string; kind: string }) => r.id === backup.exportRunId && r.kind === 'backup'));
    assert.ok(existsSync(join(api1!.storageDir, 'backups', `${backup.exportRunId}.json`)), 'HTTP backups keep their copy in storage');

    const me2Before = MeResponse.parse((await c2.get('/v1/me')).body);
    assert.notEqual(me2Before.workspace.id, me.workspace.id);
    const garbage = await c2.post('/v1/restore', { backup: { format: 'something-else' } });
    assert.equal(garbage.status, 400);
    const restoredReply = await c2.post('/v1/restore', { backup });
    assert.equal(restoredReply.status, 200, JSON.stringify(restoredReply.body));
    const restored = RestoreResponse.parse(restoredReply.body);
    assert.equal(restored.workspaceId, me.workspace.id);
    assert.deepEqual(restored.restored, {
      sources: 3, revisions: 3, records: 9, approvals: 7, evidence: backup.evidence.length, versions: backup.versions.length,
      actors: backup.actors.length, tombstones: 0, auditEvents: backup.auditEvents.length,
    });

    const me2 = MeResponse.parse((await c2.get('/v1/me')).body);
    assert.equal(me2.workspace.id, me.workspace.id);
    assert.equal(me2.actor.id, me.actor.id, 'the restored owner is the same actor');
    for (const id of [recommendation.id, rabbitQuestion.id, bull.id, nats.id, limit.id, observed.id, openQuestion.id, priceFact.id, priceDecision.id]) {
      const a = (await c1.get(`/v1/records/${id}`)).body;
      const b = (await c2.get(`/v1/records/${id}`)).body;
      assert.deepEqual(b, a, `record ${id} is identical after restore, with history and approvals`);
    }
    for (const id of [chain.id, rate.id, price.id]) {
      const a = SourceDetail.parse((await c1.get(`/v1/sources/${id}`)).body);
      const b = SourceDetail.parse((await c2.get(`/v1/sources/${id}`)).body);
      assert.deepEqual(b, a);
      assert.ok(existsSync(join(api2!.storageDir, 'sources', id, a.currentRevision.id)), 'original bytes restored to storage');
    }
    assert.deepEqual((await c2.get('/v1/decisions/current')).body, (await c1.get('/v1/decisions/current')).body);
    const search2 = SearchResponse.parse((await c2.get('/v1/search?q=JetStream')).body);
    assert.ok(search2.hits.some(h => h.id === chain.id));

    // Idempotent: restoring the same backup again is a no-op; a non-empty workspace refuses.
    const again = RestoreResponse.parse((await c2.post('/v1/restore', { backup })).body);
    assert.equal(again.alreadyRestored, true);
    assert.equal(again.restored.records, 0);
    const notEmpty = await c1.post('/v1/restore', { backup });
    assert.equal(notEmpty.status, 409);
    assert.equal(notEmpty.body.error, 'workspace_not_empty');

    // The restored install keeps working: the open question can be confirmed by the restored owner.
    const after = await c2.post(`/v1/records/${openQuestion.id}/confirm`, {});
    assert.equal(after.status, 200);
    assert.equal(after.body.approvals[0].approvedByActorId, me.actor.id);
  });
});
