// Helper commands for infra/scripts/restore-drill.sh (#16). Each command does one step and exits non-zero on any
// mismatch. Databases it creates or drops must be named poii_drill_*; the admin connection comes from
// TEST_DATABASE_URL (or DATABASE_URL). Database URLs are printed only for the calling script to capture.
//
//   free-port                                   print a free TCP port on 127.0.0.1
//   create-db <name>                            create an empty database, print its URL
//   drop-db <name>...                           drop databases (missing ones are fine)
//   wait-ready <baseUrl> [seconds]              poll /health/ready until 200
//   seed <baseUrl> <fixturesDir> <stateFile>    load the three public fixtures and a small decision history
//   verify <baseUrl> <backupDir> <stateFile> <databaseUrl>
//                                               restore latest.json's document and check counts, spans, readiness
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { BackupPointer } from './backup-runner.js';

const DRILL_DB = /^poii_drill_[a-z0-9_]{1,40}$/;
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL (or DATABASE_URL) is required');
  return url;
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

function assertDrillName(name: string | undefined): string {
  if (!name || !DRILL_DB.test(name)) throw new Error(`Refusing database name ${name ?? '(none)'}: drill databases are named poii_drill_*`);
  return name;
}

async function withAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`Drill check failed: ${what}`);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Drill check failed: ${what}: expected ${e}, got ${a}`);
}

async function call<T = any>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function expect<T = any>(base: string, method: string, path: string, status: number, body?: unknown): Promise<T> {
  const reply = await call<T>(base, method, path, body);
  if (reply.status !== status) throw new Error(`${method} ${path}: expected HTTP ${status}, got ${reply.status}: ${JSON.stringify(reply.body).slice(0, 500)}`);
  return reply.body;
}

function span(text: string, needle: string): { startChar: number; endChar: number } {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`Fixture text not found: ${needle}`);
  return { startChar: index, endChar: index + needle.length };
}

export interface DrillState {
  workspaceId: string;
  knownRecordId: string;
  knownSourceId: string;
  knownExcerpt: string;
  supersededRecordId: string;
}

const KNOWN = 'Decision: Lanternfish moves to NATS JetStream for order routing from release two.';

async function seed(base: string, fixturesDir: string, stateFile: string): Promise<void> {
  const read = (name: string) => readFileSync(join(fixturesDir, `${name}.md`), 'utf8');
  const texts = { chain: read('decision-chain'), rate: read('intent-vs-observed'), price: read('price-conflict') };
  const me = await expect(base, 'GET', '/v1/me', 200);
  const paste = (title: string, content: string) => expect(base, 'POST', '/v1/sources', 201, { title, kind: 'paste', content, origin: { fixture: title } });
  const chain = await paste('decision-chain', texts.chain);
  const rate = await paste('intent-vs-observed', texts.rate);
  const price = await paste('price-conflict', texts.price);
  const assistant = await expect(base, 'POST', '/v1/actors', 201, { kind: 'ai_assistant', displayName: 'Chat assistant (pasted)' });
  const ev = (source: { id: string }, text: string, needle: string) => ({ sourceId: source.id, ...span(text, needle), role: 'primary' });
  const create = (body: Record<string, unknown>) => expect(base, 'POST', '/v1/records', 201, body);
  const confirm = (id: string) => expect(base, 'POST', `/v1/records/${id}/confirm`, 200, {});

  const recommendation = await create({
    kind: 'fact', title: 'The assistant recommended RabbitMQ', statementMode: 'pasted', statedRole: 'assistant', statedByActorId: assistant.id,
    evidence: [ev(chain, texts.chain, 'I recommend RabbitMQ.')],
  });
  const question = await create({
    kind: 'question', title: 'Adopt RabbitMQ?', statementMode: 'paraphrased', statedRole: 'assistant', statedByActorId: assistant.id,
    evidence: [ev(chain, texts.chain, 'You should adopt RabbitMQ for Lanternfish.')],
  });
  const bull = await create({
    kind: 'decision', title: 'Lanternfish uses BullMQ', statementMode: 'quoted', statedRole: 'owner', lifecycleStatus: 'decided',
    effectiveAt: '2026-03-04T16:02:00Z', evidence: [ev(chain, texts.chain, 'Decision: Lanternfish uses BullMQ on the existing Redis for release one.')],
  });
  const limit = await create({
    kind: 'requirement', title: 'Partner tokens: 100 requests per minute', statementMode: 'quoted', statedRole: 'owner', lifecycleStatus: 'decided',
    evidence: [ev(rate, texts.rate, 'Each partner token is limited to **100 requests per minute** on the public routing API.')],
  });
  const observed = await create({
    kind: 'fact', title: 'Staging gateway allows 1000 per minute', statementMode: 'quoted', statedRole: 'third_party', lifecycleStatus: 'observed',
    observedAt: '2026-06-02T14:07:00Z', evidence: [ev(rate, texts.rate, 'gateway: rate limit policy loaded: partner_token 1000 req/min, burst 200')],
  });
  const priceDecision = await create({
    kind: 'decision', title: 'Use EUR 12.40 per Type-B widget for Q3', statementMode: 'quoted', statedRole: 'third_party', lifecycleStatus: 'decided',
    evidence: [ev(price, texts.price, 'We use **EUR 12.40** per Type-B widget for the Q3 budget and the first order of 500 units.')],
  });
  for (const r of [recommendation, bull, limit, observed, priceDecision]) await confirm(r.id);
  await expect(base, 'POST', `/v1/records/${question.id}/reject`, 200, { reason: 'Answered by the BullMQ decision' });
  const nats = await expect(base, 'POST', `/v1/records/${bull.id}/supersede`, 201, {
    kind: 'decision', title: 'Lanternfish moves to NATS JetStream from release two', statementMode: 'quoted', statedRole: 'owner',
    lifecycleStatus: 'decided', effectiveAt: '2026-05-19T11:40:00Z', evidence: [ev(chain, texts.chain, KNOWN)],
  });
  const natsConfirmed = await confirm(nats.id);
  same(natsConfirmed.approvals[0].antecedentRecordId, bull.id, 'successor approval names its antecedent');
  const current = await expect<Array<{ record: { id: string } }>>(base, 'GET', '/v1/decisions/current', 200);
  same(current.map(d => d.record.id).sort(), [nats.id, priceDecision.id].sort(), 'current decisions before backup');

  const state: DrillState = { workspaceId: me.workspace.id, knownRecordId: nats.id, knownSourceId: chain.id, knownExcerpt: KNOWN, supersededRecordId: bull.id };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.info(JSON.stringify({ event: 'drill.seeded', sources: 3, records: 7, workspaceId: state.workspaceId }));
}

async function verify(base: string, backupDir: string, stateFile: string, url: string): Promise<void> {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as DrillState;
  const pointer = JSON.parse(readFileSync(join(backupDir, 'latest.json'), 'utf8')) as BackupPointer;
  same(pointer.format, 'poii.backup-pointer', 'pointer format');
  same(pointer.workspaceId, state.workspaceId, 'backed-up workspace');
  const bytes = readFileSync(join(backupDir, pointer.objectKey));
  same(bytes.byteLength, pointer.byteLength, 'document byte length');
  same(sha256(bytes), pointer.sha256, 'document SHA-256');
  const doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> & { format: string; formatVersion: number };
  same([doc.format, doc.formatVersion], ['poii.backup', 1], 'document format');

  const restored = await expect(base, 'POST', '/v1/restore', 200, { backup: doc });
  same(restored.workspaceId, pointer.workspaceId, 'restored workspace id');
  same(restored.restored, pointer.counts, 'restore counts against the manifest');

  // Counted independently in the restored database.
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  let counted: Record<string, number>;
  try {
    const ws = pointer.workspaceId;
    const n = async (sql: string) => Number((await db.query<{ n: string }>(sql, [ws])).rows[0]!.n);
    counted = {
      sources: await n('SELECT count(*) AS n FROM source WHERE workspace_id = $1'),
      revisions: await n('SELECT count(*) AS n FROM source_revision r JOIN source s ON s.id = r.source_id WHERE s.workspace_id = $1'),
      records: await n('SELECT count(*) AS n FROM record WHERE workspace_id = $1'),
      approvals: await n('SELECT count(*) AS n FROM approval a JOIN record r ON r.id = a.record_id WHERE r.workspace_id = $1'),
      evidence: await n('SELECT count(*) AS n FROM record_evidence e JOIN record r ON r.id = e.record_id WHERE r.workspace_id = $1'),
      versions: await n('SELECT count(*) AS n FROM record_version v JOIN record r ON r.id = v.record_id WHERE r.workspace_id = $1'),
      actors: await n('SELECT count(*) AS n FROM actor WHERE workspace_id = $1'),
      tombstones: await n('SELECT count(*) AS n FROM source_tombstone WHERE workspace_id = $1'),
      // The restore itself appends one workspace.restored event.
      auditEvents: await n(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1 AND action <> 'workspace.restored'`),
    };
    same(await n('SELECT count(*) AS n FROM workspace WHERE id <> $1'), 0, 'no other workspace remains');
  } finally {
    await db.end();
  }
  same(counted, pointer.counts, 'database row counts against the manifest');

  const record = await expect(base, 'GET', `/v1/records/${state.knownRecordId}`, 200);
  const evidence = record.evidence[0];
  check(evidence && evidence.available && evidence.sourceId === state.knownSourceId, 'known record cites its source');
  const revision = await expect(base, 'GET', `/v1/sources/${evidence.sourceId}/revisions/${evidence.locator.revisionId}`, 200);
  const excerpt = (revision.contentText as string).slice(evidence.locator.startChar, evidence.locator.endChar);
  same(excerpt, state.knownExcerpt, 'known record resolves to its exact span');
  same(sha256(excerpt), evidence.locator.excerptSha256, 'span hash');
  same(record.approvals.length, 1, 'known record keeps its approval');
  same(record.approvals[0].antecedentRecordId, state.supersededRecordId, 'approval keeps its antecedent');
  const current = await expect<Array<{ record: { id: string } }>>(base, 'GET', '/v1/decisions/current', 200);
  check(current.some(d => d.record.id === state.knownRecordId), 'known decision is current after restore');
  check(!current.some(d => d.record.id === state.supersededRecordId), 'superseded decision is not current after restore');

  const ready = await call(base, 'GET', '/health/ready');
  same([ready.status, ready.body?.status], [200, 'ready'], '/health/ready on the restored install');
  console.info(JSON.stringify({ event: 'drill.verified', objectKey: pointer.objectKey, counts: pointer.counts }));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function waitReady(base: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health/ready`)).status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${base}/health/ready did not answer 200 within ${seconds}s`);
    await new Promise(r => setTimeout(r, 250));
  }
}

async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case 'free-port':
      console.info(await freePort());
      return;
    case 'create-db': {
      const name = assertDrillName(rest[0]);
      await withAdmin(c => c.query(`CREATE DATABASE ${name}`));
      console.info(databaseUrl(name));
      return;
    }
    case 'drop-db':
      for (const raw of rest) {
        const name = assertDrillName(raw);
        await withAdmin(c => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
      }
      return;
    case 'wait-ready':
      await waitReady(rest[0]!, Number(rest[1] ?? 60));
      return;
    case 'seed':
      await seed(rest[0]!, rest[1]!, rest[2]!);
      return;
    case 'verify':
      await verify(rest[0]!, rest[1]!, rest[2]!, rest[3]!);
      return;
    default:
      throw new Error(`Unknown drill command: ${command ?? '(none)'}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
