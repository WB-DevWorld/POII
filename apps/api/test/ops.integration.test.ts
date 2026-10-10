// #16 ops against real PostgreSQL (fresh databases, dropped afterwards) and a real local backup directory:
// the backup runner writes the poii.backup document and latest.json and records its run; retention deletes the
// oldest documents; a failed run is recorded; /health/version reports it; readiness ignores backup state.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { BackupDocument, HealthVersion, RestoreResponse } from '@poii/contracts';
import { main as backupMain } from '../src/backup-cli.js';
import { opsBackupRun, exportRun } from '../src/db/schema/index.js';
import { BackupService } from '../src/modules/backup/backup.service.js';
import { backupObjectName, LATEST_POINTER, runBackup, type BackupPointer } from '../src/ops/backup-runner.js';
import { LocalDirTarget, type BackupTarget } from '../src/ops/backup-target.js';
import { client, createFreshDatabase, fixture, skipIntegration, startApi, type Client, type TestApi } from './helpers.js';

const BUILD_TIME = '2026-10-10T06:00:00Z';

describe('backup runner, retention and /health/version (integration, fresh databases)', { skip: skipIntegration }, () => {
  let db1: { url: string; drop: () => Promise<void> } | undefined;
  let db2: { url: string; drop: () => Promise<void> } | undefined;
  let api1: TestApi | undefined;
  let api2: TestApi | undefined;
  let c1: Client;
  let c2: Client;
  let backupDir: string;
  const previousBuildTime = process.env.BUILD_TIME;

  const env = (api: TestApi, url: string, keep = '30') => ({
    DATABASE_URL: url, POII_STORAGE_LOCAL_DIR: api.storageDir, POII_BACKUP_TARGET: 'local', POII_BACKUP_LOCAL_DIR: backupDir, POII_BACKUP_KEEP: keep,
  });
  const quiet = () => undefined;

  before(async () => {
    process.env.BUILD_TIME = BUILD_TIME;
    db1 = await createFreshDatabase();
    db2 = await createFreshDatabase();
    api1 = await startApi(db1.url);
    api2 = await startApi(db2.url);
    c1 = client(api1.base);
    c2 = client(api2.base);
    backupDir = mkdtempSync(join(tmpdir(), 'poii-ops-backups-'));
  });

  after(async () => {
    if (previousBuildTime === undefined) delete process.env.BUILD_TIME;
    else process.env.BUILD_TIME = previousBuildTime;
    await api1?.close();
    await api2?.close();
    await db1?.drop();
    await db2?.drop();
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
  });

  test('/health/version before any backup: build, node and migration state, backup null', async () => {
    const response = await fetch(`${api1!.base}/health/version`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = HealthVersion.parse(await response.json());
    assert.equal(body.version, 'test');
    assert.equal(body.builtAt, BUILD_TIME);
    assert.equal(body.node, process.version);
    const shipped = readdirSync(new URL('../drizzle', import.meta.url)).filter(n => n.endsWith('.sql')).sort().map(n => n.replace(/\.sql$/, ''));
    assert.equal(body.migrations.latest, shipped[shipped.length - 1]);
    assert.equal(body.migrations.applied, body.migrations.latest, 'a freshly migrated database is up to date');
    assert.equal(body.backup, null);
  });

  test('runner writes the poii.backup document and latest.json to a local directory and records the run', async () => {
    const source = await c1.post('/v1/sources', { title: 'decision-chain', kind: 'paste', content: fixture('decision-chain', 'ops') });
    assert.equal(source.status, 201);
    const events: Array<Record<string, unknown>> = [];
    const result = await backupMain(env(api1!, db1!.url), event => events.push(event));
    assert.equal(result.status, 'succeeded', String(result.error));
    assert.equal(result.error, null);
    assert.deepEqual(events.map(e => e.event), ['backup.started', 'backup.written', 'backup.finished']);

    const files = readdirSync(backupDir).sort();
    assert.deepEqual(files, [LATEST_POINTER, result.objectKey].sort());
    assert.match(result.objectKey!, /^poii-backup-[0-9a-f-]{36}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
    const bytes = readFileSync(join(backupDir, result.objectKey!));
    const doc = BackupDocument.parse(JSON.parse(bytes.toString('utf8')));
    const pointer = JSON.parse(readFileSync(join(backupDir, LATEST_POINTER), 'utf8')) as BackupPointer;
    assert.equal(pointer.format, 'poii.backup-pointer');
    assert.equal(pointer.objectKey, result.objectKey);
    assert.equal(pointer.workspaceId, doc.workspace.id);
    assert.equal(pointer.byteLength, bytes.byteLength);
    assert.equal(pointer.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(pointer.counts.sources, 1);
    assert.equal(pointer.counts.revisions, 1);
    assert.equal(pointer.counts.auditEvents, doc.auditEvents.length);
    assert.ok(result.objectKey!.includes(doc.workspace.id));
    assert.ok(doc.revisions.every(r => typeof r.originalBase64 === 'string' && r.originalBase64.length > 0), 'original bytes inlined');

    const rows = await api1!.db.orm.select().from(opsBackupRun);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.status, 'succeeded');
    assert.equal(row.target, 'local');
    assert.equal(row.objectKey, result.objectKey);
    assert.equal(row.byteLength, bytes.byteLength);
    assert.equal(row.sha256, pointer.sha256);
    assert.equal(row.error, null);
    assert.equal(row.workspaceId, doc.workspace.id);
    assert.ok(row.finishedAt && row.finishedAt >= row.startedAt);

    // The export_run says where the document went; no copy accumulates in the storage volume.
    const run = (await api1!.db.orm.select().from(exportRun)).find(r => r.id === doc.exportRunId)!;
    assert.equal(run.kind, 'backup');
    assert.equal(run.storageKey, null);
    assert.deepEqual((run.manifest as { destination: unknown }).destination, { target: 'local', objectKey: result.objectKey, backupRunId: result.runId });
    assert.equal(existsSync(join(api1!.storageDir, 'backups')), false);

    const version = HealthVersion.parse(await (await fetch(`${api1!.base}/health/version`)).json());
    assert.deepEqual(version.backup, { lastRunAt: row.startedAt.toISOString(), lastTarget: 'local', lastStatus: 'succeeded' });
  });

  test('retention keeps the newest N documents, deletes the oldest, leaves other files alone', async () => {
    const ws = (await c1.get('/v1/me')).body.workspace.id as string;
    const old = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'].map(t => backupObjectName(ws, new Date(t)));
    for (const name of old) writeFileSync(join(backupDir, name), '{}');
    writeFileSync(join(backupDir, 'notes.txt'), 'not a backup');
    const before = readdirSync(backupDir).filter(n => n.startsWith('poii-backup-') && !old.includes(n));
    assert.equal(before.length, 1, 'the document of the previous run');

    const result = await backupMain(env(api1!, db1!.url, '2'), quiet);
    assert.equal(result.status, 'succeeded', String(result.error));
    assert.deepEqual(result.deleted, old, 'the three oldest, oldest first');
    assert.deepEqual(readdirSync(backupDir).sort(), [LATEST_POINTER, before[0]!, result.objectKey!, 'notes.txt'].sort());
    const pointer = JSON.parse(readFileSync(join(backupDir, LATEST_POINTER), 'utf8')) as BackupPointer;
    assert.equal(pointer.objectKey, result.objectKey, 'latest.json points at the newest document');
  });

  test('the runner output restores into an empty install with matching counts', async () => {
    // An empty install has nothing to back up: the run is recorded as failed.
    const empty = await backupMain(env(api2!, db2!.url), quiet);
    assert.equal(empty.status, 'failed');
    assert.match(empty.error!, /no workspace yet/);
    assert.equal((await api2!.db.orm.select().from(opsBackupRun))[0]!.status, 'failed');

    const pointer = JSON.parse(readFileSync(join(backupDir, LATEST_POINTER), 'utf8')) as BackupPointer;
    const doc = JSON.parse(readFileSync(join(backupDir, pointer.objectKey), 'utf8'));
    const restored = await c2.post('/v1/restore', { backup: doc });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(RestoreResponse.parse(restored.body).restored, pointer.counts);
    assert.equal((await c2.get('/v1/me')).body.workspace.id, pointer.workspaceId);
  });

  test('a failed run is recorded and reported, and readiness ignores it', async () => {
    const broken: BackupTarget = {
      name: 'local', location: 'broken', get: async () => null, list: async () => [], delete: async () => undefined,
      put: async () => { throw new Error('disk full (simulated)'); },
    };
    const backupService = api1!.app.get(BackupService);
    const result = await runBackup({ db: api1!.db, backupService, target: broken, keep: 30 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'disk full (simulated)');
    const row = (await api1!.db.orm.select().from(opsBackupRun)).find(r => r.id === result.runId)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'disk full (simulated)');
    assert.equal(row.objectKey, null);
    assert.ok(row.finishedAt);

    const version = HealthVersion.parse(await (await fetch(`${api1!.base}/health/version`)).json());
    assert.equal(version.backup?.lastStatus, 'failed');
    const ready = await fetch(`${api1!.base}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');

    // Even without the ops table (e.g. a new image before its migration ran) version degrades and readiness holds.
    await api1!.db.pool.query('DROP TABLE ops_backup_run');
    const degraded = HealthVersion.parse(await (await fetch(`${api1!.base}/health/version`)).json());
    assert.equal(degraded.backup, null);
    assert.equal((await fetch(`${api1!.base}/health/ready`)).status, 200);
    assert.equal((await fetch(`${api1!.base}/health/live`)).status, 200);
  });

  test('a local target round-trips bytes and lists only plain backup files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poii-ops-target-'));
    try {
      const target = new LocalDirTarget(join(dir, 'nested', 'new'));
      assert.deepEqual(await target.list(), [], 'a missing directory lists empty');
      await target.put('a.json', Buffer.from('x'), 'application/json');
      assert.equal(Buffer.from((await target.get('a.json'))!).toString(), 'x');
      assert.deepEqual((await target.list()).map(o => o.key), ['a.json']);
      await target.delete('a.json');
      await target.delete('a.json');
      assert.equal(await target.get('a.json'), null);
      await assert.rejects(target.put('../x.json', Buffer.from('x'), 'application/json'), /Invalid backup object name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
