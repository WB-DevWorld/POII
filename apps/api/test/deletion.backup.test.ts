// BUILD-BASELINE §8 item 8, second half: "Deletion removes items from search and from future exports."
// Search and the context pack are covered in api.invariants.test.ts. This file covers the other export, the
// backup: a backup taken AFTER a source was deleted holds none of that source's text (not as text, not as the
// base64 original bytes), and restoring that backup into an empty install does not bring the text back
// anywhere (API, search, context pack, any database table, the storage directory).
// What deletion keeps by design (BUILD-BASELINE §5) is asserted too: the tombstone (id, last content hash),
// the records the owner derived from the source, and their evidence marked unavailable with the excerpt hash.
// Real HTTP against two fresh databases with AI and peers off; nothing is mocked.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { BackupDocument, ContextPackResponse, RecordDetail, RestoreResponse, SearchResponse, SourceView } from '@poii/contracts';
import { client, createFreshDatabase, fixture, skipIntegration, span, startApi, type Client, type TestApi } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DELETED_EXCERPT = '[unavailable: source deleted]';
const OBSERVED_LINE = 'gateway: rate limit policy loaded: partner_token 1000 req/min, burst 200';
const OPERATOR_NOTE = 'a partner token made 640 requests in one minute without a 429';
const PRICE_LINE = 'We use **EUR 12.40** per Type-B widget for the Q3 budget and the first order of 500 units.';

/** Every file under `dir`, as UTF-8 text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
  // One listing per directory, entries with their type: nothing is checked first and read later.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [{ path, text: readFileSync(path, 'utf8') }];
  });
}

describe('a deleted source stays out of later backups and of an install restored from them (integration, fresh databases)', { skip: skipIntegration }, () => {
  let first: Awaited<ReturnType<typeof createFreshDatabase>> | undefined;
  let second: Awaited<ReturnType<typeof createFreshDatabase>> | undefined;
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

  test('a backup taken after deleting a source holds none of its text, and restoring it into an empty install does not bring the text back', async () => {
    // The source that will be deleted (the public fixture intent-vs-observed) and one that stays.
    const doomedText = fixture('intent-vs-observed', 'deletion-backup-doomed');
    const keptText = fixture('price-conflict', 'deletion-backup-kept');
    const paste = async (title: string, content: string) => {
      const r = await c1.post('/v1/sources', { title, kind: 'paste', content });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return SourceView.parse(r.body);
    };
    const doomed = await paste('Rate limit note and log', doomedText);
    const kept = await paste('Harbor Supply prices', keptText);

    // Every distinctive line of the deleted source, so "its text" means all of it, not one marker word.
    const doomedLines = [...new Set(doomedText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 12))];
    assert.ok(doomedLines.length >= 10 && doomedLines.includes(OBSERVED_LINE));
    assert.ok(doomedLines.every(line => !keptText.includes(line)), 'the two fixtures share no line');
    const leaked = (text: string) => doomedLines.filter(line => text.includes(line));
    /** The document as JSON plus every original decoded from base64. */
    const backupText = (doc: BackupDocument) => [
      JSON.stringify(doc),
      ...doc.revisions.map(r => Buffer.from(String(r.originalBase64), 'base64').toString('utf8')),
    ].join('\n');

    // Records in the owner's own words: one derived only from the doomed source, one citing both sources.
    const create = async (body: Record<string, unknown>) => {
      const r = await c1.post('/v1/records', body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await c1.post(`/v1/records/${r.body.id}/confirm`, {})).status, 200);
      return RecordDetail.parse((await c1.get(`/v1/records/${r.body.id}`)).body);
    };
    const observation = await create({
      kind: 'fact', title: 'Staging enforces a higher limit than designed', statementMode: 'paraphrased', statedRole: 'owner', lifecycleStatus: 'observed',
      evidence: [
        { sourceId: doomed.id, ...span(doomedText, OBSERVED_LINE) },
        { sourceId: doomed.id, ...span(doomedText, OPERATOR_NOTE), role: 'supporting' },
      ],
    });
    const budget = await create({
      kind: 'decision', title: 'Q3 budget uses the supplier e-mail price', statementMode: 'paraphrased', statedRole: 'owner', lifecycleStatus: 'decided',
      evidence: [
        { sourceId: kept.id, ...span(keptText, PRICE_LINE) },
        { sourceId: doomed.id, ...span(doomedText, 'Nobody has recorded a decision to change the limit.'), role: 'supporting' },
      ],
    });

    // Exports made BEFORE the deletion: they do hold the text (which also proves the leak check can see it).
    const packBefore = ContextPackResponse.parse((await c1.post('/v1/exports/context-pack', {})).body);
    assert.ok(packBefore.markdown.includes(`> ${OBSERVED_LINE}`));
    const backupBefore = BackupDocument.parse((await c1.post('/v1/backup', {})).body);
    assert.equal(backupBefore.sources.length, 2);
    assert.deepEqual(leaked(JSON.stringify(backupBefore)).sort(), [...doomedLines].sort(), 'before the deletion every line is in the backup as text');
    const doomedOriginal = backupBefore.revisions.find(r => r.sourceId === doomed.id)!;
    assert.equal(Buffer.from(String(doomedOriginal.originalBase64), 'base64').toString('utf8'), doomedText, 'and as the original bytes');

    // Delete the source.
    const deleted = await c1.del(`/v1/sources/${doomed.id}`, { reason: 'retention test' });
    assert.equal(deleted.status, 204, JSON.stringify(deleted.body));

    // A backup taken after the deletion.
    const backupReply = await c1.post('/v1/backup', {});
    assert.equal(backupReply.status, 200, JSON.stringify(backupReply.body));
    const backup = BackupDocument.parse(backupReply.body);
    assert.deepEqual(leaked(backupText(backup)), [], 'no line of the deleted source is in the later backup, as text or as original bytes');
    assert.deepEqual(backup.sources.map(s => s.id), [kept.id]);
    assert.deepEqual(backup.revisions.map(r => r.sourceId), [kept.id]);
    assert.equal(Buffer.from(String(backup.revisions[0]!.originalBase64), 'base64').toString('utf8'), keptText, 'the kept source is complete');
    // Kept by design: the tombstone, the derived records with their approvals, and evidence marked unavailable.
    assert.deepEqual(backup.tombstones.map(t => [t.id, t.lastContentSha256, t.reason]), [[doomed.id, sha(doomedText), 'retention test']]);
    assert.deepEqual(backup.records.map(r => r.id).sort(), [observation.id, budget.id].sort());
    assert.equal(backup.approvals.length, 2);
    const orphaned = backup.evidence.filter(e => e.originalSourceId === doomed.id) as Array<{ sourceId: unknown; revisionId: unknown; locator: { excerpt: string; excerptSha256: string } }>;
    assert.equal(orphaned.length, 3);
    for (const e of orphaned) assert.deepEqual([e.sourceId, e.revisionId, e.locator.excerpt], [null, null, DELETED_EXCERPT]);
    assert.ok(orphaned.some(e => e.locator.excerptSha256 === sha(OBSERVED_LINE)), 'the excerpt hash stays so a re-import can be verified');
    assert.ok(backup.exportRuns.some(r => r.id === packBefore.exportRunId) && backup.exportRuns.some(r => r.id === backupBefore.exportRunId),
      'the earlier exports are listed as history (metadata only)');
    const storedCopy = readFileSync(join(api1!.storageDir, 'backups', `${backup.exportRunId}.json`), 'utf8');
    assert.deepEqual(leaked(storedCopy), [], 'the copy the API keeps of this backup is clean too');

    // Restore that backup into an empty install.
    const restoredReply = await c2.post('/v1/restore', { backup });
    assert.equal(restoredReply.status, 200, JSON.stringify(restoredReply.body));
    const restored = RestoreResponse.parse(restoredReply.body).restored;
    assert.deepEqual([restored.sources, restored.revisions, restored.tombstones, restored.records, restored.approvals, restored.evidence], [1, 1, 1, 2, 2, 4]);

    // The restored install does not have the text anywhere a person or a client could read it.
    assert.equal((await c2.get(`/v1/sources/${doomed.id}`)).status, 404);
    assert.deepEqual((await c2.get('/v1/sources')).body.map((s: { id: string }) => s.id), [kept.id]);
    for (const q of ['partner_token', 'burst', 'Retry-After', '"640 requests"', 'lanternfish-gateway']) {
      const hits = SearchResponse.parse((await c2.get(`/v1/search?q=${encodeURIComponent(q)}`)).body).hits;
      assert.deepEqual(hits, [], `search for ${q} finds nothing in the restored install`);
    }
    assert.ok(SearchResponse.parse((await c2.get('/v1/search?q=widget')).body).hits.some(h => h.id === kept.id), 'the kept source is searchable');
    for (const record of [observation, budget]) {
      const here = (await c1.get(`/v1/records/${record.id}`)).body;
      const there = (await c2.get(`/v1/records/${record.id}`)).body;
      assert.deepEqual(there, here, 'the derived record is restored exactly as it stands after the deletion');
      assert.deepEqual(leaked(JSON.stringify(there)), []);
    }
    const restoredObservation = RecordDetail.parse((await c2.get(`/v1/records/${observation.id}`)).body);
    assert.equal(restoredObservation.reviewState, 'confirmed');
    assert.deepEqual(restoredObservation.evidence.map(e => [e.available, e.sourceId, e.originalSourceId, e.locator.excerpt]), [
      [false, null, doomed.id, DELETED_EXCERPT], [false, null, doomed.id, DELETED_EXCERPT],
    ]);
    const packAfter = ContextPackResponse.parse((await c2.post('/v1/exports/context-pack', {})).body);
    assert.deepEqual(packAfter.manifest.unavailable.map(s => [s.sourceId, s.reason, s.contentSha256]), [[doomed.id, 'deleted', sha(doomedText)]]);
    assert.deepEqual(packAfter.manifest.included.map(s => s.sourceId), [kept.id]);
    assert.deepEqual(leaked(packAfter.markdown + JSON.stringify(packAfter.json)), []);
    assert.ok(packAfter.markdown.includes(`> ${PRICE_LINE}`), 'the kept source is still quoted');
    // The pack made before the deletion is history in the restored install; its content (which quoted the source) did not travel.
    assert.equal((await c2.get(`/v1/exports/${packBefore.exportRunId}`)).status, 404);

    // And nowhere underneath: every table of the restored database and every file of its storage directory.
    const tables = (await api2!.db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    )).rows.map(r => r.table_name);
    assert.ok(tables.includes('source_revision') && tables.includes('record_evidence') && tables.includes('audit_event'));
    for (const table of tables) {
      const dump = (await api2!.db.pool.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM "${table}" t`)).rows.map(r => r.row).join('\n');
      assert.deepEqual(leaked(dump), [], `table ${table} of the restored database holds no line of the deleted source`);
    }
    const files = filesUnder(api2!.storageDir);
    assert.ok(files.some(f => f.text === keptText), 'the kept original was written to the restored storage');
    for (const file of files) assert.deepEqual(leaked(file.text), [], `${file.path} holds no line of the deleted source`);
  });
});
