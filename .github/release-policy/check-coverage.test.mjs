// Tests for the release-policy coverage check. Run: node --test .github/release-policy/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { areasOf, gatedClasses, globToRegex, loadAreas, loadPolicy, repoRoot, trackedFiles, uncovered } from './check-coverage.mjs';

const policy = loadPolicy();
const areas = loadAreas();
const squash = s => s.replace(/\s+/g, '');

test('the glob matcher is the same code as the one inlined in risk-classify.yml', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'risk-classify.yml'), 'utf8');
  const start = yml.indexOf('const globToRegex = glob => {');
  assert.ok(start > 0, 'risk-classify.yml defines globToRegex');
  const end = yml.indexOf('};', start);
  const inlined = yml.slice(start + 'const globToRegex = '.length, end + 1);
  assert.equal(squash(inlined), squash(globToRegex.toString()));
});

test('glob semantics: ** spans directories, * stays within a segment', () => {
  assert.ok(globToRegex('apps/api/src/**/*token*').test('apps/api/src/common/tokens.ts'));
  assert.ok(globToRegex('apps/api/src/**/*token*').test('apps/api/src/tokens.ts'));
  assert.ok(!globToRegex('apps/api/src/*token*').test('apps/api/src/common/tokens.ts'));
  assert.ok(globToRegex('apps/api/src/adapters/*identity*').test('apps/api/src/adapters/local-owner.identity.ts'));
  assert.ok(!globToRegex('apps/api/src/adapters/*identity*').test('apps/api/src/adapters/sub/x.identity.ts'));
  assert.ok(globToRegex('.github/workflows/**').test('.github/workflows/ci.yml'));
});

const mustBeGated = [
  // identity, session, token
  'apps/api/src/common/tokens.ts',
  'apps/api/src/adapters/local-owner.identity.ts',
  'apps/api/src/adapters/local-signin.identity.ts',
  'apps/api/src/modules/identity/identity.service.ts',
  'apps/api/src/modules/auth/auth.controller.ts',
  'apps/api/src/modules/sessions/session.service.ts',
  'apps/api/src/modules/tokens/tokens.repository.ts',
  'apps/api/src/ports/identity.ts',
  'apps/api/src/authorization/authorization.ts',
  'apps/api/src/common/request-context.ts',
  'apps/api/src/common/context.interceptor.ts',
  'apps/web/src/app/signin/page.tsx',
  'apps/web/src/app/tokens/page.tsx',
  'apps/web/src/lib/session.ts',
  'apps/web/src/proxy.ts',
  // deletion and retention
  'apps/api/src/modules/sources/sources.service.ts',
  'apps/api/src/modules/retention/retention.service.ts',
  'apps/api/src/domain/deletion.ts',
  // AI disclosure, caps, budget, providers
  'apps/api/src/ports/ai-execution.ts',
  'apps/api/src/adapters/off.ai-execution.ts',
  'apps/api/src/adapters/anthropic.ai-execution.ts',
  'apps/api/src/adapters/openai.ai-execution.ts',
  'apps/api/src/ai/caps.ts',
  'apps/api/src/ai/disclosure.ts',
  'apps/api/src/ai/budget.ts',
  'apps/api/src/modules/ai/ai.controller.ts',
  'apps/web/src/app/sources/[id]/ai/page.tsx',
  // export and context-pack format
  'apps/api/src/domain/context-pack.ts',
  'apps/api/src/modules/exports/exports.service.ts',
  'packages/contracts/src/api.ts',
  'packages/contracts/src/vocabulary.ts',
  // schema and migrations
  'apps/api/src/db/schema/index.ts',
  'apps/api/src/db/schema/identity.ts',
  'apps/api/src/db/client.ts',
  'apps/api/src/migrate.ts',
  'apps/api/drizzle/0001_domain_model.sql',
  'apps/api/drizzle/meta/_journal.json',
  'apps/api/drizzle.config.ts',
  // release enforcement
  '.github/workflows/ci.yml',
  '.github/workflows/risk-classify.yml',
  '.github/release-policy/risk-classes.json',
  '.github/release-policy/sensitive-areas.json',
  '.github/release-policy/check-coverage.mjs',
  '.github/CODEOWNERS',
  'compose.dokploy.yaml',
  'docs/release-policy.md',
  'infra/scripts/forbidden-material.sh',
  'infra/github/ruleset-protect-main.bot.json',
];

test('every known sensitive path (existing and expected) is in an area and gated', () => {
  for (const file of mustBeGated) {
    assert.ok(areasOf(file, areas).length > 0, `${file} should be in a sensitive area`);
    assert.ok(gatedClasses(file, policy).length > 0, `${file} should be gated`);
  }
});

const routine = [
  'README.md', 'apps/web/src/components/Badges.tsx', 'apps/web/src/app/records/page.tsx', 'apps/api/src/domain/text.ts',
  'apps/api/src/domain/times.ts', 'apps/api/src/main.ts', 'apps/web/src/lib/api.ts', 'apps/web/src/lib/format.ts',
  'apps/api/src/modules/search/search.service.ts', 'apps/api/test/authorization.test.ts', 'docs/api.md', 'fixtures/decision-chain.md',
];

test('ordinary files are neither sensitive nor gated', () => {
  for (const file of routine) {
    assert.deepEqual(areasOf(file, areas).map(a => a.area), [], `${file} should not be in a sensitive area`);
    assert.deepEqual(gatedClasses(file, policy), [], `${file} should be routine`);
  }
});

test('uncovered() reports a sensitive file when the policy misses it', () => {
  const emptyPolicy = { gated: [] };
  const missing = uncovered(['apps/api/src/common/tokens.ts', 'README.md'], emptyPolicy, areas);
  assert.deepEqual(missing.map(m => m.file), ['apps/api/src/common/tokens.ts']);
  assert.deepEqual(uncovered(['apps/api/src/common/tokens.ts'], policy, areas), []);
});

test('every tracked sensitive file in this repository is gated', () => {
  const missing = uncovered(trackedFiles(), policy, areas);
  assert.deepEqual(missing, [], `uncovered: ${missing.map(m => m.file).join(', ')}`);
});
