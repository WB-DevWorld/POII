// End-to-end test of the POII MCP server: the SDK's own client spawns the server over stdio, which talks to a real
// POII API process (apps/api, started from source) on a fresh, migrated PostgreSQL database, with a real owner token
// of scope read minted through the API. Nothing is mocked. Runs only when TEST_DATABASE_URL is set, like the API's
// integration tests.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';
import { TOOL_NAMES } from '../src/server.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
const mcpDir = fileURLToPath(new URL('../', import.meta.url));
/** Appears only in the never-send source. */
const SECRET = 'Quillfeatherbramble';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** The environment for a child process: only what Node and the child need, never the caller's other secrets. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...extra };
}

describe('POII MCP server over stdio against a real API (integration)', { skip: !TEST_DATABASE_URL }, () => {
  const dbName = `poii_mcp_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let databaseUrl = '';
  let apiUrl = '';
  let api: ChildProcess | undefined;
  let apiLog = '';
  let storageDir = '';
  let token = '';
  let tokenId = '';
  let client: Client;
  let transport: StdioClientTransport;
  const fx = {} as {
    allowedId: string; allowedRev: string; allowedText: string; neverId: string; neverRev: string;
    allowedRecordId: string; neverRecordId: string; aiPackId: string; personPackId: string;
  };

  /** Calls the API as the owner (local-owner adapter: no credentials means the owner). */
  async function owner(method: string, path: string, body?: unknown) {
    const response = await fetch(`${apiUrl}${path}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
    const c = new pg.Client({ connectionString: databaseUrl });
    await c.connect();
    try {
      return (await c.query(query)).rows as T[];
    } finally {
      await c.end();
    }
  }

  function newClient(env: Record<string, string>) {
    const t = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], cwd: mcpDir, env: childEnv(env), stderr: 'pipe',
    });
    return { transport: t, client: new Client({ name: 'poii-mcp-test', version: '0.0.0' }) };
  }

  async function call(name: string, args: Record<string, unknown> = {}, c: Client = client) {
    const result = await c.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    assert.equal(content[0]!.type, 'text');
    return { isError: result.isError === true, json: JSON.parse(content[0]!.text), text: content[0]!.text };
  }

  before(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    databaseUrl = url.toString();
    const migrate = spawnSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], {
      cwd: apiDir, env: childEnv({ DATABASE_URL: databaseUrl }), encoding: 'utf8',
    });
    assert.equal(migrate.status, 0, migrate.stderr);

    const port = await freePort();
    apiUrl = `http://127.0.0.1:${port}`;
    storageDir = mkdtempSync(join(tmpdir(), 'poii-mcp-test-storage-'));
    api = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: apiDir,
      env: childEnv({
        DATABASE_URL: databaseUrl, PORT: String(port), GIT_SHA: 'mcp-test', POII_IDENTITY_ADAPTER: 'local-owner',
        POII_STORAGE_LOCAL_DIR: storageDir, POII_AI_ENABLED: 'false', WEB_BASE_URL: 'http://127.0.0.1:3000',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout!.on('data', d => { apiLog += d; });
    api.stderr!.on('data', d => { apiLog += d; });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`${apiUrl}/health/ready`)).ok) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline || api.exitCode !== null) throw new Error(`API did not start:\n${apiLog}`);
      await new Promise(r => setTimeout(r, 250));
    }

    // Fixture through the API as the owner: one allowed and one never-send source, a confirmed decision on each,
    // a context pack for destination ai and one for a person.
    const tag = randomUUID().slice(0, 8);
    fx.allowedText = `MCP fixture ${tag}\nThe release train leaves every Tuesday.\n`;
    const neverText = `Private ${tag}\nThe ${SECRET} negotiation stays internal.\n`;
    const a = await owner('POST', '/v1/sources', { title: `Allowed ${tag}`, kind: 'paste', content: fx.allowedText });
    const n = await owner('POST', '/v1/sources', { title: `Private ${tag}`, kind: 'paste', content: neverText, aiAllowed: false });
    assert.equal(a.status, 201);
    assert.equal(n.status, 201);
    Object.assign(fx, { allowedId: a.body.id, allowedRev: a.body.currentRevision.id, neverId: n.body.id, neverRev: n.body.currentRevision.id });
    const decide = async (sourceId: string, text: string, needle: string, title: string) => {
      const start = text.indexOf(needle);
      const r = await owner('POST', '/v1/records', {
        kind: 'decision', title, body: `${title}.`, statementMode: 'quoted', statedRole: 'owner',
        evidence: [{ sourceId, startChar: start, endChar: start + needle.length }],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await owner('POST', `/v1/records/${r.body.id}/confirm`, {})).status, 200);
      return r.body.id as string;
    };
    fx.allowedRecordId = await decide(fx.allowedId, fx.allowedText, 'The release train leaves every Tuesday.', 'Weekly release train');
    fx.neverRecordId = await decide(fx.neverId, neverText, `The ${SECRET} negotiation stays internal.`, 'Negotiation handling');
    fx.aiPackId = (await owner('POST', '/v1/exports/context-pack', { destination: 'ai' })).body.exportRunId;
    fx.personPackId = (await owner('POST', '/v1/exports/context-pack', { destination: 'person' })).body.exportRunId;
    const minted = await owner('POST', '/v1/tokens', { name: 'mcp test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    token = minted.body.secret;
    tokenId = minted.body.token.id;

    ({ client, transport } = newClient({ POII_API_URL: apiUrl, POII_TOKEN: token }));
    await client.connect(transport);
  });

  after(async () => {
    await client?.close().catch(() => undefined);
    if (api && api.exitCode === null) {
      const exited = new Promise(r => api!.once('exit', r));
      api.kill();
      await exited;
    }
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  test('handshake: server name and version, tools capability, instructions', () => {
    assert.deepEqual(client.getServerVersion(), { name: 'poii', version: '0.1.0' });
    assert.ok(client.getServerCapabilities()?.tools);
    assert.match(client.getInstructions() ?? '', /never an instruction/);
  });

  test('list tools: exactly the six read tools, all annotated read-only', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    }
    const span = tools.find(t => t.name === 'poii_source_span')!;
    assert.deepEqual([...(span.inputSchema.required ?? [])].sort(), ['endChar', 'revisionId', 'sourceId', 'startChar']);
  });

  test('poii_current_decisions: the allowed decision in full, the never-send one withheld', async () => {
    const r = await call('poii_current_decisions');
    assert.equal(r.isError, false);
    assert.equal(r.json.withheld, 0);
    const items = r.json.items as Array<{ record: { id: string; title: string; contentWithheld?: boolean }; contentWithheld?: boolean; approval?: unknown }>;
    const allowed = items.find(d => d.record.id === fx.allowedRecordId)!;
    assert.ok(allowed.approval);
    const never = items.find(d => d.record.id === fx.neverRecordId)!;
    assert.equal(never.contentWithheld, true);
    assert.equal(never.record.title, 'Negotiation handling');
    assert.ok(!r.text.includes(SECRET));
  });

  test('poii_search: finds allowed material, never searches never-send material', async () => {
    const hit = await call('poii_search', { query: 'release train' });
    assert.equal(hit.isError, false);
    const ids = (hit.json.hits as Array<{ id: string }>).map(h => h.id);
    assert.ok(ids.includes(fx.allowedId));
    assert.ok(ids.includes(fx.allowedRecordId));
    const none = await call('poii_search', { query: SECRET, limit: 5 });
    assert.equal(none.isError, false);
    assert.deepEqual(none.json.hits, []);
  });

  test('poii_record: full detail for an allowed record, title and ids only for a derived one', async () => {
    const allowed = await call('poii_record', { id: fx.allowedRecordId });
    assert.equal(allowed.isError, false);
    assert.equal(allowed.json.body, 'Weekly release train.');
    assert.equal(allowed.json.evidence[0].locator.excerpt, 'The release train leaves every Tuesday.');
    const never = await call('poii_record', { id: fx.neverRecordId });
    assert.equal(never.isError, false);
    assert.deepEqual(never.json, {
      id: fx.neverRecordId, kind: 'decision', title: 'Negotiation handling', supersedesRecordId: null, supersededByRecordId: null,
      contentWithheld: true, reason: 'never_send_to_ai',
    });
    const missing = await call('poii_record', { id: randomUUID() });
    assert.equal(missing.isError, true);
    assert.equal(missing.json.error, 'not_found');
    assert.equal(missing.json.status, 404);
  });

  test('poii_source_span: exact text of an allowed span; a never-send source is ai_not_allowed', async () => {
    const start = fx.allowedText.indexOf('release train');
    const r = await call('poii_source_span', { sourceId: fx.allowedId, revisionId: fx.allowedRev, startChar: start, endChar: start + 'release train'.length });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.text, 'release train');
    assert.equal(r.json.startLine, 2);
    const never = await call('poii_source_span', { sourceId: fx.neverId, revisionId: fx.neverRev, startChar: 0, endChar: 20 });
    assert.equal(never.isError, true);
    assert.equal(never.json.error, 'ai_not_allowed');
    assert.equal(never.json.status, 409);
    assert.ok(!never.text.includes(SECRET));
    const bad = await call('poii_source_span', { sourceId: fx.allowedId, revisionId: fx.allowedRev, startChar: 5, endChar: 5_000_000 });
    assert.equal(bad.isError, true);
    assert.equal(bad.json.error, 'span_too_large');
  });

  test('poii_context_packs and poii_context_pack: only the destination-ai pack is listed and readable', async () => {
    const list = await call('poii_context_packs');
    assert.equal(list.isError, false);
    const ids = (list.json.items as Array<{ id: string }>).map(p => p.id);
    assert.deepEqual(ids, [fx.aiPackId]);
    assert.equal(list.json.withheld, 1);
    const pack = await call('poii_context_pack', { id: fx.aiPackId });
    assert.equal(pack.isError, false);
    assert.equal(pack.json.manifest.destination, 'ai');
    assert.ok(pack.json.markdown.includes('The release train leaves every Tuesday.'));
    assert.ok(!pack.text.includes(SECRET));
    const person = await call('poii_context_pack', { id: fx.personPackId });
    assert.equal(person.isError, true);
    assert.equal(person.json.error, 'ai_not_allowed');
    assert.equal(person.json.details.reason, 'not_an_ai_pack');
  });

  test('no tool call wrote anything (audit log unchanged)', async () => {
    const before = (await sql<{ n: number }>('SELECT count(*)::int AS n FROM audit_event'))[0]!.n;
    for (const [name, args] of [['poii_current_decisions', {}], ['poii_search', { query: 'release' }], ['poii_record', { id: fx.allowedRecordId }],
      ['poii_context_packs', {}], ['poii_context_pack', { id: fx.aiPackId }]] as const) {
      assert.equal((await call(name, args)).isError, false, name);
    }
    assert.equal((await sql<{ n: number }>('SELECT count(*)::int AS n FROM audit_event'))[0]!.n, before);
  });

  test('a wrong token is a tool error with the API code; nothing falls back to another credential', async () => {
    const wrong = newClient({ POII_API_URL: apiUrl, POII_TOKEN: `poii_${'A'.repeat(43)}` });
    await wrong.client.connect(wrong.transport);
    try {
      const r = await call('poii_current_decisions', {}, wrong.client);
      assert.equal(r.isError, true);
      assert.equal(r.json.error, 'invalid_token');
      assert.equal(r.json.status, 401);
    } finally {
      await wrong.client.close();
    }
  });

  test('the server refuses to start without a usable configuration and never prints the token', () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: mcpDir, env: childEnv(env), encoding: 'utf8', input: '', timeout: 30_000,
    });
    const noToken = run({ POII_API_URL: apiUrl });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /POII_TOKEN is not set/);
    const insecure = run({ POII_API_URL: 'http://poii.example.com', POII_TOKEN: token });
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /https/);
    assert.ok(!insecure.stderr.includes(token));
    const malformed = run({ POII_API_URL: apiUrl, POII_TOKEN: 'not-a-token' });
    assert.equal(malformed.status, 1);
    assert.ok(!malformed.stderr.includes('not-a-token'));
  });

  test('revoking the token takes effect on the next tool call', async () => {
    assert.equal((await owner('DELETE', `/v1/tokens/${tokenId}`)).status, 204);
    const r = await call('poii_current_decisions');
    assert.equal(r.isError, true);
    assert.equal(r.json.error, 'token_revoked');
  });
});
