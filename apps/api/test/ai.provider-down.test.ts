// BUILD-BASELINE §8 item 9, second half: "The manual path keeps working when providers ... are down."
// AI is ENABLED here and both providers are configured, but they cannot be used: the connection fails, the call
// times out, or a gateway or the provider answers 5xx. Each execute must end cleanly (HTTP 200 with an error
// outcome, no candidates, the ledger row settled, one audit event without text, the preview spent so nothing
// is sent twice), and afterwards the whole manual journey must work in the same running instance.
// MOCKED: the provider is the `downFetch` stub below, injected into the production factory
// (createAiExecution); no live provider is called and the keys are fake. Everything else is real: HTTP,
// NestJS, Drizzle, PostgreSQL, disclosure, caps, records, search, views, exports.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  AiExecuteResponse, AiPreviewResponse, AiStatusResponse, AiUsageResponse, ContextPackResponse, CurrentDecision, RecordDetail, RevisionView,
  SearchResponse, SourceView,
} from '@poii/contracts';
import { createAiExecution } from '../src/ai/factory.js';
import type { FetchLike } from '../src/ports/ai-execution.js';
import { startAiApi } from './ai.helpers.js';
import { client, createFreshDatabase, fixture, nonce, skipIntegration, span, type Client, type TestApi } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const micro = (usd: number) => Math.round(usd * 1_000_000);

type Mode = 'refused' | 'hang' | 'gateway-502' | 'provider-500';

/** MOCKED provider that is down. `mode` chooses how; every call is recorded. */
function downFetch() {
  const state: { mode: Mode; calls: Array<{ url: string; body: any }> } = { mode: 'refused', calls: [] };
  const fetch: FetchLike = async (url, init) => {
    state.calls.push({ url, body: JSON.parse(String(init.body)) });
    if (state.mode === 'refused') {
      // MOCKED: what Node's fetch throws when nothing listens at the address.
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 203.0.113.1:443'), { code: 'ECONNREFUSED' }) });
    }
    if (state.mode === 'hang') {
      // MOCKED: a provider that accepts the connection and never answers; like fetch, it rejects with the signal's reason.
      const signal = init.signal!;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (state.mode === 'gateway-502') {
      // MOCKED: a proxy's error page, not the provider's error envelope.
      return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    }
    // MOCKED: the provider's own error envelope with HTTP 500 (shape as in test/recorded/anthropic.error.529.json).
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, state };
}

describe('AI enabled but the providers are down (integration, MOCKED unreachable provider)', { skip: skipIntegration }, () => {
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>> | undefined;
  let api: TestApi | undefined;
  let c: Client;
  const down = downFetch();
  const run = nonce();
  const failedSourceIds: string[] = [];

  before(async () => {
    fresh = await createFreshDatabase();
    // The production factory with the MOCKED fetch; the shortest timeout the configuration accepts (1 s).
    api = await startAiApi(fresh.url, (settings, db) => createAiExecution(settings, db, down.fetch), {
      POII_AI_PROVIDER_DEFAULT: 'anthropic', POII_AI_TIMEOUT_MS: '1000',
    });
    c = client(api.base);
  });

  after(async () => {
    await api?.close();
    await fresh?.drop();
  });

  async function paste(title: string, content: string) {
    const r = await c.post('/v1/sources', { title, kind: 'paste', content });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { ...SourceView.parse(r.body), content };
  }

  /** Previews a new source for `provider`, executes with the provider in `mode`, and returns what happened. */
  async function failedExecute(provider: 'anthropic' | 'openai', mode: Mode) {
    const content = `Provider-down probe ${run} ${provider} ${mode}: Decision: keep the manual path independent of providers.`;
    const src = await paste(`Provider down ${run} ${provider} ${mode}`, content);
    failedSourceIds.push(src.id);
    const previewReply = await c.post('/v1/ai/preview', { sourceId: src.id, provider });
    assert.equal(previewReply.status, 201, JSON.stringify(previewReply.body));
    const pv = AiPreviewResponse.parse(previewReply.body);
    const callsBefore = down.state.calls.length;
    down.state.mode = mode;
    const reply = await c.post('/v1/ai/execute', { previewId: pv.previewId });
    assert.equal(reply.status, 200, `a provider failure is an outcome, not a server error: ${JSON.stringify(reply.body)}`);
    const ex = AiExecuteResponse.parse(reply.body);
    assert.equal(down.state.calls.length, callsBefore + 1, 'exactly one attempt, no silent retry');
    const sent = down.state.calls.at(-1)!.body;
    assert.equal(provider === 'anthropic' ? sent.messages[0].content : sent.input, pv.promptText, 'the attempt carried exactly the previewed text');
    assert.deepEqual(ex.records, [], 'no candidates');
    assert.ok(!JSON.stringify(reply.body).includes('keep the manual path independent'), 'the error reply carries no source text');

    const ledger = (await api!.db.pool.query(
      'SELECT state, reserved_micro_usd, actual_micro_usd, input_tokens, output_tokens, outcome, settled_at FROM ai_usage WHERE preview_id = $1', [pv.previewId],
    )).rows;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].state, 'settled', 'the reservation is settled, never left hanging as reserved');
    assert.ok(ledger[0].settled_at);
    assert.equal(Number(ledger[0].reserved_micro_usd), micro(pv.estimatedCostUsd));
    assert.deepEqual([ledger[0].input_tokens, ledger[0].output_tokens, ledger[0].outcome], [null, null, ex.outcome]);

    const audits = (await api!.db.pool.query(
      `SELECT details FROM audit_event WHERE action = 'ai.executed' AND details ->> 'previewId' = $1`, [pv.previewId],
    )).rows.map(r => r.details);
    assert.equal(audits.length, 1, 'one ai.executed audit event');
    assert.equal(audits[0].promptSha256, pv.promptSha256);
    assert.deepEqual(
      [audits[0].provider, audits[0].outcome, audits[0].candidateCount, audits[0].usageReported, audits[0].inputTokens, audits[0].outputTokens],
      [provider, ex.outcome, 0, false, null, null],
    );
    assert.deepEqual(audits[0].errors, ex.errors);
    assert.ok(!JSON.stringify(audits[0]).includes('Provider-down probe'), 'no prompt text in the audit event');

    // The preview is spent: asking again sends nothing (a provider that did process the first call is not paid twice).
    const again = await c.post('/v1/ai/execute', { previewId: pv.previewId });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'preview_used');
    assert.equal(down.state.calls.length, callsBefore + 1);
    return { pv, ex, actualMicro: Number(ledger[0].actual_micro_usd), httpStatus: audits[0].httpStatus as number | null, costUsd: audits[0].costUsd as number };
  }

  test('status still reports AI enabled with both providers configured: this is an outage, not the off switch', async () => {
    const status = AiStatusResponse.parse((await c.get('/v1/ai/status')).body);
    assert.equal(status.enabled, true);
    assert.deepEqual(status.providers.map(p => [p.provider, p.configured]), [['anthropic', true], ['openai', true]]);
    assert.equal((await c.get('/v1/me')).body.aiEnabled, true);
  });

  test('a refused connection ends as network_error: no candidates, and the reserved amount stays counted as spent because the outcome is unknown', async () => {
    const { pv, ex, actualMicro, httpStatus, costUsd } = await failedExecute('anthropic', 'refused');
    assert.equal(ex.outcome, 'network_error');
    assert.deepEqual(ex.errors, ['Anthropic could not be reached; it is unknown whether the request was processed.']);
    assert.deepEqual(ex.usage, { inputTokens: null, outputTokens: null, reservedUsd: pv.estimatedCostUsd, costUsd: pv.estimatedCostUsd, reconciled: false });
    assert.equal(actualMicro, micro(pv.estimatedCostUsd), 'a transport failure keeps the whole reservation (the cap errs on the safe side)');
    assert.equal(httpStatus, null);
    assert.equal(costUsd, pv.estimatedCostUsd);
    const usage = AiUsageResponse.parse((await c.get('/v1/ai/usage')).body);
    const anthropic = usage.providers.find(p => p.provider === 'anthropic')!;
    assert.deepEqual([micro(anthropic.spentUsd), anthropic.reservedUsd, anthropic.calls], [micro(pv.estimatedCostUsd), 0, 1]);
    assert.equal(micro(anthropic.remainingUsd), micro(anthropic.capUsd) - micro(pv.estimatedCostUsd));
  });

  test('a provider that never answers ends at the configured time limit as network_error "timed out"', async () => {
    const started = Date.now();
    const { pv, ex, actualMicro, httpStatus } = await failedExecute('openai', 'hang');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 10_000, `the call ended at the 1 s limit instead of hanging (took ${elapsed} ms)`);
    assert.equal(ex.outcome, 'network_error');
    assert.deepEqual(ex.errors, ['OpenAI timed out; it is unknown whether the request was processed.']);
    assert.equal(ex.usage.reconciled, false);
    assert.equal(ex.usage.costUsd, pv.estimatedCostUsd);
    assert.equal(actualMicro, micro(pv.estimatedCostUsd));
    assert.equal(httpStatus, null);
  });

  test('a 502 gateway page without the provider envelope ends as provider_error and stays counted; a 500 with the envelope is released', async () => {
    const gateway = await failedExecute('anthropic', 'gateway-502');
    assert.equal(gateway.ex.outcome, 'provider_error');
    assert.deepEqual(gateway.ex.errors, ['Anthropic answered 502 (no error body).']);
    assert.equal(gateway.httpStatus, 502);
    assert.equal(gateway.ex.usage.costUsd, gateway.pv.estimatedCostUsd, 'unknown whether the provider processed it: the reservation stays counted');
    assert.equal(gateway.actualMicro, micro(gateway.pv.estimatedCostUsd));

    const rejected = await failedExecute('anthropic', 'provider-500');
    assert.equal(rejected.ex.outcome, 'provider_error');
    assert.deepEqual(rejected.ex.errors, ['Anthropic answered 500 (api_error: Internal server error).']);
    assert.equal(rejected.httpStatus, 500);
    assert.equal(rejected.ex.usage.costUsd, 0, 'rejected with the provider envelope: nothing was generated or billed');
    assert.equal(rejected.actualMicro, 0);
    assert.equal(rejected.ex.usage.reconciled, false);
  });

  test('with the providers still down the manual journey works in the same instance: source, candidate, confirm, search, current decisions, context pack', async () => {
    // One more failed execution first, so this test stands on its own; the provider stays unreachable afterwards.
    const failed = await failedExecute('openai', 'refused');
    assert.equal(failed.ex.outcome, 'network_error');
    assert.deepEqual(failed.ex.errors, ['OpenAI could not be reached; it is unknown whether the request was processed.']);
    const calls = down.state.calls.length;

    // The failed executions left nothing behind but their ledger rows and audit events.
    for (const sourceId of failedSourceIds) {
      assert.deepEqual((await c.get(`/v1/records?sourceId=${sourceId}`)).body, []);
    }
    const actors = (await c.get('/v1/actors')).body as Array<{ kind: string }>;
    assert.ok(!actors.some(a => a.kind === 'ai_assistant'), 'no AI actor was created for calls that produced nothing');

    const content = fixture('decision-chain', `${run}-down`);
    const decisionText = 'Decision: Lanternfish uses BullMQ on the existing Redis for release one.';
    const src = await paste(`Manual while providers are down ${run}`, content);
    const created = await c.post('/v1/records', {
      kind: 'decision', title: `Manual BullMQ decision ${run}`, statementMode: 'quoted', statedRole: 'owner', lifecycleStatus: 'decided',
      evidence: [{ sourceId: src.id, ...span(content, decisionText) }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const confirmed = await c.post(`/v1/records/${created.body.id}/confirm`, { note: 'confirmed by hand during the provider outage' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const record = RecordDetail.parse(confirmed.body);
    assert.equal(record.reviewState, 'confirmed');
    assert.equal(record.statementMode, 'quoted');
    assert.equal(record.approvals.length, 1);

    const search = SearchResponse.parse((await c.get('/v1/search?q=BullMQ')).body);
    const hit = search.hits.find(h => h.type === 'source' && h.id === src.id);
    assert.ok(hit?.span, 'search finds the new source and gives a span');
    const revision = RevisionView.parse((await c.get(`/v1/sources/${src.id}/revisions/${hit.span.revisionId}`)).body);
    assert.equal(revision.contentText, content, 'the original opens unchanged');
    assert.ok(search.hits.some(h => h.type === 'record' && h.id === record.id));

    const current = ((await c.get('/v1/decisions/current')).body as unknown[]).map(d => CurrentDecision.parse(d));
    assert.deepEqual(current.map(d => d.record.id), [record.id]);
    assert.equal(current[0]!.approval.approvedByDisplayName, 'Owner');

    const packReply = await c.post('/v1/exports/context-pack', { title: `Outage pack ${run}` });
    assert.equal(packReply.status, 201, JSON.stringify(packReply.body));
    const pack = ContextPackResponse.parse(packReply.body);
    assert.deepEqual(pack.manifest.included.map(s => s.sourceId), [src.id]);
    assert.equal(pack.manifest.recordCount, 1);
    const cited = (pack.json.records as Array<{ id: string; evidence: Array<{ startChar: number; endChar: number; excerptSha256: string; status: string }> }>)[0]!;
    assert.equal(cited.id, record.id);
    assert.equal(cited.evidence[0]!.status, 'included');
    assert.equal(sha(content.slice(cited.evidence[0]!.startChar, cited.evidence[0]!.endChar)), cited.evidence[0]!.excerptSha256, 'the citation resolves');
    assert.ok(pack.markdown.includes(`> ${decisionText}`));

    assert.equal(down.state.calls.length, calls, 'none of the manual steps tried to reach a provider');
  });
});
