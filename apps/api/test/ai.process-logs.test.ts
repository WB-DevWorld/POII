// BUILD-BASELINE §8 item 8, first half: "Never send to AI" content never appears in a provider request or its
// LOGS. The audit table is covered in ai.api.test.ts; this file covers what the API process itself writes to
// stdout and stderr (Nest's logger at the levels main.ts uses, console.*, the exception filter's api.error line).
// The test app runs in this process, so process.stdout.write and process.stderr.write are intercepted from before
// the app starts until after it closed, and everything written in between is searched for the never-send text.
// Covered while intercepted: creating never-send sources, a refused preview and a refused execute, AI-context
// reads, an allowed AI execution in the same workspace, a provider failure, a rejected request and a 500 whose
// failing database statement carries never-send text as a parameter.
// MOCKED: provider traffic is the stub fetch from ai.helpers.ts replaying test/recorded/ (no live provider is
// called; the keys are fake). The 500 is forced with a CHECK constraint added to this test's own fresh database.
// Everything else is real: HTTP, NestJS, Drizzle, PostgreSQL, disclosure, the exception filter.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AI_CONTEXT_HEADER, AiExecuteResponse, AiPreviewResponse, SourceView } from '@poii/contracts';
import { createAiExecution } from '../src/ai/factory.js';
import { FAKE_KEY, recorded, startAiApi, stubFetch } from './ai.helpers.js';
import { client, createFreshDatabase, fixture, nonce, skipIntegration, span, type Client, type TestApi } from './helpers.js';

const AI = { [AI_CONTEXT_HEADER]: '1' };
const ANSI = /\u001b\[[0-9;]*m/g;
/** The writers as they were when this file loaded, to prove the interception is undone. */
const ORIGINAL_WRITERS = { stdout: process.stdout.write, stderr: process.stderr.write };

/**
 * Records every chunk written to stdout and stderr. Lines the API writes (Nest's logger, the JSON event lines)
 * are recorded and kept off the terminal; anything else (the test runner's own output) is recorded and passed on.
 * `restore` puts the original writers back and may be called more than once.
 */
function captureProcessOutput() {
  const written: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  const fromApi = (text: string) => text.replace(ANSI, '').startsWith('[Nest] ') || text.startsWith('{"event":"api.');
  for (const stream of ['stdout', 'stderr'] as const) {
    const original = originals[stream];
    process[stream].write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      written.push({ stream, text });
      if (typeof chunk === 'string' && fromApi(text)) {
        const callback = rest.at(-1);
        if (typeof callback === 'function') callback();
        return true;
      }
      return (original as (...args: unknown[]) => boolean).call(process[stream], chunk, ...rest);
    }) as typeof process.stdout.write;
  }
  let restored = false;
  return {
    text: (stream?: 'stdout' | 'stderr') => written.filter(w => !stream || w.stream === stream).map(w => w.text).join(''),
    restore: () => {
      if (restored) return;
      restored = true;
      process.stdout.write = originals.stdout;
      process.stderr.write = originals.stderr;
    },
  };
}

describe('never-send content and the API process output (integration, MOCKED provider responses)', { skip: skipIntegration }, () => {
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>> | undefined;
  let api: TestApi | undefined;
  let c: Client;
  let output: ReturnType<typeof captureProcessOutput> | undefined;
  const stub = stubFetch();
  const run = nonce().replace(/[^a-z0-9]/g, '');

  // Text that exists only in never-send sources, their titles, and a record derived from one.
  const MARKER = `zqneversend${run}marker`;
  const TITLE = `Sealed supplier terms ${run}`;
  const FLIP_MARKER = `zqflipped${run}marker`;
  const FLIP_TITLE = `Sealed later ${run}`;
  const BODY_MARKER = `zqderived${run}body`;
  const FAULT = `zqfault${run}injection`;
  const forbidden = [MARKER, TITLE, FLIP_MARKER, FLIP_TITLE, BODY_MARKER];

  before(async () => {
    fresh = await createFreshDatabase();
    output = captureProcessOutput();
    // The production factory with the MOCKED fetch, and Nest's logger at the levels main.ts uses.
    api = await startAiApi(fresh.url, (settings, db) => createAiExecution(settings, db, stub.fetch), { POII_AI_PROVIDER_DEFAULT: 'anthropic' }, ['error', 'warn', 'log']);
    c = client(api.base);
  });

  after(async () => {
    try {
      await api?.close();
    } finally {
      output?.restore();
      await fresh?.drop();
    }
  });

  test('never-send text and titles never reach stdout or stderr across refusals, AI-context reads, an allowed execution, a provider failure and error paths', async () => {
    const paste = async (title: string, content: string, aiAllowed: boolean) => {
      const r = await c.post('/v1/sources', { title, kind: 'paste', content, aiAllowed });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { ...SourceView.parse(r.body), content };
    };

    // A never-send source, and a record derived from it.
    const sealedText = `Sealed notes ${run}\nThe ${MARKER} clause sets the renewal price.\n`;
    const sealed = await paste(TITLE, sealedText, false);
    const derived = await c.post('/v1/records', {
      kind: 'decision', title: `Renewal decision ${run}`, body: `Details ${BODY_MARKER}`, statementMode: 'quoted', statedRole: 'owner',
      evidence: [{ sourceId: sealed.id, ...span(sealedText, `The ${MARKER} clause sets the renewal price.`) }],
    });
    assert.equal(derived.status, 201, JSON.stringify(derived.body));
    assert.equal(derived.body.aiAllowed, false);
    assert.equal((await c.post(`/v1/records/${derived.body.id}/confirm`, {})).status, 200);

    // Refused preview on the never-send source (whole source, a span, each provider, and as record context).
    for (const body of [{ sourceId: sealed.id }, { sourceId: sealed.id, provider: 'openai', startChar: 0, endChar: 20 }]) {
      const refused = await c.post('/v1/ai/preview', body);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, 'ai_not_allowed');
    }
    // Refused execute: allowed at preview, marked never-send before execute.
    const flipText = `Flip notes ${run}\nDecision: the ${FLIP_MARKER} rollout waits for the audit.\n`;
    const flip = await paste(FLIP_TITLE, flipText, true);
    const flipPreview = AiPreviewResponse.parse((await c.post('/v1/ai/preview', { sourceId: flip.id })).body);
    assert.equal((await c.patch(`/v1/sources/${flip.id}`, { aiAllowed: false })).status, 200);
    const refusedExecute = await c.post('/v1/ai/execute', { previewId: flipPreview.previewId });
    assert.equal(refusedExecute.status, 409);
    assert.equal(refusedExecute.body.error, 'ai_not_allowed');
    assert.equal(stub.calls.length, 0, 'nothing was sent for the refusals');

    // An allowed AI execution in the same workspace (MOCKED provider answer), with the never-send record refused as context.
    const allowedText = fixture('decision-chain', `logs-${run}`);
    const allowed = await paste(`Allowed chain ${run}`, allowedText, true);
    const asContext = await c.post('/v1/ai/preview', { sourceId: allowed.id, recordIds: [derived.body.id] });
    assert.equal(asContext.body.error, 'ai_not_allowed');
    const preview = AiPreviewResponse.parse((await c.post('/v1/ai/preview', { sourceId: allowed.id })).body);
    stub.enqueue(recorded('anthropic.messages.ok.json'));
    const executed = await c.post('/v1/ai/execute', { previewId: preview.previewId });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(AiExecuteResponse.parse(executed.body).outcome, 'ok');
    // A provider failure on allowed material (MOCKED network error).
    const preview2 = AiPreviewResponse.parse((await c.post('/v1/ai/preview', { sourceId: allowed.id, provider: 'openai' })).body);
    stub.enqueue(new Error('MOCKED: connection reset'));
    assert.equal(AiExecuteResponse.parse((await c.post('/v1/ai/execute', { previewId: preview2.previewId })).body).outcome, 'network_error');
    assert.equal(stub.calls.length, 2);
    const sentToProvider = JSON.stringify(stub.calls);
    for (const text of forbidden) assert.ok(!sentToProvider.includes(text), `the provider requests do not contain ${text}`);

    // AI-context reads: lists leave the never-send sources out, direct reads are refused, the derived record is withheld.
    const aiReplies: string[] = [];
    const aiGet = async (path: string, expected: number) => {
      const reply = await c.get(path, AI);
      assert.equal(reply.status, expected, `${path}: ${JSON.stringify(reply.body)}`);
      // A search reply repeats the query it was given; only what was found counts.
      aiReplies.push(JSON.stringify(path.startsWith('/v1/search') ? reply.body.hits : reply.body));
      return reply;
    };
    await aiGet('/v1/sources', 200);
    await aiGet(`/v1/sources/${sealed.id}`, 409);
    await aiGet(`/v1/sources/${sealed.id}/revisions/${sealed.currentRevision.id}`, 409);
    await aiGet(`/v1/sources/${sealed.id}/records`, 409);
    await aiGet(`/v1/sources/${flip.id}`, 409);
    await aiGet('/v1/records', 200);
    const withheld = await aiGet(`/v1/records/${derived.body.id}`, 200);
    assert.equal(withheld.body.contentWithheld, true);
    assert.deepEqual((await aiGet(`/v1/search?q=${MARKER}`, 200)).body.hits, [], 'the never-send source is not searched in AI context');
    await aiGet('/v1/decisions/current', 200);
    const aiSeen = aiReplies.join('\n');
    for (const text of forbidden) assert.ok(!aiSeen.includes(text), `the AI-context replies do not contain ${text}`);

    // Error paths. A rejected request that carries never-send text: nothing is logged for a 4xx.
    const invalid = await c.post('/v1/sources', { title: TITLE, kind: 'not-a-kind', content: sealedText, aiAllowed: false });
    assert.equal(invalid.status, 400);
    // A 500: this database refuses any revision containing FAULT, so the INSERT that carries the never-send text
    // as a statement parameter fails inside the request.
    await api!.db.pool.query(`ALTER TABLE source_revision ADD CONSTRAINT test_fault_injection CHECK (position('${FAULT}' in content_text) = 0)`);
    const failing = await c.post(`/v1/sources/${sealed.id}/revisions`, { content: `${sealedText}Second ${MARKER} paragraph. ${FAULT}\n` });
    assert.equal(failing.status, 500, JSON.stringify(failing.body));
    assert.deepEqual([failing.body.error, failing.body.message], ['internal', 'Internal error']);
    for (const text of [...forbidden, FAULT]) assert.ok(!JSON.stringify(failing.body).includes(text));

    // What the process wrote. First that the interception really sees both streams and both writers.
    const all = output!.text().replace(ANSI, '');
    assert.match(output!.text('stdout').replace(ANSI, ''), /\[Nest\] .*Nest application successfully started/, 'stdout was captured (Nest logger at the main.ts levels)');
    const errorLines = output!.text('stderr').split('\n').filter(line => line.startsWith('{"event":"api.error"'));
    assert.equal(errorLines.length, 1, 'stderr was captured: exactly the one 500 was logged');
    const logged = JSON.parse(errorLines[0]!) as { event: string; requestId: string; method: string; path: string; error: string };
    assert.deepEqual([logged.method, logged.path, logged.requestId], ['POST', `/v1/sources/${sealed.id}/revisions`, failing.body.requestId]);
    assert.match(logged.error, /^DatabaseQueryError: 23514 /, 'the log names the database error without the statement or its parameters');
    assert.ok(!logged.error.includes(FAULT) && !/insert into/i.test(logged.error), logged.error);
    // Then the claim itself.
    for (const text of forbidden) {
      assert.ok(!all.includes(text), `"${text}" must never be written to stdout or stderr; it was found in: ${all.split('\n').find(line => line.includes(text))?.slice(0, 200)}`);
    }
    assert.ok(!all.includes(FAKE_KEY), 'the provider key is not written either');
    assert.ok(!all.includes('Lanternfish uses BullMQ'), 'nor is the text of the allowed source that was sent');
  });

  test('the interception is undone: writes after restore reach the original writers', async () => {
    await api?.close();
    api = undefined;
    const before = output!.text().length;
    output!.restore();
    output!.restore();
    assert.equal(process.stdout.write, ORIGINAL_WRITERS.stdout);
    assert.equal(process.stderr.write, ORIGINAL_WRITERS.stderr);
    process.stderr.write('');
    assert.equal(output!.text().length, before, 'nothing is recorded after restore');
  });
});
