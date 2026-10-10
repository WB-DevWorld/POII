// The examples in docs/mindmesh-adapter-contract.md are part of the contract: each fenced block tagged
// `json mindmesh:<Schema>` must parse against that schema, and each `json mindmesh-invalid:<Schema>` must not.
// The example execution is also checked for internal consistency (hash, sizes, spans, cost).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MINDMESH_CONTRACT_V1, MindMeshExecutionRequest, MindMeshExecutionResponse, MindMeshQuoteRequest, MindMeshQuoteResponse,
  mindMeshContractV1Schemas, type MindMeshContractV1SchemaName, type MindMeshPricing,
} from '../src/index.js';

const doc = readFileSync(new URL('../../../docs/mindmesh-adapter-contract.md', import.meta.url), 'utf8');

interface Example { tag: 'mindmesh' | 'mindmesh-invalid'; schema: MindMeshContractV1SchemaName; json: unknown }

const examples: Example[] = [...doc.matchAll(/^```json (mindmesh(?:-invalid)?):(\w+)\r?\n([\s\S]*?)^```/gm)].map(m => {
  const schema = m[2] as MindMeshContractV1SchemaName;
  assert.ok(schema in mindMeshContractV1Schemas, `unknown schema tag ${schema}`);
  return { tag: m[1] as Example['tag'], schema, json: JSON.parse(m[3]!) };
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const micro = (p: MindMeshPricing, input: number, output: number) => {
  const tier = p.longContext && input > p.longContext.overInputTokens ? p.longContext : p;
  return Math.ceil(input * tier.inputUsdPerMTok + output * tier.outputUsdPerMTok);
};
const only = <T>(schema: MindMeshContractV1SchemaName, parse: (v: unknown) => T): T[] =>
  examples.filter(e => e.tag === 'mindmesh' && e.schema === schema).map(e => parse(e.json));

test('the contract document has an example for every v1 schema', () => {
  const tagged = new Set(examples.filter(e => e.tag === 'mindmesh').map(e => e.schema));
  for (const name of Object.keys(mindMeshContractV1Schemas)) assert.ok(tagged.has(name as MindMeshContractV1SchemaName), `no example for ${name}`);
});

test('every valid example parses against its schema', () => {
  for (const e of examples.filter(x => x.tag === 'mindmesh')) {
    const result = mindMeshContractV1Schemas[e.schema].safeParse(e.json);
    assert.ok(result.success, `${e.schema}: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  }
});

test('every invalid example is rejected (a quote never carries text)', () => {
  const invalid = examples.filter(x => x.tag === 'mindmesh-invalid');
  assert.ok(invalid.length > 0);
  for (const e of invalid) assert.equal(mindMeshContractV1Schemas[e.schema].safeParse(e.json).success, false, e.schema);
});

test('the example execution is consistent: hash, sizes, route, spans and cost', () => {
  const [quoteReq] = only('QuoteRequest', v => MindMeshQuoteRequest.parse(v));
  const [quote] = only('QuoteResponse', v => MindMeshQuoteResponse.parse(v));
  const [execReq] = only('ExecutionRequest', v => MindMeshExecutionRequest.parse(v));
  const responses = only('ExecutionResponse', v => MindMeshExecutionResponse.parse(v));
  assert.ok(quoteReq && quote && execReq && responses.length >= 2);

  // The text sent is the text quoted, by hash and size.
  assert.equal(sha256(execReq.promptText), execReq.promptSha256);
  assert.equal(execReq.promptSha256, quoteReq.promptSha256);
  assert.equal(quote.promptSha256, quoteReq.promptSha256);
  assert.equal(execReq.promptText.length, quoteReq.promptChars);
  assert.equal(Buffer.byteLength(execReq.promptText, 'utf8'), quoteReq.promptUtf8Bytes);
  // POII's local estimator (apps/api/src/ai/pricing.ts estimateInputTokens).
  assert.equal(quoteReq.inputTokensEstimate, Math.ceil(quoteReq.promptUtf8Bytes / 3) + 400);
  assert.equal(execReq.quoteId, quote.quoteId);
  assert.equal(execReq.routeId, quote.route.routeId);
  assert.ok(quote.estimatedCostUsd * 1e6 >= micro(quote.pricing, quoteReq.inputTokensEstimate, quoteReq.maxOutputTokens) - 1e-6);

  // The document block, as the prompt defines it: after the opening marker line, before the closing one.
  const open = /<<<(POII-DOCUMENT-[0-9a-f]{16})>>>\n/.exec(execReq.promptText);
  assert.ok(open);
  const start = open.index + open[0].length;
  const end = execReq.promptText.indexOf(`\n<<<END ${open[1]}>>>`);
  const documentText = execReq.promptText.slice(start, end);

  for (const r of responses) {
    assert.equal(r.contractVersion, MINDMESH_CONTRACT_V1);
    assert.equal(r.executionId, execReq.executionId);
    assert.equal(r.quoteId, quote.quoteId);
    assert.deepEqual(r.route, quote.route);
    assert.equal(r.sentPromptSha256, execReq.promptSha256);
    for (const c of r.candidates) assert.equal(documentText.slice(c.startChar, c.endChar), c.quote);
    const expected = r.billed && r.usage ? micro(quote.pricing, r.usage.inputTokens, r.usage.outputTokens) / 1e6 : 0;
    assert.equal(r.costUsd, expected);
  }
  assert.ok(responses.some(r => r.outcome === 'ok' && r.candidates.length > 0));
  assert.ok(responses.some(r => !r.billed));
});

test('the response rules hold beyond the examples', () => {
  const [ok] = only('ExecutionResponse', v => MindMeshExecutionResponse.parse(v)).filter(r => r.outcome === 'ok');
  assert.ok(ok);
  // Unbilled with a cost, a model answer with nothing sent, and candidates on a refusal are all invalid.
  assert.equal(MindMeshExecutionResponse.safeParse({ ...ok, billed: false }).success, false);
  assert.equal(MindMeshExecutionResponse.safeParse({ ...ok, sentPromptSha256: null }).success, false);
  assert.equal(MindMeshExecutionResponse.safeParse({ ...ok, outcome: 'refused' }).success, false);
  // Responses may grow within v1; requests may not.
  assert.equal(MindMeshExecutionResponse.safeParse({ ...ok, extra: 1 }).success, true);
  const [execReq] = only('ExecutionRequest', v => MindMeshExecutionRequest.parse(v));
  assert.equal(MindMeshExecutionRequest.safeParse({ ...execReq, systemPrompt: 'x' }).success, false);
  assert.equal(MindMeshExecutionRequest.safeParse({ ...execReq, contractVersion: 'poii.mindmesh.execution.v2' }).success, false);
});
