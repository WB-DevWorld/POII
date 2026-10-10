// Where the backup runner writes poii.backup documents: a local directory or an S3-compatible bucket.
// Both expose the same three operations the runner needs (put, list, delete) plus get for the drill and tests.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { EMPTY_SHA256, sha256Hex, signV4, uriEncode, type SigV4Credentials } from './sigv4.js';

export interface BackupObject {
  key: string;
  size: number;
  lastModified: string | null;
}

export interface BackupTarget {
  /** `local` or `s3`. */
  readonly name: 'local' | 's3';
  /** Human-readable location without credentials, for logs. */
  readonly location: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(): Promise<BackupObject[]>;
  delete(key: string): Promise<void>;
}

const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertObjectName(key: string): void {
  if (!OBJECT_NAME.test(key)) throw new Error(`Invalid backup object name: ${key}`);
}

/** A directory on the local filesystem; objects are plain files directly inside it. */
export class LocalDirTarget implements BackupTarget {
  readonly name = 'local' as const;
  readonly location: string;

  constructor(dir: string) {
    this.location = resolve(dir);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertObjectName(key);
    await mkdir(this.location, { recursive: true });
    const path = join(this.location, key);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertObjectName(key);
    try {
      return new Uint8Array(await readFile(join(this.location, key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(): Promise<BackupObject[]> {
    let names: string[];
    try {
      names = await readdir(this.location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: BackupObject[] = [];
    for (const name of names.sort()) {
      if (!OBJECT_NAME.test(name) || name.endsWith('.tmp')) continue;
      const info = await stat(join(this.location, name));
      if (info.isFile()) out.push({ key: name, size: info.size, lastModified: info.mtime.toISOString() });
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    assertObjectName(key);
    await rm(join(this.location, key), { force: true });
  }
}

export interface S3TargetOptions {
  /** e.g. https://s3.example.com (path-style addressing: <endpoint>/<bucket>/<key>). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Key prefix inside the bucket, e.g. `poii/`; may be empty. */
  prefix: string;
  /**
   * Per-request timeout in ms. Unset: 10 minutes for PutObject, 60 s for list, get and delete. Set (from
   * POII_BACKUP_S3_TIMEOUT_MS): that value for every request.
   */
  timeoutMs?: number | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export const S3_PUT_TIMEOUT_MS = 10 * 60_000;
export const S3_OTHER_TIMEOUT_MS = 60_000;

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]!) : null;
}

/** Parses one ListObjectsV2 response page. */
export function parseListObjectsV2(xml: string): { objects: BackupObject[]; nextToken: string | null } {
  const objects: BackupObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = match[1]!;
    const key = tag(body, 'Key');
    if (key === null) continue;
    objects.push({ key, size: Number(tag(body, 'Size') ?? 0), lastModified: tag(body, 'LastModified') });
  }
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { objects, nextToken: truncated ? tag(xml, 'NextContinuationToken') : null };
}

/** S3-compatible bucket: PutObject, GetObject, ListObjectsV2 and DeleteObject, signed with SigV4, path-style. */
export class S3Target implements BackupTarget {
  readonly name = 's3' as const;
  readonly location: string;
  private readonly endpoint: URL;
  private readonly credentials: SigV4Credentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: S3TargetOptions) {
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== 'https:' && this.endpoint.protocol !== 'http:') throw new Error('POII_BACKUP_S3_ENDPOINT must be an http(s) URL');
    this.credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, region: options.region, service: 's3' };
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.location = `${this.endpoint.origin}/${options.bucket}/${options.prefix}`;
  }

  /** Path-style URL for a key (or the bucket itself when key is empty), each path segment encoded once. */
  url(objectKey: string, query: Record<string, string> = {}): URL {
    const base = this.endpoint.pathname.replace(/\/+$/, '');
    const segments = [this.options.bucket, ...(objectKey ? objectKey.split('/') : [])].map(s => uriEncode(s));
    const url = new URL(this.endpoint.origin);
    url.pathname = `${base}/${segments.join('/')}`;
    // Built by hand so the wire query matches the canonical query exactly (URLSearchParams would write spaces as '+').
    url.search = Object.entries(query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
    return url;
  }

  private async send(method: string, url: URL, body?: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    const payloadSha256 = body ? sha256Hex(body) : EMPTY_SHA256;
    const signed = signV4({ method, url, headers, payloadSha256, date: this.now() }, this.credentials);
    const timeoutMs = this.options.timeoutMs ?? (method === 'PUT' ? S3_PUT_TIMEOUT_MS : S3_OTHER_TIMEOUT_MS);
    return this.fetchImpl(url, {
      method, headers: signed.headers, body: body ? Buffer.from(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async fail(operation: string, key: string, response: Response): Promise<never> {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    const code = tag(text, 'Code');
    throw new Error(`S3 ${operation} ${key || '(bucket)'} failed: HTTP ${response.status}${code ? ` ${code}` : ''}`);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertObjectName(key);
    const objectKey = this.options.prefix + key;
    const response = await this.send('PUT', this.url(objectKey), bytes, { 'content-type': contentType });
    if (!response.ok) await this.fail('PutObject', objectKey, response);
    await response.arrayBuffer().catch(() => undefined);
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertObjectName(key);
    const objectKey = this.options.prefix + key;
    const response = await this.send('GET', this.url(objectKey));
    if (response.status === 404) return null;
    if (!response.ok) await this.fail('GetObject', objectKey, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(): Promise<BackupObject[]> {
    const out: BackupObject[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: this.options.prefix };
      if (token) query['continuation-token'] = token;
      const response = await this.send('GET', this.url('', query));
      if (!response.ok) await this.fail('ListObjectsV2', '', response);
      const page = parseListObjectsV2(await response.text());
      for (const object of page.objects) {
        const name = object.key.slice(this.options.prefix.length);
        if (object.key.startsWith(this.options.prefix) && OBJECT_NAME.test(name)) out.push({ ...object, key: name });
      }
      token = page.nextToken;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    assertObjectName(key);
    const objectKey = this.options.prefix + key;
    const response = await this.send('DELETE', this.url(objectKey));
    if (!response.ok && response.status !== 404) await this.fail('DeleteObject', objectKey, response);
    await response.arrayBuffer().catch(() => undefined);
  }
}
