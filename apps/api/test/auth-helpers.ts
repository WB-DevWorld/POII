// Helpers for the sign-in and token integration tests: an API on a random port with chosen identity
// settings, and an HTTP client that keeps Better Auth's session cookie and sends the CSRF header and the web
// app's Origin like the web server does.
import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp, createApp } from '../src/app.module.js';
import { config } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import type { Reply, TestApi } from './helpers.js';

export const OWNER_PASSWORD = 'correct horse battery staple';
/** A test-only signing secret; never used outside tests. */
export const TEST_SESSION_SECRET = 'test-only-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
export const WEB_ORIGIN = 'http://127.0.0.1:3000';
/** Better Auth's session cookie names (cookie prefix `poii`); `__Secure-` when WEB_BASE_URL is not loopback. */
export const API_SESSION_COOKIES = ['poii.session_token', '__Secure-poii.session_token'] as const;

export async function startApiWith(databaseUrl: string, env: Record<string, string> = {}): Promise<TestApi> {
  const storageDir = mkdtempSync(join(tmpdir(), 'poii-test-storage-'));
  const settings = config({
    DATABASE_URL: databaseUrl, GIT_SHA: 'test', PORT: '0', POII_STORAGE_LOCAL_DIR: storageDir, WEB_BASE_URL: WEB_ORIGIN, ...env,
  });
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

/**
 * An API under local-signin with the bootstrap password. POII_TRUST_PROXY is on so every test browser can
 * present its own client address (X-Forwarded-For) to Better Auth's per-address rate limiter.
 */
export const startSigninApi = (databaseUrl: string, env: Record<string, string> = {}) =>
  startApiWith(databaseUrl, {
    POII_IDENTITY_ADAPTER: 'local-signin', POII_OWNER_BOOTSTRAP_PASSWORD: OWNER_PASSWORD, POII_SESSION_SECRET: TEST_SESSION_SECRET,
    POII_TRUST_PROXY: 'true', ...env,
  });

let nextAddress = randomInt(0, 250 * 250);
/** A fresh address from the benchmarking range 198.18.0.0/15 (RFC 2544), so each test browser has its own rate-limit bucket. */
export const testAddress = () => {
  nextAddress = (nextAddress + 1) % (250 * 250);
  return `198.18.${Math.floor(nextAddress / 250)}.${(nextAddress % 250) + 1}`;
};

export interface Browserish {
  /** `name=value` of the API session cookie this browser holds. */
  cookie: string | undefined;
  call<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  get<T = any>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  patch<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  del<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  signIn(username?: string, password?: string): Promise<Reply>;
}

export interface BrowserOptions {
  /** Send `x-poii-csrf: 1` (default true), as the web app does on POII endpoints. */
  csrf?: boolean;
  /** Send `Authorization: Bearer <token>` and no cookie. */
  bearer?: string;
  /** The Origin header (default the web app's); null sends none. */
  origin?: string | null;
  /** Client address sent as X-Forwarded-For (used by the API only with POII_TRUST_PROXY=true). Default: a fresh one; null sends none. */
  address?: string | null;
}

/** A cookie-keeping client, like the web server talking to the API on behalf of one browser. */
export function session(base: string, options: BrowserOptions = {}): Browserish {
  const csrf = options.csrf ?? true;
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  const address = options.address === undefined ? testAddress() : options.address;
  const self: Browserish = {
    cookie: undefined,
    async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(csrf ? { 'x-poii-csrf': '1' } : {}),
          ...(origin ? { origin } : {}),
          ...(address ? { 'x-forwarded-for': address } : {}),
          ...(self.cookie && !options.bearer ? { cookie: self.cookie } : {}),
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';')[0]!;
        const name = pair.slice(0, pair.indexOf('='));
        if (!(API_SESSION_COOKIES as readonly string[]).includes(name)) continue;
        const cleared = pair.length === name.length + 1 || /max-age=0/i.test(line);
        self.cookie = cleared ? undefined : pair;
      }
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text };
        }
      }
      return { status: response.status, headers: response.headers, body: parsed as T };
    },
    get: (path, headers) => self.call('GET', path, undefined, headers),
    post: (path, body, headers) => self.call('POST', path, body ?? {}, headers),
    patch: (path, body, headers) => self.call('PATCH', path, body, headers),
    del: (path, body, headers) => self.call('DELETE', path, body, headers),
    signIn: (username = 'owner', password = OWNER_PASSWORD) => self.post('/v1/auth/sign-in/username', { username, password }),
  };
  return self;
}

/** An ISO time `ms` from now. */
export const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
export const DAY = 86_400_000;
