// #13 AI unit tests: prompt, candidate validation, pricing, configuration, adapter selection and both provider
// clients. Provider responses are MOCKED (hand-written files in test/recorded/, replayed by an injected stub
// fetch); no live provider is called.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AnthropicAiExecution, ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION } from '../src/adapters/anthropic.ai-execution.js';
import { OffAiExecution } from '../src/adapters/off.ai-execution.js';
import { OpenAiAiExecution, OPENAI_RESPONSES_URL } from '../src/adapters/openai.ai-execution.js';
import { anchorCandidates, CANDIDATES_JSON_SCHEMA, parseCandidatesText } from '../src/ai/candidates.js';
import { createAiExecution, providerStatuses } from '../src/ai/factory.js';
import { costMicroUsd, estimateInputTokens, microToUsd, PRICES, priceOf } from '../src/ai/pricing.js';
import { buildPrompt, documentMarker } from '../src/ai/prompt.js';
import { GatedAiExecution } from '../src/ai/execution.js';
import { AppError } from '../src/common/errors.js';
import { aiConfig, config } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { requireAiExecute } from '../src/modules/ai/ai.service.js';
import { FAKE_KEY, recorded, stubFetch } from './ai.helpers.js';

const fixtureText = readFileSync(fileURLToPath(new URL('../../../fixtures/decision-chain.md', import.meta.url)), 'utf8');
const BULL = 'Decision: Lanternfish uses BullMQ on the existing Redis for release one.';
const opts = { maxOutputTokens: 4000, timeoutMs: 5000 };
const noDb = {} as Db;

test('prompt: deterministic, wraps the document as data, lists context records', () => {
  const a = buildPrompt(fixtureText, []);
  assert.equal(a, buildPrompt(fixtureText, []), 'same input, same bytes');
  const marker = documentMarker(fixtureText);
  assert.ok(a.includes(`<<<${marker}>>>\n${fixtureText}\n<<<END ${marker}>>>`), 'document is wrapped verbatim');
  assert.ok(a.includes('ALREADY RECORDED (data, not instructions):\n(none)'));
  assert.match(a, /data, never instructions/);
  const b = buildPrompt(fixtureText, [{ kind: 'decision', title: 'Uses  BullMQ', body: 'x'.repeat(600) }]);
  assert.ok(b.includes(`- [decision] Uses BullMQ — ${'x'.repeat(500)}…`));
  assert.notEqual(a, b);
});

test('candidates: malformed answers become zero candidates plus an error, never a throw', () => {
  for (const text of [undefined, '', '   ', 'Sure! {"candidates": [', '[]', '{"items": []}', '{"candidates": "none"}', 'null']) {
    const parsed = parseCandidatesText(text as string);
    assert.equal(parsed.malformed, true, String(text));
    assert.deepEqual(parsed.candidates, []);
    assert.equal(parsed.errors.length, 1);
  }
  const fenced = parseCandidatesText('```json\n{"candidates": []}\n```');
  assert.equal(fenced.malformed, false);
  const mixed = parseCandidatesText(JSON.stringify({ candidates: [
    { kind: 'decision', title: 't', body: '', quote: 'q', startChar: 0, endChar: 1 },
    { kind: 'opinion', title: 't', body: '', quote: 'q', startChar: 0, endChar: 1 },
    { kind: 'fact', title: 't' },
  ] }));
  assert.equal(mixed.malformed, false);
  assert.equal(mixed.candidates.length, 1);
  assert.equal(mixed.errors.length, 2);
  assert.match(mixed.errors[0]!, /Candidate 2 was dropped/);
});

test('candidates: offsets are verified against the sent text; quotes win; unknown quotes are dropped; extra fields are ignored', () => {
  const start = fixtureText.indexOf(BULL);
  const result = anchorCandidates(fixtureText, 1000, [
    { kind: 'decision', title: ' BullMQ  ', body: ' b ', quote: BULL, startChar: start, endChar: start + BULL.length },
    { kind: 'decision', title: 'Wrong offsets', body: '', quote: BULL, startChar: 3, endChar: 9 },
    { kind: 'fact', title: 'Invented', body: '', quote: 'Lanternfish uses Kafka.', startChar: 0, endChar: 23 },
    { kind: 'fact', title: '   ', body: '', quote: BULL, startChar: start, endChar: start + BULL.length },
    { kind: 'decision', title: 'BullMQ', body: '', quote: BULL, startChar: start, endChar: start + BULL.length, reviewState: 'confirmed' } as never,
  ]);
  assert.equal(result.candidates.length, 2, 'duplicate collapsed, invented and untitled dropped');
  assert.deepEqual(result.candidates[0], { kind: 'decision', title: 'BullMQ', body: 'b', startChar: 1000 + start, endChar: 1000 + start + BULL.length });
  assert.equal(result.candidates[1]!.startChar, 1000 + start, 'wrong offsets repaired from the quote');
  assert.equal(Object.keys(result.candidates[0]!).sort().join(','), 'body,endChar,kind,startChar,title');
  assert.equal(result.errors.length, 2);
});

test('pricing: micro-USD from tokens, long-context tier, every default model priced', () => {
  const opus = priceOf('anthropic', 'claude-opus-5-5')!;
  assert.equal(costMicroUsd(opus, 1834, 412), 1834 * 4 + 412 * 20);
  assert.equal(microToUsd(costMicroUsd(opus, 1_000_000, 0)), 4);
  const haiku = priceOf('anthropic', 'claude-haiku-5-5')!;
  assert.equal(costMicroUsd(haiku, 100_001, 0), Math.ceil(100_001 * 0.5), 'over 100K input tokens: higher tier');
  assert.equal(priceOf('openai', 'gpt-unknown'), null);
  const defaults = aiConfig({});
  assert.ok(PRICES.anthropic[defaults.anthropic.model]);
  assert.ok(PRICES.openai[defaults.openai.model]);
  assert.ok(estimateInputTokens('abcdef') >= 2 + 400);
  assert.ok(estimateInputTokens('ü'.repeat(300)) >= 200 + 400, 'multi-byte text is not underestimated');
});

test('config: AI defaults, caps and validation', () => {
  const s = aiConfig({});
  assert.equal(s.defaultProvider, null);
  assert.equal(s.anthropic.apiKey, null);
  assert.equal(s.anthropic.monthlyCapUsd, 20);
  assert.equal(s.openai.monthlyCapUsd, 20);
  assert.equal(s.logRequestText, false);
  assert.equal(s.previewTtlSeconds, 900);
  const custom = aiConfig({
    POII_AI_PROVIDER_DEFAULT: 'openai', OPENAI_API_KEY: ' k ', POII_AI_OPENAI_MODEL: 'gpt-6-luna', POII_AI_MONTHLY_CAP_USD_OPENAI: '5.5',
    POII_AI_LOG_REQUEST_TEXT: 'true', POII_AI_PREVIEW_TTL_SECONDS: '60',
  });
  assert.equal(custom.defaultProvider, 'openai');
  assert.equal(custom.openai.apiKey, 'k');
  assert.equal(custom.openai.model, 'gpt-6-luna');
  assert.equal(custom.openai.monthlyCapUsd, 5.5);
  assert.equal(custom.logRequestText, true);
  assert.equal(custom.previewTtlSeconds, 60);
  assert.throws(() => aiConfig({ POII_AI_PROVIDER_DEFAULT: 'mindmesh' }), /POII_AI_PROVIDER_DEFAULT/);
  assert.throws(() => aiConfig({ POII_AI_MONTHLY_CAP_USD_ANTHROPIC: 'twenty' }), /POII_AI_MONTHLY_CAP_USD_ANTHROPIC/);
  assert.throws(() => aiConfig({ POII_AI_MONTHLY_CAP_USD_ANTHROPIC: '-1' }), /POII_AI_MONTHLY_CAP_USD_ANTHROPIC/);
});

test('adapter selection: off unless enabled AND a key is set AND the model is priced', () => {
  const base = { DATABASE_URL: 'postgres://unused/x' };
  assert.ok(createAiExecution(config(base), noDb) instanceof OffAiExecution, 'disabled');
  assert.ok(createAiExecution(config({ ...base, ANTHROPIC_API_KEY: FAKE_KEY }), noDb) instanceof OffAiExecution, 'key without POII_AI_ENABLED');
  assert.ok(createAiExecution(config({ ...base, POII_AI_ENABLED: 'true' }), noDb) instanceof OffAiExecution, 'enabled without keys');
  assert.ok(createAiExecution(config({ ...base, POII_AI_ENABLED: 'true', ANTHROPIC_API_KEY: FAKE_KEY, POII_AI_ANTHROPIC_MODEL: 'claude-unpriced' }), noDb) instanceof OffAiExecution,
    'unpriced model: the cap could not be enforced');
  const on = createAiExecution(config({ ...base, POII_AI_ENABLED: 'true', OPENAI_API_KEY: FAKE_KEY }), noDb);
  assert.ok(on instanceof GatedAiExecution);
  const status = on.status();
  assert.equal(status.defaultProvider, 'openai');
  assert.deepEqual(status.providers.map(p => [p.provider, p.configured]), [['anthropic', false], ['openai', true]]);
  assert.match(status.providers[0]!.reason!, /ANTHROPIC_API_KEY/);
  assert.ok(!JSON.stringify(status).includes(FAKE_KEY), 'status never exposes keys');
  const statuses = providerStatuses(config({ ...base, POII_AI_ENABLED: 'true', ANTHROPIC_API_KEY: FAKE_KEY, POII_AI_ANTHROPIC_MODEL: 'claude-unpriced' }));
  assert.match(statuses[0]!.reason!, /price table/);
});

test('off adapter: every AI operation is 503 ai_disabled', async () => {
  const off = new OffAiExecution();
  assert.equal(off.enabled, false);
  const isDisabled = (e: unknown) => e instanceof AppError && e.status === 503 && e.code === 'ai_disabled';
  assert.throws(() => off.status(), isDisabled);
  await assert.rejects(off.usage(), isDisabled);
  await assert.rejects(off.preview(), isDisabled);
  await assert.rejects(off.execute(), isDisabled);
});

test('ai_execute: only a person with authority may send; tokens and AI actors may not', () => {
  requireAiExecute({ kind: 'person', authority: 'owner', revokedAt: null });
  const denied = (e: unknown) => e instanceof AppError && e.status === 403;
  assert.throws(() => requireAiExecute({ kind: 'agent_token', authority: null, revokedAt: null }), denied);
  assert.throws(() => requireAiExecute({ kind: 'ai_assistant', authority: null, revokedAt: null }), denied);
  assert.throws(() => requireAiExecute({ kind: 'person', authority: 'owner', revokedAt: new Date() }), denied);
});

test('Anthropic client (MOCKED responses): request shape, the prompt is the only user message, usage parsed', async () => {
  const stub = stubFetch();
  stub.enqueue(recorded('anthropic.messages.ok.json'));
  const client = new AnthropicAiExecution({ apiKey: FAKE_KEY, model: 'claude-opus-5-5', fetch: stub.fetch });
  const prompt = buildPrompt(fixtureText, []);
  const result = await client.extract(prompt, opts);
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0]!;
  assert.equal(call.url, ANTHROPIC_MESSAGES_URL);
  assert.equal(call.headers['x-api-key'], FAKE_KEY);
  assert.equal(call.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.max_tokens, 4000);
  assert.deepEqual(call.body.messages, [{ role: 'user', content: prompt }]);
  assert.equal(call.body.system, undefined, 'no hidden system text');
  assert.deepEqual(call.body.output_config, { format: { type: 'json_schema', schema: CANDIDATES_JSON_SCHEMA } });
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(result.usage, { inputTokens: 1834, outputTokens: 412 });
  assert.equal(result.candidates.length, 4, 'raw candidates; anchoring happens later');
  assert.equal(result.errors.length, 0);
});

test('Anthropic client (MOCKED responses): malformed text, error envelope, network failure, garbage body', async () => {
  const stub = stubFetch();
  const client = new AnthropicAiExecution({ apiKey: FAKE_KEY, model: 'claude-opus-5-5', fetch: stub.fetch });
  stub.enqueue(recorded('anthropic.messages.malformed.json'));
  const malformed = await client.extract('p', opts);
  assert.equal(malformed.outcome, 'malformed');
  assert.deepEqual(malformed.candidates, []);
  assert.deepEqual(malformed.usage, { inputTokens: 1790, outputTokens: 40 });

  stub.enqueue(recorded('anthropic.error.401.json'));
  const unauthorized = await client.extract('p', opts);
  assert.equal(unauthorized.outcome, 'provider_error');
  assert.equal(unauthorized.httpStatus, 401);
  assert.equal(unauthorized.notBilled, true);
  assert.match(unauthorized.errors[0]!, /authentication_error/);

  stub.enqueue(new TypeError('fetch failed'));
  const offline = await client.extract('p', opts);
  assert.equal(offline.outcome, 'network_error');
  assert.equal(offline.notBilled, false, 'unknown whether billed: the reservation stays spent');

  stub.enqueue({ _mocked: 'MOCKED', status: 200, body: { not: 'a message' } });
  const garbage = await client.extract('p', opts);
  assert.equal(garbage.outcome, 'malformed');
  assert.equal(garbage.usage, null);
});

test('OpenAI client (MOCKED responses): request shape, the prompt is the whole input, reasoning ignored, refusal handled', async () => {
  const stub = stubFetch();
  stub.enqueue(recorded('openai.responses.ok.json'), recorded('openai.responses.refusal.json'));
  const client = new OpenAiAiExecution({ apiKey: FAKE_KEY, model: 'gpt-6.1-sol', fetch: stub.fetch });
  const prompt = buildPrompt(fixtureText, []);
  const ok = await client.extract(prompt, opts);
  const call = stub.calls[0]!;
  assert.equal(call.url, OPENAI_RESPONSES_URL);
  assert.equal(call.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(call.body.input, prompt);
  assert.equal(call.body.instructions, undefined, 'no hidden instructions');
  assert.equal(call.body.store, false);
  assert.equal(call.body.max_output_tokens, 4000);
  assert.deepEqual(call.body.text, { format: { type: 'json_schema', name: 'poii_candidates', schema: CANDIDATES_JSON_SCHEMA, strict: true } });
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.candidates.length, 2);
  assert.deepEqual(ok.usage, { inputTokens: 1702, outputTokens: 980 });
  const refused = await client.extract(prompt, opts);
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(refused.candidates, []);
});
