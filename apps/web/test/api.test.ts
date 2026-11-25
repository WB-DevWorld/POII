import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError, ApiTimeoutError, apiBase, apiJson, apiRaw, issueLines, query, toProblem } from '../src/lib/api';
import { explainCode } from '../src/lib/format';
import { API_LONG_TIMEOUT_MS, API_TIMEOUT_MS } from '../src/lib/timeouts';

test('API base comes from the internal URL and never from the browser', () => {
  const previous = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = 'http://api:3001';
  assert.equal(apiBase(), 'http://api:3001');
  delete process.env.API_INTERNAL_URL;
  assert.equal(apiBase(), 'http://localhost:3001');
  if (previous) process.env.API_INTERNAL_URL = previous;
});

test('API errors become readable problems with code, message and validation issues', () => {
  const problem = toProblem(
    new ApiError(400, {
      error: 'validation_failed',
      message: 'The request did not match the contract',
      requestId: 'req-1',
      details: [{ path: ['evidence', 0, 'endChar'], message: 'Too small' }, { message: 'Bad' }, 'noise'],
    }),
  );
  assert.deepEqual(problem, {
    code: 'validation_failed',
    message: 'The request did not match the contract',
    status: 400,
    requestId: 'req-1',
    issues: ['evidence.0.endChar: Too small', 'Bad'],
  });
  assert.deepEqual(toProblem(new ApiError(502, null)), { code: 'http_502', message: 'The API answered with status 502.', status: 502, requestId: undefined });
  assert.equal(toProblem(new TypeError('fetch failed')).code, 'api_unreachable');
  assert.deepEqual(issueLines('x'), []);
});

test('query drops empty values', () => {
  assert.equal(query({ a: 'x', b: undefined, c: '', d: 0, e: null }), '?a=x&d=0');
  assert.equal(query({}), '');
});

// --- time limits -------------------------------------------------------------------------------------------

type Seen = { url: string; requestId: string | undefined };

/** A stand-in API: `/slow` never answers, `/stall` sends headers and half a body, everything else answers at once. */
async function startApi(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const id = req.headers['x-request-id'];
    seen.push({ url: req.url ?? '', requestId: Array.isArray(id) ? id[0] : id });
    if (req.url === '/slow') return;
    if (req.url === '/stall') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function withApi(run: (api: Awaited<ReturnType<typeof startApi>>) => Promise<void>): Promise<void> {
  const previous = process.env.API_INTERNAL_URL;
  const api = await startApi();
  process.env.API_INTERNAL_URL = api.url;
  try {
    await run(api);
  } finally {
    if (previous) process.env.API_INTERNAL_URL = previous;
    else delete process.env.API_INTERNAL_URL;
    await api.close();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('every call sends its own request id and an answer in time passes through', async () => {
  await withApi(async api => {
    assert.deepEqual(await apiJson('/fine'), { ok: true });
    assert.deepEqual(await apiJson('/fine'), { ok: true });
    assert.equal((await apiRaw('/fine')).status, 200);
    const ids = api.seen.map(call => call.requestId ?? '');
    assert.equal(ids.length, 3);
    for (const id of ids) assert.match(id, UUID);
    assert.equal(new Set(ids).size, 3);
  });
});

test('a call the API never answers ends in api_timeout with the request id that was sent', async () => {
  await withApi(async api => {
    const started = Date.now();
    const error = await apiJson('/slow', { timeoutMs: 150 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(Date.now() - started < 5_000, 'the limit ended the call');
    assert.ok(error instanceof ApiTimeoutError);
    assert.equal(error.timeoutMs, 150);
    assert.equal(error.requestId, api.seen[0]?.requestId);
    assert.deepEqual(toProblem(error), { code: 'api_timeout', message: 'The API did not answer within 0 seconds.', requestId: error.requestId });
    assert.match(explainCode('api_timeout') ?? '', /did not answer in time/);

    await assert.rejects(apiRaw('/slow', { timeoutMs: 150 }), ApiTimeoutError);
  });
});

test('the limit also ends an answer whose body stops arriving', async () => {
  await withApi(async () => {
    await assert.rejects(apiJson('/stall', { timeoutMs: 150 }), ApiTimeoutError);
  });
});

test('a timeout reads as whole seconds, and a refused connection stays api_unreachable', async () => {
  assert.equal(toProblem(new ApiTimeoutError(API_TIMEOUT_MS, 'req-2')).message, 'The API did not answer within 15 seconds.');
  assert.ok(API_LONG_TIMEOUT_MS > 900_000, 'longer than the longest provider wait the API allows');
  const previous = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = 'http://127.0.0.1:9';
  try {
    const error = await apiJson('/fine', { timeoutMs: 5_000 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.equal(toProblem(error).code, 'api_unreachable');
  } finally {
    if (previous) process.env.API_INTERNAL_URL = previous;
    else delete process.env.API_INTERNAL_URL;
  }
});
