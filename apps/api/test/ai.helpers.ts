// #13 AI test helpers. Provider traffic is MOCKED: a stub fetch replays hand-written responses from
// test/recorded/ (no live provider is ever called; the owner has no keys yet). The stub is injected
// through the adapters' constructors; nothing patches the global fetch.
import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { LocalFsStorage } from '../src/adapters/local-fs.storage.js';
import { LocalOwnerIdentity } from '../src/adapters/local-owner.identity.js';
import { configureHttpApp, createApp } from '../src/app.module.js';
import { config, type Settings } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import type { AiExecutionPort, FetchLike } from '../src/ports/ai-execution.js';
import type { TestApi } from './helpers.js';

const recordedDir = fileURLToPath(new URL('./recorded/', import.meta.url));

export interface Recorded {
  _mocked: string;
  status: number;
  body: unknown;
}

/** A MOCKED provider response from test/recorded/. */
export function recorded(name: string): Recorded {
  const value = JSON.parse(readFileSync(join(recordedDir, name), 'utf8')) as Recorded;
  if (!value._mocked?.startsWith('MOCKED')) throw new Error(`${name} must be labelled MOCKED`);
  return value;
}

export interface StubCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** MOCKED fetch: records every call and answers with queued recorded responses (or throws queued errors). */
export function stubFetch() {
  const calls: StubCall[] = [];
  const queue: Array<Recorded | Error> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) });
    const next = queue.shift();
    if (!next) throw new Error('Unexpected provider call: nothing queued');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls, enqueue: (...items: Array<Recorded | Error>) => queue.push(...items), pending: () => queue.length };
}

export const FAKE_KEY = 'test-not-a-real-key';

/** Settings for a test app with AI on and fake keys (never valid, never sent anywhere real). */
export function aiSettings(databaseUrl: string, storageDir: string, extra: Record<string, string> = {}): Settings {
  return config({
    DATABASE_URL: databaseUrl, GIT_SHA: 'test', PORT: '0', POII_STORAGE_LOCAL_DIR: storageDir,
    POII_AI_ENABLED: 'true', ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, ...extra,
  });
}

/** Starts the real HTTP API with a chosen AI-execution port. */
export async function startAiApi(
  databaseUrl: string,
  buildAi: (settings: Settings, db: Db) => AiExecutionPort,
  extraEnv: Record<string, string> = {},
): Promise<TestApi> {
  const storageDir = mkdtempSync(join(tmpdir(), 'poii-test-ai-storage-'));
  const settings = aiSettings(databaseUrl, storageDir, extraEnv);
  const db = createDb(databaseUrl, 4);
  const ports = {
    identity: new LocalOwnerIdentity(db, settings),
    storage: new LocalFsStorage(settings.storageLocalDir),
    ai: buildAi(settings, db),
  };
  const { module } = createApp(settings, db, ports);
  const app = await NestFactory.create(module, { logger: false });
  configureHttpApp(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    base, app, db, settings, ports, storageDir,
    close: async () => {
      await app.close();
      await db.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}
