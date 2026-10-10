import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/common/errors.js';
import { findFirstSpan, firstQueryTerm, safeHeadline } from '../src/domain/search-span.js';
import { DEFAULT_TIMES, mergeTimes } from '../src/domain/times.js';
import { stalenessOf } from '../src/modules/views/views.service.js';
import { OffAiExecution } from '../src/adapters/off.ai-execution.js';
import { isLoopbackUrl } from '../src/adapters/local-owner.identity.js';

test('search span: first positive query term, case-insensitive, whole word', () => {
  assert.equal(firstQueryTerm('-redis "NATS JetStream" or bullmq'), 'NATS');
  assert.equal(firstQueryTerm('or -x'), null);
  const text = 'Line one\nThe nats JetStream decision\n';
  const span = findFirstSpan(text, 'NATS');
  assert.deepEqual(span, { startChar: text.indexOf('nats'), endChar: text.indexOf('nats') + 4, startLine: 2 });
  // Stemmed queries fall back to a prefix and expand to the whole word.
  const decided = findFirstSpan('We decided today', 'decides');
  assert.equal('We decided today'.slice(decided!.startChar, decided!.endChar), 'decided');
  assert.equal(findFirstSpan('nothing here', 'zebra'), null);
});

test('search headline: source text is HTML-escaped, highlights become <b>', () => {
  assert.equal(safeHeadline('<script>\u0002alert\u0003</script> & "x"'), '&lt;script&gt;<b>alert</b>&lt;/script&gt; &amp; &quot;x&quot;');
});

test('times: unknown and conflicting stay explicit', () => {
  const unknown = mergeTimes(DEFAULT_TIMES, { effectiveAtStatus: 'unknown' }, true);
  assert.equal(unknown.effectiveAt, null);
  assert.equal(unknown.effectiveAtStatus, 'unknown');
  const known = mergeTimes(DEFAULT_TIMES, { effectiveAt: '2026-07-08T00:00:00Z' }, true);
  assert.equal(known.effectiveAtStatus, 'known');
  const conflicting = mergeTimes(DEFAULT_TIMES, {
    effectiveAtStatus: 'conflicting', timeConflicts: [{ value: '2026-07-08T00:00:00Z' }, { value: null, note: 'undated catalogue' }],
  }, true);
  assert.equal(conflicting.effectiveAtStatus, 'conflicting');
  assert.equal(conflicting.timeConflicts?.length, 2);
  const isCode = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;
  assert.throws(() => mergeTimes(DEFAULT_TIMES, { effectiveAtStatus: 'conflicting' }, true), isCode('time_conflicts_required'));
  assert.throws(() => mergeTimes(DEFAULT_TIMES, { effectiveAtStatus: 'known' }, true), isCode('time_status_mismatch'));
  assert.throws(() => mergeTimes(DEFAULT_TIMES, { effectiveAt: '2026-01-01T00:00:00Z', effectiveAtStatus: 'unknown' }, true), isCode('time_status_mismatch'));
  // Clearing a known value on update makes it unknown, not silently known.
  const cleared = mergeTimes(known, { effectiveAt: null });
  assert.equal(cleared.effectiveAtStatus, 'unknown');
});

test('staleness: observed within 30 days, stale after, unknown when never observed', () => {
  const now = new Date('2026-10-09T00:00:00Z');
  assert.equal(stalenessOf(null, now).label, 'unknown');
  assert.equal(stalenessOf(new Date('2026-10-01T00:00:00Z'), now).label, 'observed');
  assert.equal(stalenessOf(new Date('2026-06-02T14:07:00Z'), now).label, 'stale');
});

test('AI execution port: the off adapter refuses with ai_disabled', async () => {
  const off = new OffAiExecution();
  assert.equal(off.enabled, false);
  await assert.rejects(off.preview(), (e: unknown) => e instanceof AppError && e.code === 'ai_disabled' && e.status === 503);
  await assert.rejects(off.execute(), (e: unknown) => e instanceof AppError && e.code === 'ai_disabled');
});

test('local-owner adapter only accepts a loopback web origin', () => {
  assert.equal(isLoopbackUrl('http://localhost:3000'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1:3000'), true);
  assert.equal(isLoopbackUrl('http://app.localhost'), true);
  assert.equal(isLoopbackUrl('https://poii.example.com'), false);
});
