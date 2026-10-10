import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, apiBase, issueLines, query, toProblem } from '../src/lib/api';

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
