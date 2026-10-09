import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { config } from '../src/config.js';
import { createApp } from '../src/app.module.js';
import { createDb } from '../src/db/client.js';

test('config refuses to start without a database URL', () => {
  assert.throws(() => config({}), /DATABASE_URL/);
  const settings = config({ DATABASE_URL: 'postgres://x', GIT_SHA: 'abc', POII_AI_ENABLED: 'false' });
  assert.equal(settings.version, 'abc');
  assert.equal(settings.aiEnabled, false);
  assert.equal(settings.identityAdapter, 'local-owner');
});

test('health endpoints report liveness and readiness', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const settings = config({ DATABASE_URL: process.env.TEST_DATABASE_URL, GIT_SHA: 'test-sha', PORT: '0' });
  const db = createDb(settings.databaseUrl, 2);
  const { module: AppModule } = createApp(settings, db);
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const live = await (await fetch(`${base}/health/live`)).json();
    assert.deepEqual(live, { status: 'ok', version: 'test-sha' });
    const readyResponse = await fetch(`${base}/health/ready`);
    assert.equal(readyResponse.status, 200);
    assert.equal(readyResponse.headers.get('cache-control'), 'no-store');
    const ready = await readyResponse.json();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.aiEnabled, false);
  } finally {
    await app.close();
    await db.close();
  }
});
