// Tests for scripts/poii-hook.mjs, the opt-in Claude Code capture hook (issue #21, docs/claude-code-hook.md).
// Run: node --test "infra/scripts/*.test.mjs" (CI runs this in the release-policy step, before pnpm install).
//
// Two suites:
//   1. "against a MOCKED API": an in-process HTTP stub stands in for POII. It is NOT POII; it mimics only what
//      the hook relies on (POST /v1/sources with origin-key and content-hash dedupe, POST /v1/sources/:id/revisions
//      with identical-content no-op and 409 revision_content_exists, GET/POST /v1/actors, bearer check). MOCKED.
//   2. "against the real API": runs only when POII_HOOK_TEST_API_URL points at a running POII API with the
//      local-owner adapter (the test mints its own propose-scoped token as the owner). Nothing is mocked there.
// Transcripts are the fictional fixtures in fixtures/claude-code/; secret-like values are generated here at run
// time so no key-shaped string is committed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_REDACTIONS, buildSource, compileRedactions, extractMessages, readCaptureConfig, redactText,
} from '../../scripts/poii-hook.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/poii-hook.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../fixtures/claude-code/', import.meta.url));
const SESSION_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

// Fake secrets, assembled at run time.
const FAKE = {
  FAKE_ANTHROPIC_KEY: ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-'),
  FAKE_POII_TOKEN: `poii_${'Z'.repeat(43)}`,
  FAKE_DB_PASSWORD: 'correct-horse-battery',
  FAKE_GITHUB_TOKEN: `ghp_${'A'.repeat(36)}`,
};
const NOT_CAPTURED = [
  'QUEUED-NOT-CAPTURED', 'ATTACHMENT-NOT-CAPTURED', 'META-NOT-CAPTURED', 'COMMAND-NOT-CAPTURED', 'THINKING-NOT-CAPTURED',
  'INTERMEDIATE-NOT-CAPTURED', 'TOOL-INPUT-NOT-CAPTURED', 'FILE-CONTENT-NOT-CAPTURED', 'NOTIFICATION-NOT-CAPTURED',
  'NOTIFICATION-ANSWER-NOT-CAPTURED', 'SUBAGENT-NOT-CAPTURED', 'SYSTEM-NOT-CAPTURED', 'TOOL-OUTPUT-NOT-CAPTURED',
  'PRICING.md', '/home/dev',
];

const materialize = text => text.replace(/\{\{(FAKE_[A-Z_]+)\}\}/g, (_, k) => FAKE[k]);
const fixtureText = name => materialize(readFileSync(join(FIXTURES, name), 'utf8'));

let workDir;
before(() => { workDir = mkdtempSync(join(tmpdir(), 'poii-hook-test-')); });
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
/** A temporary project directory, optionally opted in with the given capture.json, plus a transcript file. */
function project({ capture, transcript = fixtureText('session.jsonl'), envFile } = {}) {
  const dir = join(workDir, `lantern-${counter++}`);
  mkdirSync(join(dir, '.poii'), { recursive: true });
  if (capture !== undefined) writeFileSync(join(dir, '.poii', 'capture.json'), typeof capture === 'string' ? capture : JSON.stringify(capture));
  if (envFile) writeFileSync(join(dir, '.poii', 'capture.env.local'), envFile);
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcript);
  return { dir, transcriptPath };
}

const ENABLED = { enabled: true, events: ['Stop'], capture: ['prompts', 'answers'], redact: ['LNT-[0-9]{6}'] };

/** Runs the hook as Claude Code would: event JSON on stdin, a clean environment. */
function runHook(input, env = {}, { killAfterMs = 30_000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const killer = setTimeout(() => child.kill(), killAfterMs);
    child.on('close', code => { clearTimeout(killer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function stopEvent(p, extra = {}) {
  return { session_id: SESSION_ID, transcript_path: p.transcriptPath, cwd: p.dir, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, ...extra };
}

describe('transcript extraction and redaction (unit)', () => {
  test('keeps only typed prompts and the final answer to each', () => {
    const messages = extractMessages(fixtureText('session.jsonl'));
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.match(messages[0].text, /^Lantern needs a price/);
    assert.match(messages[1].text, /^The pricing notes say the starter plan is 9 EUR/);
    assert.equal(messages[1].timestamp, '2026-10-09T08:00:09.000Z');
    assert.match(messages[2].text, /^Use 12 EUR instead/);
    assert.match(messages[3].text, /^Noted: 12 EUR per month/);
    const all = messages.map(m => m.text).join('\n');
    for (const marker of NOT_CAPTURED) assert.ok(!all.includes(marker), `${marker} must not be captured`);
  });

  test('a turn that ends in a tool call has no final answer; Stop\'s last_assistant_message fills it', () => {
    const cut = fixtureText('session-next-turn.jsonl').split('\n').slice(0, 3).join('\n');
    const transcript = `${fixtureText('session.jsonl')}${cut}\n`;
    const without = extractMessages(transcript);
    assert.equal(without.length, 5, 'third prompt captured, no answer yet');
    const withStop = extractMessages(transcript, { lastAssistantMessage: 'Proposed: a yearly plan at 120 EUR.' });
    assert.equal(withStop.length, 6);
    assert.equal(withStop[5].text, 'Proposed: a yearly plan at 120 EUR.');
    assert.equal(withStop[5].timestamp, null);
  });

  test('withholds whole lines with key-like strings and whole private-key blocks', () => {
    const patterns = [...BUILTIN_REDACTIONS, ...compileRedactions(['LNT-[0-9]{6}'])];
    const text = [
      'keep me',
      `token: ${FAKE.FAKE_POII_TOKEN}`,
      ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),
      'b3BlbnNzaC1rZXktdjEAAAAA',
      ['-----END', 'OPENSSH PRIVATE KEY-----'].join(' '),
      'see LNT-654321',
      'password = "averylongpassword"',
      'and keep me too',
    ].join('\n');
    const r = redactText(text, patterns);
    assert.equal(r.text.split('\n')[0], 'keep me');
    assert.equal(r.text.split('\n').at(-1), 'and keep me too');
    assert.equal(r.withheld, 6);
    assert.ok(!r.text.includes('b3BlbnNzaC1rZXktdjEAAAAA'));
    assert.ok(!r.text.includes('LNT-654321'));
    assert.deepEqual(r.patterns.sort(), ['poii-token', 'private-key', 'project-pattern-1', 'secret-assignment']);
  });

  test('message offsets point at the message text in the source', () => {
    const built = buildSource({
      sessionId: SESSION_ID, projectName: 'lantern', messages: extractMessages(fixtureText('session.jsonl')),
      capture: ['prompts', 'answers'], redactions: BUILTIN_REDACTIONS,
    });
    for (const m of built.messages) {
      const slice = built.content.slice(m.startChar, m.endChar);
      assert.ok(slice.length > 0 && !slice.startsWith('---'), `message ${m.index}`);
    }
    assert.deepEqual(built.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  });

  test('capture: ["answers"] drops the prompts', () => {
    const built = buildSource({
      sessionId: SESSION_ID, projectName: 'lantern', messages: extractMessages(fixtureText('session.jsonl')),
      capture: ['answers'], redactions: BUILTIN_REDACTIONS,
    });
    assert.deepEqual(built.messages.map(m => m.role), ['assistant', 'assistant']);
    assert.ok(!built.content.includes('Lantern needs a price'));
  });
});

// ----- MOCKED API ---------------------------------------------------------------------------------------

const STUB_TOKEN = `poii_${'s'.repeat(43)}`;
const sha = s => createHash('sha256').update(s).digest('hex');

/** MOCKED stand-in for the POII API. Not POII: only the behaviour the hook depends on, per docs/api.md. */
async function startStub({ hang = false } = {}) {
  const state = { requests: [], sources: [], actors: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, raw });
      if (hang) return; // never answers
      const json = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return json(401, { error: 'invalid_token' });
      const view = s => ({
        id: s.id, title: s.title, kind: s.kind, origin: s.origin, originKey: s.originKey, aiAllowed: s.aiAllowed,
        currentRevision: { id: `${s.id}-r${s.revisions.length}`, revisionNo: s.revisions.length, byteLength: Buffer.byteLength(s.revisions.at(-1)), contentSha256: sha(s.revisions.at(-1)), note: null },
        revisionCount: s.revisions.length,
      });
      if (req.method === 'GET' && req.url === '/v1/actors') return json(200, state.actors);
      if (req.method === 'POST' && req.url === '/v1/actors') {
        const a = { id: randomUUID(), kind: body.kind, displayName: body.displayName, authority: null, details: body.details, revokedAt: null };
        state.actors.push(a);
        return json(201, a);
      }
      if (req.method === 'POST' && req.url === '/v1/sources') {
        const existing = state.sources.find(s => (body.originKey && s.originKey === body.originKey))
          ?? state.sources.find(s => s.revisions.some(r => sha(r) === sha(body.content)));
        if (existing) return json(200, { ...view(existing), deduplicated: true });
        const s = { id: randomUUID(), title: body.title, kind: body.kind, origin: body.origin, originKey: body.originKey ?? null, aiAllowed: body.aiAllowed, revisions: [body.content] };
        state.sources.push(s);
        return json(201, view(s));
      }
      const m = /^\/v1\/sources\/([^/]+)\/revisions$/.exec(req.url);
      if (req.method === 'POST' && m) {
        const s = state.sources.find(x => x.id === m[1]);
        if (!s) return json(404, { error: 'not_found' });
        if (sha(s.revisions.at(-1)) === sha(body.content)) return json(200, { revisionNo: s.revisions.length });
        const older = s.revisions.findIndex(r => sha(r) === sha(body.content));
        if (older >= 0) return json(409, { error: 'revision_content_exists' });
        s.revisions.push(body.content);
        return json(201, { revisionNo: s.revisions.length });
      }
      return json(404, { error: 'not_found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state, url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

describe('poii-hook against a MOCKED API (in-process stub, not POII)', () => {
  let stub;
  before(async () => { stub = await startStub(); });
  after(async () => { await stub.close(); });
  const env = () => ({ POII_API_URL: stub.url, POII_TOKEN: STUB_TOKEN });
  const fresh = () => { stub.state.requests.length = 0; stub.state.sources.length = 0; stub.state.actors.length = 0; };

  test('no .poii/capture.json: exits 0, sends nothing, prints nothing', async () => {
    fresh();
    const p = project();
    const r = await runHook(stopEvent(p), env());
    assert.equal(r.code, 0);
    assert.equal(stub.state.requests.length, 0);
    assert.equal(r.stderr, '');
  });

  test('"enabled": false, a disabled event, or missing credentials: exits 0 and sends nothing', async () => {
    fresh();
    const off = project({ capture: { ...ENABLED, enabled: false } });
    assert.equal((await runHook(stopEvent(off), env())).code, 0);
    const sessionEndOnly = project({ capture: { ...ENABLED, events: ['SessionEnd'] } });
    assert.equal((await runHook(stopEvent(sessionEndOnly), env())).code, 0);
    const on = project({ capture: ENABLED });
    const noToken = await runHook(stopEvent(on), { POII_API_URL: stub.url });
    assert.equal(noToken.code, 0);
    assert.match(noToken.stderr, /POII_API_URL or POII_TOKEN is not set/);
    const notAToken = await runHook(stopEvent(on), { POII_API_URL: stub.url, POII_TOKEN: 'not-a-poii-token' });
    assert.equal(notAToken.code, 0);
    const plainHttp = await runHook(stopEvent(on), { POII_API_URL: 'http://poii.example.test', POII_TOKEN: STUB_TOKEN });
    assert.equal(plainHttp.code, 0);
    assert.match(plainHttp.stderr, /must use https/);
    const badPattern = project({ capture: { ...ENABLED, redact: ['(unclosed'] } });
    const bad = await runHook(stopEvent(badPattern), env());
    assert.equal(bad.code, 0);
    assert.match(bad.stderr, /capture\.json is invalid/);
    assert.equal(stub.state.requests.length, 0);
  });

  test('enabled: one source with the origin key, paste kind, basename-only origin and only prompts and answers', async () => {
    fresh();
    const p = project({ capture: ENABLED });
    const r = await runHook(stopEvent(p), env());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /new source/);
    const posts = stub.state.requests.filter(q => q.method === 'POST' && q.url === '/v1/sources');
    assert.equal(posts.length, 1);
    assert.ok(stub.state.requests.every(q => q.auth === `Bearer ${STUB_TOKEN}`));
    assert.ok(!stub.state.requests.some(q => /\/v1\/records|confirm|approv/.test(q.url)), 'never touches records or approvals');
    const { body } = posts[0];
    assert.equal(body.kind, 'paste');
    assert.equal(body.originKey, `claude-code:${SESSION_ID}`);
    assert.equal(body.aiAllowed, false);
    assert.equal(body.origin.importedFrom, 'claude-code-hook');
    assert.equal(body.origin.sessionId, SESSION_ID);
    assert.equal(body.origin.cwd, p.dir.split(/[\\/]/).at(-1));
    assert.ok(!/[\\/]/.test(body.origin.cwd));
    assert.ok(!Number.isNaN(Date.parse(body.origin.capturedAt)));
    assert.equal(body.origin.hookEvent, 'Stop');
    assert.equal(body.origin.attribution.assistant.actorName, 'Claude Code (hook)');
    assert.equal(body.origin.attribution.assistant.actorKind, 'ai_assistant');
    assert.equal(body.origin.attribution.assistant.actorId, stub.state.actors[0].id);
    assert.equal(body.origin.attribution.user.statedRole, 'unknown');
    assert.deepEqual(body.origin.messages.map(m => [m.index, m.role]), [[1, 'user'], [2, 'assistant'], [3, 'user'], [4, 'assistant']]);
    assert.match(body.content, /Lantern needs a price for the starter plan/);
    assert.match(body.content, /starter plan is 9 EUR per month/);
    assert.match(body.content, /Noted: 12 EUR per month/);
    const everything = stub.state.requests.map(q => q.raw).join('\n');
    for (const marker of NOT_CAPTURED) assert.ok(!everything.includes(marker), `${marker} must not be sent`);
    assert.ok(!everything.includes(p.transcriptPath.replace(/\\/g, '\\\\')) && !everything.includes(p.transcriptPath), 'no transcript path');
  });

  test('redaction: key-like lines and project patterns are withheld before anything is sent', async () => {
    fresh();
    const p = project({ capture: ENABLED });
    assert.equal((await runHook(stopEvent(p), env())).code, 0);
    const everything = stub.state.requests.map(q => q.raw).join('\n');
    for (const value of Object.values(FAKE)) assert.ok(!everything.includes(value), 'a fake secret was sent');
    assert.ok(!everything.includes('LNT-123456'));
    const { body } = stub.state.requests.find(q => q.url === '/v1/sources');
    assert.match(body.content, /\[withheld by the POII hook: line matched anthropic-key\]/);
    assert.match(body.content, /\[withheld by the POII hook: line matched project-pattern-1\]/);
    assert.equal(body.origin.redaction.withheldLines, 5);
    assert.deepEqual(body.origin.redaction.patterns, ['anthropic-key', 'github-token', 'poii-token', 'project-pattern-1', 'url-with-password']);
  });

  test('idempotent: the same transcript again adds no source and no revision; a longer one adds a revision', async () => {
    fresh();
    const p = project({ capture: ENABLED });
    assert.equal((await runHook(stopEvent(p), env())).code, 0);
    assert.equal((await runHook(stopEvent(p), env())).code, 0);
    assert.equal(stub.state.sources.length, 1);
    assert.equal(stub.state.sources[0].revisions.length, 1);
    assert.equal(stub.state.actors.length, 1, 'the assistant actor is created once');
    writeFileSync(p.transcriptPath, fixtureText('session.jsonl') + fixtureText('session-next-turn.jsonl'));
    const longer = await runHook(stopEvent(p), env());
    assert.equal(longer.code, 0);
    assert.match(longer.stderr, /revision 2 of source/);
    assert.equal(stub.state.sources.length, 1);
    assert.equal(stub.state.sources[0].revisions.length, 2);
    assert.match(stub.state.sources[0].revisions[1], /yearly plan at 120 EUR/);
    // An older, shorter capture arriving late (async hooks) never becomes the current revision.
    writeFileSync(p.transcriptPath, fixtureText('session.jsonl'));
    assert.equal((await runHook(stopEvent(p), env())).code, 0);
    assert.equal(stub.state.sources[0].revisions.length, 2);
  });

  test('credentials from the envFile named in capture.json', async () => {
    fresh();
    const p = project({ capture: { ...ENABLED, envFile: '.poii/capture.env.local' }, envFile: `POII_API_URL=${stub.url}\nPOII_TOKEN="${STUB_TOKEN}"\nOTHER=ignored\n` });
    const r = await runHook(stopEvent(p), {});
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stub.state.sources.length, 1);
  });

  test('SessionEnd works when listed in "events"', async () => {
    fresh();
    const p = project({ capture: { ...ENABLED, events: ['SessionEnd'] } });
    const r = await runHook({ ...stopEvent(p), hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, env());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stub.state.sources[0].origin.hookEvent, 'SessionEnd');
  });

  test('API down: exits 0 promptly', async () => {
    const closed = await startStub();
    const url = closed.url;
    await closed.close();
    const p = project({ capture: ENABLED });
    const r = await runHook(stopEvent(p), { POII_API_URL: url, POII_TOKEN: STUB_TOKEN });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /capture failed/);
    assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  });

  test('API hangs: exits 0 within POII_HOOK_TIMEOUT_MS', async () => {
    const hanging = await startStub({ hang: true });
    try {
      const p = project({ capture: ENABLED });
      const r = await runHook(stopEvent(p), { POII_API_URL: hanging.url, POII_TOKEN: STUB_TOKEN, POII_HOOK_TIMEOUT_MS: '1500' });
      assert.equal(r.code, 0);
      assert.match(r.stderr, /timed out|gave up/);
      assert.ok(r.ms < 4_000, `took ${r.ms} ms`);
    } finally {
      await hanging.close();
    }
  });

  test('garbage on stdin: exits 0', async () => {
    const r = await runHook('not json', env());
    assert.equal(r.code, 0);
  });
});

// ----- real API -----------------------------------------------------------------------------------------

const REAL = process.env.POII_HOOK_TEST_API_URL;

describe('poii-hook against the real API (POII_HOOK_TEST_API_URL, local-owner; nothing mocked)', { skip: !REAL && 'POII_HOOK_TEST_API_URL is not set' }, () => {
  let token;
  const owner = async (method, path, body, headers = {}) => {
    const r = await fetch(`${REAL}${path}`, {
      method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  const asToken = (method, path, body) => owner(method, path, body, { authorization: `Bearer ${token}` });

  before(async () => {
    const minted = await owner('POST', '/v1/tokens', {
      name: 'hook test (propose)', scopes: ['propose'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    token = minted.body.secret;
  });

  test('capture, dedupe, revision, redaction; the hook creates no records; the token cannot confirm', async () => {
    const sessionId = randomUUID();
    const p = project({ capture: ENABLED });
    const event = { ...stopEvent(p), session_id: sessionId };
    const env = { POII_API_URL: REAL, POII_TOKEN: token };

    const first = await runHook(event, env);
    assert.equal(first.code, 0, first.stderr);
    const listed = (await owner('GET', '/v1/sources?limit=200')).body;
    const mine = listed.filter(s => s.originKey === `claude-code:${sessionId}`);
    assert.equal(mine.length, 1);
    const detail = (await owner('GET', `/v1/sources/${mine[0].id}`)).body;
    assert.equal(detail.kind, 'paste');
    assert.equal(detail.aiAllowed, false);
    assert.equal(detail.revisionCount, 1);
    assert.equal(detail.origin.cwd, p.dir.split(/[\\/]/).at(-1));
    const actors = (await owner('GET', '/v1/actors')).body;
    const tokenActor = actors.find(a => a.id === detail.createdByActorId);
    assert.equal(tokenActor.kind, 'agent_token');
    const assistant = actors.find(a => a.id === detail.origin.attribution.assistant.actorId);
    assert.equal(assistant.kind, 'ai_assistant');
    assert.equal(assistant.displayName, 'Claude Code (hook)');
    for (const value of Object.values(FAKE)) assert.ok(!detail.currentRevision.contentText.includes(value));
    for (const marker of NOT_CAPTURED) assert.ok(!detail.currentRevision.contentText.includes(marker), marker);
    assert.deepEqual((await owner('GET', `/v1/sources/${detail.id}/records`)).body, [], 'the hook creates no records');

    assert.equal((await runHook(event, env)).code, 0);
    const again = (await owner('GET', '/v1/sources?limit=200')).body.filter(s => s.originKey === `claude-code:${sessionId}`);
    assert.equal(again.length, 1);
    assert.equal(again[0].revisionCount, 1);

    writeFileSync(p.transcriptPath, fixtureText('session.jsonl') + fixtureText('session-next-turn.jsonl'));
    assert.equal((await runHook(event, env)).code, 0);
    const revised = (await owner('GET', `/v1/sources/${detail.id}`)).body;
    assert.equal(revised.revisionCount, 2);
    assert.match(revised.currentRevision.contentText, /yearly plan at 120 EUR/);

    // The token may propose a candidate citing the capture, but never confirm it.
    const m = revised.origin.messages.find(x => x.role === 'assistant');
    const text = detail.currentRevision.contentText;
    const candidate = await asToken('POST', '/v1/records', {
      kind: 'fact', title: 'Starter plan price per the notes', statementMode: 'quoted', statedRole: 'assistant',
      statedByActorId: assistant.id, evidence: [{ sourceId: detail.id, startChar: m.startChar, endChar: m.endChar }],
    });
    assert.equal(candidate.status, 201, JSON.stringify(candidate.body));
    assert.equal(candidate.body.reviewState, 'candidate');
    assert.ok(text.slice(m.startChar, m.endChar).startsWith('The pricing notes say'));
    const confirm = await asToken('POST', `/v1/records/${candidate.body.id}/confirm`, {});
    assert.equal(confirm.status, 403);
    assert.equal(confirm.body.error, 'authority_required');
  });
});

test('fixtures/claude-code/capture.json is a valid opt-in file', () => {
  const dir = join(workDir ?? mkdtempSync(join(tmpdir(), 'poii-hook-test-')), 'example');
  mkdirSync(join(dir, '.poii'), { recursive: true });
  cpSync(join(FIXTURES, 'capture.json'), join(dir, '.poii', 'capture.json'));
  const config = readCaptureConfig(dir);
  assert.deepEqual(config.events, ['Stop']);
  assert.deepEqual(config.capture, ['prompts', 'answers']);
  assert.equal(config.aiAllowed, false);
  assert.equal(config.redactions.length, BUILTIN_REDACTIONS.length + 1);
});
