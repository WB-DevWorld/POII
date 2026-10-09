import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiBase } from '../src/lib/api';

test('API base comes from the internal URL and never from the browser', () => {
  const previous = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = 'http://api:3001';
  assert.equal(apiBase(), 'http://api:3001');
  delete process.env.API_INTERNAL_URL;
  assert.equal(apiBase(), 'http://localhost:3001');
  if (previous) process.env.API_INTERNAL_URL = previous;
});
