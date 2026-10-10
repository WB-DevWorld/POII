// #16 ops, unit level. Everything S3 here is MOCKED: no real bucket is contacted; fetch is a local fake.
// The SigV4 vectors are the worked examples of the Amazon S3 API reference ("Signature Calculations for the
// Authorization Header: Transferring Payload in a Single Chunk"), with AWS's published example credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { parseListObjectsV2, S3Target } from '../src/ops/backup-target.js';
import { backupObjectName, fileTime, parseBackupName, selectForDeletion } from '../src/ops/backup-runner.js';
import { backupSettings } from '../src/ops/ops-config.js';
import { EMPTY_SHA256, signV4, uriEncode } from '../src/ops/sigv4.js';

const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const EXAMPLE_DATE = new Date('2013-05-24T00:00:00Z');

describe('SigV4 signing (mocked: AWS documentation vectors, no network)', () => {
  test('GET Object example: canonical request, string to sign and signature match the AWS worked example', () => {
    const signed = signV4({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' },
      payloadSha256: EMPTY_SHA256, date: EXAMPLE_DATE,
    }, AWS_EXAMPLE);
    assert.equal(signed.canonicalRequest, [
      'GET', '/test.txt', '',
      'host:examplebucket.s3.amazonaws.com', 'range:bytes=0-9', `x-amz-content-sha256:${EMPTY_SHA256}`, 'x-amz-date:20130524T000000Z', '',
      'host;range;x-amz-content-sha256;x-amz-date', EMPTY_SHA256,
    ].join('\n'));
    assert.equal(signed.stringToSign, [
      'AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request',
      '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    ].join('\n'));
    assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.equal(
      signed.headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
        + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    assert.equal(signed.headers.host, undefined, 'fetch derives Host from the URL');
  });

  test('PUT Object example (encoded key, payload hash, extra signed headers)', () => {
    const body = 'Welcome to Amazon S3.';
    const payloadSha256 = createHash('sha256').update(body).digest('hex');
    assert.equal(payloadSha256, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const signed = signV4({
      method: 'PUT', url: new URL(`https://examplebucket.s3.amazonaws.com/${uriEncode('test$file.text')}`),
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadSha256, date: EXAMPLE_DATE,
    }, AWS_EXAMPLE);
    assert.match(signed.canonicalRequest, /^PUT\n\/test%24file\.text\n\n/);
    assert.equal(signed.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  test('List Objects example (sorted, encoded query string)', () => {
    const signed = signV4({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), payloadSha256: EMPTY_SHA256, date: EXAMPLE_DATE,
    }, AWS_EXAMPLE);
    assert.match(signed.canonicalRequest, /^GET\n\/\nmax-keys=2&prefix=J\n/);
    assert.equal(signed.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  test('uriEncode follows RFC 3986 unreserved characters', () => {
    assert.equal(uriEncode('a b+c/d~e_f.g-h=ü'), 'a%20b%2Bc%2Fd~e_f.g-h%3D%C3%BC');
    assert.equal(uriEncode('a/b', false), 'a/b');
  });
});

interface Seen { method: string; url: string; headers: Record<string, string>; body: Buffer | null; signal: AbortSignal | null }

function fakeFetch(replies: Array<(req: Seen) => Response>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const req: Seen = { method: init?.method ?? 'GET', url: String(input), headers, body: init?.body ? Buffer.from(init.body as Uint8Array) : null, signal: init?.signal ?? null };
    seen.push(req);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${req.method} ${req.url}`);
    return reply(req);
  }) as typeof fetch;
  return { impl, seen };
}

describe('S3 target (mocked: fake fetch, no real bucket)', () => {
  const now = () => new Date('2026-10-10T08:00:00Z');
  const make = (replies: Array<(req: Seen) => Response>) => {
    const fake = fakeFetch(replies);
    const target = new S3Target({
      endpoint: 'https://objects.example.test', bucket: 'backups', accessKeyId: 'TESTKEY', secretAccessKey: 'test-secret-not-real',
      region: 'eu-central', prefix: 'poii/', fetch: fake.impl, now,
    });
    return { target, seen: fake.seen };
  };

  test('PutObject: path-style URL, payload hash, content type, SigV4 authorization', async () => {
    const { target, seen } = make([() => new Response(null, { status: 200 })]);
    const body = Buffer.from('{"format":"poii.backup"}');
    await target.put('poii-backup-x.json', body, 'application/json');
    const req = seen[0]!;
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, 'https://objects.example.test/backups/poii/poii-backup-x.json');
    assert.equal(req.headers['x-amz-content-sha256'], createHash('sha256').update(body).digest('hex'));
    assert.equal(req.headers['x-amz-date'], '20261010T080000Z');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.match(req.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=TESTKEY\/20261010\/eu-central\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.deepEqual(req.body, body);
    assert.ok(req.signal instanceof AbortSignal && !req.signal.aborted, 'every request carries a timeout signal');
    // The signature is reproducible from the request as sent.
    const again = signV4({
      method: 'PUT', url: new URL(req.url), headers: { 'content-type': 'application/json' }, payloadSha256: req.headers['x-amz-content-sha256']!, date: now(),
    }, { accessKeyId: 'TESTKEY', secretAccessKey: 'test-secret-not-real', region: 'eu-central' });
    assert.equal(req.headers.authorization, again.headers.authorization);
  });

  test('ListObjectsV2 follows continuation tokens, strips the prefix and decodes XML', async () => {
    const page = (contents: string, next: string | null) => () => new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>backups</Name><Prefix>poii/</Prefix>${contents}`
      + `<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`,
      { status: 200 },
    );
    const item = (key: string) => `<Contents><Key>${key}</Key><LastModified>2026-10-09T00:00:00.000Z</LastModified><Size>12</Size></Contents>`;
    const { target, seen } = make([
      page(item('poii/a.json') + item('poii/latest.json'), 'tok+en/=='),
      page(item('poii/b.json') + item('poii/nested/c.json') + item('poii/x&amp;y.json'), null),
    ]);
    const objects = await target.list();
    assert.deepEqual(objects.map(o => o.key), ['a.json', 'latest.json', 'b.json'], 'nested keys and invalid names are ignored');
    assert.equal(objects[0]!.size, 12);
    assert.equal(seen[0]!.url, 'https://objects.example.test/backups?list-type=2&prefix=poii%2F');
    assert.equal(seen[1]!.url, 'https://objects.example.test/backups?list-type=2&prefix=poii%2F&continuation-token=tok%2Ben%2F%3D%3D');
    assert.equal(seen[1]!.headers['x-amz-content-sha256'], EMPTY_SHA256);
    assert.deepEqual(parseListObjectsV2('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'), { objects: [], nextToken: null });
  });

  test('requests time out: a hanging endpoint aborts after the configured timeout', async () => {
    const hang = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
    const target = new S3Target({
      endpoint: 'https://objects.example.test', bucket: 'backups', accessKeyId: 'TESTKEY', secretAccessKey: 'test-secret-not-real',
      region: 'eu-central', prefix: 'poii/', fetch: hang, timeoutMs: 50,
    });
    const started = Date.now();
    await assert.rejects(target.list(), (error: Error) => error.name === 'TimeoutError');
    assert.ok(Date.now() - started < 5000);
  });

  test('DeleteObject and GetObject; errors name the S3 code but never the secret', async () => {
    const { target, seen } = make([
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 404 }),
      () => new Response('hello', { status: 200 }),
      () => new Response(null, { status: 404 }),
      () => new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 }),
    ]);
    await target.delete('old.json');
    await target.delete('gone.json');
    assert.equal(seen[0]!.method, 'DELETE');
    assert.equal(seen[0]!.url, 'https://objects.example.test/backups/poii/old.json');
    assert.equal(Buffer.from((await target.get('latest.json'))!).toString(), 'hello');
    assert.equal(await target.get('missing.json'), null);
    await assert.rejects(target.put('x.json', Buffer.from('x'), 'application/json'), (error: Error) => {
      assert.match(error.message, /PutObject poii\/x\.json failed: HTTP 403 AccessDenied/);
      assert.doesNotMatch(error.message, /test-secret-not-real/);
      return true;
    });
    await assert.rejects(target.put('../escape', Buffer.from('x'), 'application/json'), /Invalid backup object name/);
  });
});

describe('backup naming, retention selection and settings', () => {
  test('object names carry the workspace id and a filesystem-safe ISO time', () => {
    const name = backupObjectName('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', new Date('2026-10-10T08:09:10.123Z'));
    assert.equal(name, 'poii-backup-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b-2026-10-10T08-09-10-123Z.json');
    assert.deepEqual(parseBackupName(name), { workspaceId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', time: '2026-10-10T08-09-10-123Z' });
    assert.equal(parseBackupName('latest.json'), null);
    assert.equal(fileTime(new Date('2026-01-02T03:04:05.006Z')), '2026-01-02T03-04-05-006Z');
  });

  test('retention keeps the newest N backup documents and never touches other objects', () => {
    const ws = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const at = (iso: string) => ({ key: backupObjectName(ws, new Date(iso)), size: 1, lastModified: null });
    const objects = [at('2026-10-03T00:00:00Z'), at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z'), at('2026-10-04T00:00:00Z'),
      { key: 'latest.json', size: 1, lastModified: null }, { key: 'notes.txt', size: 1, lastModified: null }];
    assert.deepEqual(selectForDeletion(objects, 2), [at('2026-10-01T00:00:00Z').key, at('2026-10-02T00:00:00Z').key], 'oldest first');
    assert.deepEqual(selectForDeletion(objects, 30), []);
    // The document a run just wrote is never deleted, even if its name sorts as older (clock skew).
    const justWritten = at('2026-10-02T00:00:00Z').key;
    assert.deepEqual(selectForDeletion(objects, 2, justWritten), [at('2026-10-01T00:00:00Z').key]);
  });

  test('backup settings: local by default, s3 needs every credential, keep is at least 1', () => {
    assert.deepEqual(backupSettings({ POII_BACKUP_LOCAL_DIR: '/b' }), { target: 'local', keep: 30, localDir: '/b', s3: null });
    assert.throws(() => backupSettings({}), /POII_BACKUP_LOCAL_DIR/);
    assert.throws(() => backupSettings({ POII_BACKUP_LOCAL_DIR: '/b', POII_BACKUP_KEEP: '0' }), /POII_BACKUP_KEEP/);
    assert.throws(() => backupSettings({ POII_BACKUP_TARGET: 'ftp' }), /Unsupported POII_BACKUP_TARGET/);
    assert.throws(() => backupSettings({ POII_BACKUP_TARGET: 's3', POII_BACKUP_S3_ENDPOINT: 'https://x' }), /POII_BACKUP_S3_BUCKET/);
    const s3 = backupSettings({
      POII_BACKUP_TARGET: 's3', POII_BACKUP_S3_ENDPOINT: 'https://x', POII_BACKUP_S3_BUCKET: 'b', POII_BACKUP_S3_ACCESS_KEY: 'k',
      POII_BACKUP_S3_SECRET_KEY: 's', POII_BACKUP_KEEP: '7', POII_BACKUP_S3_PREFIX: 'team/poii',
    });
    assert.equal(s3.keep, 7);
    assert.deepEqual(s3.s3, {
      endpoint: 'https://x', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', prefix: 'team/poii/', timeoutMs: null,
    });
    const base = { POII_BACKUP_TARGET: 's3', POII_BACKUP_S3_ENDPOINT: 'https://x', POII_BACKUP_S3_BUCKET: 'b', POII_BACKUP_S3_ACCESS_KEY: 'k', POII_BACKUP_S3_SECRET_KEY: 's' };
    assert.equal(backupSettings({ ...base, POII_BACKUP_S3_TIMEOUT_MS: '120000' }).s3!.timeoutMs, 120000);
    assert.throws(() => backupSettings({ ...base, POII_BACKUP_S3_TIMEOUT_MS: 'soon' }), /POII_BACKUP_S3_TIMEOUT_MS/);
  });
});
