// BUILD-BASELINE §8 item 5, second half: "Intent and observed reality can differ, and both are shown."
// On the public fixture intent-vs-observed the approved design says 100 requests per minute and the staging
// gateway was observed at 1000. Both are recorded and confirmed with different lifecycle statuses. This file
// asserts on the product's real outputs, through HTTP against a fresh database with AI and peers off, that the
// two appear together, each with its own status and time: the record list of the source, the context pack
// (JSON and Markdown from one manifest) and the current-decisions view. Nothing is mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ContextPackResponse, CurrentDecision, RecordDetail, RecordSummary, SourceView } from '@poii/contracts';
import { client, createFreshDatabase, fixture, skipIntegration, span, startApi, type Client, type TestApi } from './helpers.js';

const INTENT_EXCERPT = 'Each partner token is limited to **100 requests per minute** on the public routing API.';
const OBSERVED_EXCERPT = 'gateway: rate limit policy loaded: partner_token 1000 req/min, burst 200';
const INTENT_TITLE = 'Partner tokens are limited to 100 requests per minute';
const OBSERVED_TITLE = 'The staging gateway allows 1000 requests per minute';
const INTENT_AT = '2026-04-10T00:00:00.000Z';
const OBSERVED_AT = '2026-06-02T14:07:00.000Z';

/** The Markdown of one record: from its heading to the next record heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `the pack has a section "${heading}"`);
  const next = markdown.indexOf('\n### [', start + heading.length);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe('intent and observed reality are both shown (integration, fresh database)', { skip: skipIntegration }, () => {
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>> | undefined;
  let api: TestApi | undefined;
  let c: Client;
  let source: SourceView;
  let intent: RecordDetail;
  let observed: RecordDetail;

  before(async () => {
    fresh = await createFreshDatabase();
    api = await startApi(fresh.url);
    c = client(api.base);
    const content = fixture('intent-vs-observed', 'intent-observed');
    const pasted = await c.post('/v1/sources', { title: 'intent-vs-observed', kind: 'paste', content });
    assert.equal(pasted.status, 201, JSON.stringify(pasted.body));
    source = SourceView.parse(pasted.body);
    const create = async (body: Record<string, unknown>, needle: string) => {
      const r = await c.post('/v1/records', { ...body, evidence: [{ sourceId: source.id, ...span(content, needle) }] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const confirmed = await c.post(`/v1/records/${r.body.id}/confirm`, {});
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      return RecordDetail.parse(confirmed.body);
    };
    // The intent: the owner's approved design (Part A of the fixture).
    intent = await create({
      kind: 'decision', title: INTENT_TITLE, statementMode: 'quoted', statedRole: 'owner', lifecycleStatus: 'decided', effectiveAt: INTENT_AT,
    }, INTENT_EXCERPT);
    // The observed reality: what the staging gateway logged (Part B), recorded after the intent and differing from it.
    observed = await create({
      kind: 'fact', title: OBSERVED_TITLE, statementMode: 'quoted', statedRole: 'third_party', lifecycleStatus: 'observed', observedAt: OBSERVED_AT,
    }, OBSERVED_EXCERPT);
  });

  after(async () => {
    await api?.close();
    await fresh?.drop();
  });

  test('the record list of the source shows the intended decision as decided and the observed fact as observed, side by side', async () => {
    for (const path of [`/v1/sources/${source.id}/records`, `/v1/records?sourceId=${source.id}&reviewState=confirmed`]) {
      const reply = await c.get(path);
      assert.equal(reply.status, 200, `${path}: ${JSON.stringify(reply.body)}`);
      const list = (reply.body as unknown[]).map(r => RecordSummary.parse(r));
      assert.deepEqual(list.map(r => r.id).sort(), [intent.id, observed.id].sort(), `${path} lists both records and nothing else`);
      const shownIntent = list.find(r => r.id === intent.id)!;
      const shownObserved = list.find(r => r.id === observed.id)!;
      assert.deepEqual(
        [shownIntent.kind, shownIntent.title, shownIntent.reviewState, shownIntent.lifecycleStatus, shownIntent.effectiveAt, shownIntent.effectiveAtStatus],
        ['decision', INTENT_TITLE, 'confirmed', 'decided', INTENT_AT, 'known'],
      );
      assert.equal(shownIntent.observedAt, null, 'the intent carries no observation time: it was decided, not observed');
      assert.notEqual(shownIntent.observedAtStatus, 'known');
      assert.deepEqual(
        [shownObserved.kind, shownObserved.title, shownObserved.reviewState, shownObserved.lifecycleStatus, shownObserved.observedAt, shownObserved.observedAtStatus],
        ['fact', OBSERVED_TITLE, 'confirmed', 'observed', OBSERVED_AT, 'known'],
      );
    }
  });

  test('the context pack shows both in JSON and in Markdown, each with its lifecycle status, time and exact excerpt', async () => {
    const reply = await c.post('/v1/exports/context-pack', { sourceIds: [source.id], title: 'Rate limit: intent and observation' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const pack = ContextPackResponse.parse(reply.body);
    assert.equal(pack.manifest.recordCount, 2);
    assert.deepEqual(pack.manifest.included.map(s => s.sourceId), [source.id]);

    const records = pack.json.records as Array<{
      id: string; kind: string; lifecycleStatus: string; reviewState: string;
      times: { effectiveAt: string | null; effectiveAtStatus: string; observedAt: string | null; observedAtStatus: string };
      staleness: { label: string; lastObservedAt: string | null };
      evidence: Array<{ status: string; excerpt: string | null }>;
    }>;
    assert.deepEqual(records.map(r => r.id).sort(), [intent.id, observed.id].sort());
    const jsonIntent = records.find(r => r.id === intent.id)!;
    const jsonObserved = records.find(r => r.id === observed.id)!;
    assert.deepEqual([jsonIntent.kind, jsonIntent.reviewState, jsonIntent.lifecycleStatus], ['decision', 'confirmed', 'decided']);
    assert.deepEqual([jsonIntent.times.effectiveAt, jsonIntent.times.effectiveAtStatus, jsonIntent.times.observedAt], [INTENT_AT, 'known', null]);
    assert.deepEqual(jsonIntent.staleness, { lastObservedAt: null, label: 'unknown' }, 'an intent that was never observed says so');
    assert.deepEqual(jsonIntent.evidence.map(e => [e.status, e.excerpt]), [['included', INTENT_EXCERPT]]);
    assert.deepEqual([jsonObserved.kind, jsonObserved.reviewState, jsonObserved.lifecycleStatus], ['fact', 'confirmed', 'observed']);
    assert.deepEqual([jsonObserved.times.observedAt, jsonObserved.times.observedAtStatus], [OBSERVED_AT, 'known']);
    assert.equal(jsonObserved.staleness.lastObservedAt, OBSERVED_AT);
    assert.deepEqual(jsonObserved.evidence.map(e => [e.status, e.excerpt]), [['included', OBSERVED_EXCERPT]]);

    const mdIntent = section(pack.markdown, `### [decision] ${INTENT_TITLE}`);
    assert.ok(mdIntent.includes(`- Record \`${intent.id}\` · review: confirmed · status: decided · current: yes`), mdIntent);
    assert.ok(mdIntent.includes(`effective: ${INTENT_AT} (known)`), mdIntent);
    assert.ok(mdIntent.includes('- Staleness: unknown'), mdIntent);
    assert.ok(mdIntent.includes(`> ${INTENT_EXCERPT}`), 'the design note is quoted');
    assert.ok(!mdIntent.includes('1000 req/min'), 'the observation is not folded into the intent');
    const mdObserved = section(pack.markdown, `### [fact] ${OBSERVED_TITLE}`);
    assert.ok(mdObserved.includes(`- Record \`${observed.id}\` · review: confirmed · status: observed · current: yes`), mdObserved);
    assert.ok(mdObserved.includes(`observed: ${OBSERVED_AT} (known)`), mdObserved);
    assert.match(mdObserved, /- Staleness: (observed|stale) \(last observed 2026-06-02T14:07:00\.000Z\)/);
    assert.ok(mdObserved.includes(`> ${OBSERVED_EXCERPT}`), 'the deployment log line is quoted');
    assert.ok(!mdObserved.includes('100 requests per minute'), 'the intent is not folded into the observation');
  });

  test('recording the differing observation leaves the intended decision current and decided, never rewritten as observed', async () => {
    const reply = await c.get('/v1/decisions/current');
    assert.equal(reply.status, 200);
    const current = (reply.body as unknown[]).map(d => CurrentDecision.parse(d));
    assert.deepEqual(current.map(d => d.record.id), [intent.id], 'the observed fact is not a decision and replaces nothing');
    assert.equal(current[0]!.record.lifecycleStatus, 'decided');
    assert.deepEqual(current[0]!.staleness, { lastObservedAt: null, label: 'unknown' });
    const detail = RecordDetail.parse((await c.get(`/v1/records/${intent.id}`)).body);
    assert.deepEqual(detail.versions.map(v => v.changeKind), ['create', 'confirm'], 'the observation changed nothing on the intent');
    assert.equal(RecordDetail.parse((await c.get(`/v1/records/${observed.id}`)).body).supersedesRecordId, null);
  });
});
