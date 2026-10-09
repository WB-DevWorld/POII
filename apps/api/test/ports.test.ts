// Port contract tests: every adapter of a port must pass these (BUILD-BASELINE.md §6).
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalFsStorage } from '../src/adapters/local-fs.storage.js';
import { LocalOwnerIdentity, OWNER_WORKSPACE_NAME } from '../src/adapters/local-owner.identity.js';
import { createDb } from '../src/db/client.js';
import type { StoragePort } from '../src/ports/storage.js';
import { createFreshDatabase, skipIntegration } from './helpers.js';

async function storageContract(storage: StoragePort) {
  const bytes = new TextEncoder().encode('original bytes ü 😀');
  await storage.put('sources/a/b', bytes);
  assert.deepEqual(await storage.get('sources/a/b'), bytes);
  await storage.put('sources/a/b', new Uint8Array([1, 2, 3]));
  assert.deepEqual(await storage.get('sources/a/b'), new Uint8Array([1, 2, 3]), 'put overwrites');
  assert.equal(await storage.get('sources/missing'), null);
  await storage.delete('sources/a/b');
  assert.equal(await storage.get('sources/a/b'), null);
  await storage.delete('sources/a/b'); // deleting a missing key is not an error
  for (const bad of ['../escape', 'a/../../b', '/abs', 'a//b', '']) {
    await assert.rejects(storage.put(bad, bytes), /Invalid storage key/);
  }
}

test('storage port contract: local filesystem adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poii-storage-contract-'));
  try {
    await storageContract(new LocalFsStorage(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('identity port contract: local-owner bootstraps one workspace, owner and system actor, idempotently', { skip: skipIntegration }, async () => {
  const fresh = await createFreshDatabase();
  const db = createDb(fresh.url, 4);
  try {
    const settings = { ownerDisplayName: 'Owner', webBaseUrl: 'http://localhost:3000', allowLocalOwnerRemote: false };
    const a = new LocalOwnerIdentity(db, settings);
    const b = new LocalOwnerIdentity(db, settings);
    const [ra, rb] = await Promise.all([a.resolve({ headers: {} }), b.resolve({ headers: {} })]);
    assert.equal(ra.workspace.id, rb.workspace.id);
    assert.equal(ra.actor.id, rb.actor.id);
    assert.equal(ra.workspace.name, OWNER_WORKSPACE_NAME);
    assert.equal(ra.actor.kind, 'person');
    assert.equal(ra.actor.authority, 'owner');
    assert.equal(await a.resolve({ headers: {} }), await a.resolve({ headers: {} }), 'cached after bootstrap');
    a.invalidate();
    assert.equal((await a.resolve({ headers: {} })).actor.id, ra.actor.id);
    const counts = (await db.pool.query(`SELECT (SELECT count(*) FROM workspace)::int AS ws,
      (SELECT count(*) FROM actor WHERE kind = 'person')::int AS persons, (SELECT count(*) FROM actor WHERE kind = 'system')::int AS systems`)).rows[0];
    assert.deepEqual(counts, { ws: 1, persons: 1, systems: 1 });
    assert.throws(() => new LocalOwnerIdentity(db, { ...settings, webBaseUrl: 'https://poii.example.com' }), /refused/);
    new LocalOwnerIdentity(db, { ...settings, webBaseUrl: 'https://poii.example.com', allowLocalOwnerRemote: true });
  } finally {
    await db.close();
    await fresh.drop();
  }
});
