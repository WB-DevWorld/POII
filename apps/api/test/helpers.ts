// Shared helpers for integration tests. Integration tests run only when TEST_DATABASE_URL is set; nothing is faked.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { configureHttpApp, createApp, type Ports } from '../src/app.module.js';
import { config, type Settings } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skipIntegration = !TEST_DATABASE_URL;

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url));

/** A fixture's text with a unique trailer, so parallel runs never deduplicate into each other's sources. */
export function fixture(name: 'decision-chain' | 'intent-vs-observed' | 'price-conflict', nonce: string): string {
  return `${readFileSync(join(repoRoot, 'fixtures', `${name}.md`), 'utf8')}\n<!-- test run ${nonce} -->\n`;
}

/** UTF-16 offsets of the n-th occurrence of `needle` in `text`. */
export function span(text: string, needle: string, occurrence = 0): { startChar: number; endChar: number } {
  let from = 0;
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, from);
    if (index === -1) throw new Error(`"${needle}" not found (occurrence ${occurrence})`);
    from = index + 1;
  }
  return { startChar: index, endChar: index + needle.length };
}

export interface TestApi {
  base: string;
  app: INestApplication;
  db: Db;
  settings: Settings;
  ports: Ports;
  storageDir: string;
  close: () => Promise<void>;
}

export async function startApi(databaseUrl: string): Promise<TestApi> {
  const storageDir = mkdtempSync(join(tmpdir(), 'poii-test-storage-'));
  const settings = config({ DATABASE_URL: databaseUrl, GIT_SHA: 'test', PORT: '0', POII_STORAGE_LOCAL_DIR: storageDir });
  const db = createDb(databaseUrl, 4);
  const { module, ports } = createApp(settings, db);
  const app = await NestFactory.create(module, { logger: false, bodyParser: false });
  configureHttpApp(app, ports);
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

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export function client(base: string) {
  async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  return {
    get: <T = any>(path: string, headers?: Record<string, string>) => call<T>('GET', path, undefined, headers),
    post: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => call<T>('POST', path, body ?? {}, headers),
    patch: <T = any>(path: string, body: unknown, headers?: Record<string, string>) => call<T>('PATCH', path, body, headers),
    del: <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => call<T>('DELETE', path, body, headers),
  };
}
export type Client = ReturnType<typeof client>;

/** Creates an empty, migrated database next to TEST_DATABASE_URL. Drop it afterwards. */
export async function createFreshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const name = `poii_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), migrationsDir, () => undefined);
  return {
    url: url.toString(),
    drop: async () => {
      const dropper = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

export const nonce = () => randomUUID().slice(0, 8);
