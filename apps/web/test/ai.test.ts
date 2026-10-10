// #13 AI: logic of the per-action AI preview page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aiAvailability, aiPageHref, explainAiCode, formatUsd, manualPathHref, parsePreviewForm, wouldExceedCap,
} from '../src/app/sources/[id]/ai/logic';

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

test('never-send wins over AI being on; AI off otherwise falls back to the manual path', () => {
  assert.equal(aiAvailability(false, true), 'never_send');
  assert.equal(aiAvailability(false, false), 'never_send');
  assert.equal(aiAvailability(true, false), 'off');
  assert.equal(aiAvailability(true, true), 'on');
});

test('preview form: whole source, a span, or a readable problem', () => {
  assert.deepEqual(parsePreviewForm(form({ sourceId: 's1', provider: '', startChar: '', endChar: '' })), { ok: true, body: { sourceId: 's1' } });
  assert.deepEqual(parsePreviewForm(form({ sourceId: 's1', provider: 'openai', startChar: ' 10 ', endChar: '42' })), {
    ok: true, body: { sourceId: 's1', provider: 'openai', startChar: 10, endChar: 42 },
  });
  const bad: Array<Record<string, string>> = [
    { sourceId: 's1', startChar: '10', endChar: '' },
    { sourceId: 's1', startChar: '-1', endChar: '5' },
    { sourceId: 's1', startChar: '9', endChar: '9' },
    { sourceId: 's1', provider: 'mindmesh' },
    { sourceId: '' },
  ];
  for (const entries of bad) {
    const parsed = parsePreviewForm(form(entries));
    assert.equal(parsed.ok, false, JSON.stringify(entries));
  }
});

test('money and caps', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.015576), '$0.0156');
  assert.equal(formatUsd(19.984424), '$19.98');
  assert.equal(formatUsd(20), '$20.00');
  assert.equal(wouldExceedCap(0.33, 20), false);
  assert.equal(wouldExceedCap(0.33, 0.32), true);
  assert.equal(wouldExceedCap(0, 0), true, 'at the cap nothing more is sent');
});

test('AI error codes have plain explanations; links keep the span', () => {
  for (const code of ['ai_disabled', 'ai_not_allowed', 'cap_reached', 'preview_expired', 'preview_used', 'preview_stale', 'span_too_large']) {
    assert.ok(explainAiCode(code), code);
  }
  assert.equal(explainAiCode('not_found'), null);
  assert.match(explainAiCode('cap_reached')!, /manual path/);
  assert.equal(aiPageHref('abc', { preview: 'p1', start: undefined }), '/sources/abc/ai?preview=p1');
  assert.equal(aiPageHref('abc'), '/sources/abc/ai');
  assert.equal(manualPathHref('abc', 3, 9), '/sources/abc?start=3&end=9#span');
  assert.equal(manualPathHref('abc'), '/sources/abc');
});
