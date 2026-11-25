// Tests for promotion-class.mjs against an in-process mock of the GitHub REST endpoints it reads.
// The mock imitates response shapes read from GitHub's API on 2026-11-25; it is not GitHub. No network
// beyond 127.0.0.1. Run: node --test "infra/scripts/*.test.mjs"
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  ApiError, MAX_RANGE_COMMITS, PRODUCTION_WORKFLOW_PATH, PromotionError, STAGING_WORKFLOW_PATH,
  classifyRange, compareRange, createApi, findPreviousProduction, readManifest, recheck, resolveStaging,
} from './promotion-class.mjs';

const SCRIPT = fileURLToPath(new URL('./promotion-class.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/deploy-production.yml', import.meta.url));
const REPO = 'Example-Org/POII';
const TOKEN = 'test-token';
const TITLE = 'TITLE-MUST-NOT-BE-PRINTED';
const API_IMAGE = `ghcr.io/wb-devworld/poii-api@sha256:${'2'.repeat(64)}`;
const WEB_IMAGE = `ghcr.io/wb-devworld/poii-web@sha256:${'3'.repeat(64)}`;

/** Commit n of the mock history: a deterministic 40-hex SHA. */
const sha = n => n.toString(16).padStart(8, '0').padEnd(40, 'c');
const sha12 = n => sha(n).slice(0, 12);

/** A merged pull request as `GET /commits/{sha}/pulls` lists it. */
function pull(number, mergeSha, labels, overrides = {}) {
  return {
    number, title: TITLE, user: { login: 'AUTHOR-MUST-NOT-BE-PRINTED' }, state: 'closed', merged_at: '2026-11-25T10:00:00Z', merge_commit_sha: mergeSha,
    base: { ref: 'main', repo: { full_name: REPO } }, labels: labels?.map(name => ({ name, description: 'DESCRIPTION-MUST-NOT-BE-PRINTED' })), ...overrides,
  };
}

/** A linear main history of `count` commits; commit n came in through pull request #n labelled risk:routine. */
function history(count, change = {}) {
  return Array.from({ length: count }, (_, n) => ({ sha: sha(n), pulls: n in change ? change[n] : [pull(n, sha(n), ['risk:routine'])] }));
}

function run(id, path, overrides = {}) {
  return { id, path, event: 'workflow_run', status: 'completed', conclusion: 'success', head_branch: 'main', run_attempt: 1, head_repository: { full_name: REPO }, repository: { full_name: REPO }, ...overrides };
}
const stagingRun = (id, overrides) => run(id, STAGING_WORKFLOW_PATH, overrides);
const productionRun = (id, overrides) => run(id, PRODUCTION_WORKFLOW_PATH, overrides);
const artifact = (runId, name, overrides = {}) => ({ id: runId * 10, name, expired: false, created_at: '2026-11-25T12:00:00Z', workflow_run: { id: runId, head_branch: 'main' }, ...overrides });
const stagingArtifact = (runId, n, attempt = 1, overrides) => artifact(runId, `poii-staging-manifest-${sha(n)}-${attempt}`, overrides);
const productionArtifact = (runId, n, attempt = 1, overrides) => artifact(runId, `poii-production-manifest-${sha(n)}-${attempt}`, overrides);

/**
 * Starts a mock GitHub. World:
 *   history          commits oldest first: { sha, pulls }
 *   runs             runs answered by GET /actions/runs/{id}
 *   productionRuns   runs listed for deploy-production.yml, newest first
 *   artifacts        every artifact
 *   diverged         a base SHA that compare reports as diverged
 *   totalOffset      added to total_commits and ahead_by (an answer that does not add up)
 *   fail(path, hit)  returns an HTTP status to answer instead (hit counts requests to that path from 1)
 */
async function startGitHub(world = {}) {
  const commits = world.history ?? [];
  const hits = new Map();
  const state = { calls: [], world };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { message: 'the script must only read' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    const prefix = `/repos/${REPO}`;
    if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' });
    const path = url.pathname.slice(prefix.length);
    state.calls.push(path + url.search);
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const forced = world.fail?.(path, hits.get(path));
    if (forced) return send(forced, { message: 'SERVER-MESSAGE-MUST-NOT-BE-PRINTED' });
    const perPage = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = list => list.slice((page - 1) * perPage, page * perPage);
    let match;
    if ((match = /^\/actions\/runs\/(\d+)$/.exec(path))) {
      const found = (world.runs ?? []).find(r => String(r.id) === match[1]);
      return found ? send(200, found) : send(404, { message: 'Not Found' });
    }
    if ((match = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(path))) {
      const list = (world.artifacts ?? []).filter(a => String(a.workflow_run.id) === match[1]);
      return send(200, { total_count: list.length, artifacts: slice(list) });
    }
    if (path === '/actions/artifacts') {
      const list = (world.artifacts ?? []).filter(a => a.name === url.searchParams.get('name'));
      return send(200, { total_count: list.length, artifacts: slice(list) });
    }
    if (path === '/actions/workflows/deploy-production.yml/runs') {
      const list = (world.productionRuns ?? []).filter(r => r.conclusion === url.searchParams.get('status') && r.head_branch === url.searchParams.get('branch'));
      return send(200, { total_count: list.length, workflow_runs: slice(list) });
    }
    if ((match = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path))) {
      const base = commits.findIndex(c => c.sha === match[1]);
      const head = commits.findIndex(c => c.sha === match[2]);
      if (base < 0 || head < 0) return send(404, { message: 'Not Found' });
      if (world.diverged === match[1]) return send(200, { status: 'diverged', ahead_by: 1, behind_by: 1, total_commits: 1, merge_base_commit: { sha: sha(0) }, commits: [] });
      if (base === head) return send(200, { status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, merge_base_commit: { sha: match[1] }, commits: [] });
      if (base > head) return send(200, { status: 'behind', ahead_by: 0, behind_by: base - head, total_commits: 0, merge_base_commit: { sha: match[2] }, commits: [] });
      const range = commits.slice(base + 1, head + 1);
      const total = range.length + (world.totalOffset ?? 0);
      return send(200, { status: 'ahead', ahead_by: total, behind_by: 0, total_commits: total, merge_base_commit: { sha: match[1] },
        commits: slice(range).map(c => ({ sha: c.sha, commit: { message: 'MESSAGE-MUST-NOT-BE-PRINTED' } })) });
    }
    if ((match = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path))) {
      const commit = commits.find(c => c.sha === match[1]);
      return commit ? send(200, commit.pulls) : send(404, { message: 'Not Found' });
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, api: createApi({ baseUrl: url, token: TOKEN, repo: REPO, retryDelayMs: 1 }), close: () => new Promise(resolve => server.close(resolve)) };
}

/** Runs fn against a mock GitHub and always closes it. */
async function withGitHub(world, fn) {
  const gh = await startGitHub(world);
  try {
    return await fn(gh);
  } finally {
    await gh.close();
  }
}

let workDir;
let dirCounter = 0;
before(() => { workDir = mkdtempSync(join(tmpdir(), 'poii-promotion-test-')); });
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Writes one manifest file into a fresh directory, as a downloaded artifact would look. */
function manifestDir(environment, n, overrides = {}, fileName) {
  const dir = join(workDir, `manifest-${dirCounter++}`);
  mkdirSync(dir);
  const manifest = { sourceSha: sha(n), api: API_IMAGE, web: WEB_IMAGE, environment, deployedAt: '2026-11-25T13:32:11.730Z', observedReadyVersion: sha(n), previous: null, ...overrides };
  writeFileSync(join(dir, fileName ?? `${environment}-20261125T133211Z-${sha12(n)}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

describe('classifyRange: the promotion class', () => {
  test('routine when every commit came in through a merged pull request labelled risk:routine', async () => {
    await withGitHub({ history: history(5) }, async ({ api, state }) => {
      const result = await classifyRange(api, sha(1), sha(4));
      assert.equal(result.class, 'routine');
      assert.equal(result.relation, 'ahead');
      assert.deepEqual(result.reasons, []);
      assert.deepEqual(result.commits.map(c => c.sha), [sha(2), sha(3), sha(4)]);
      assert.deepEqual(result.commits.map(c => c.pulls[0].number), [2, 3, 4]);
      assert.ok(!state.calls.some(call => call.includes(`/commits/${sha(1)}/`)), 'the previous source itself is not part of the range');
    });
  });

  test('gated when one pull request in the range is labelled risk:gated', async () => {
    await withGitHub({ history: history(6, { 3: [pull(3, sha(3), ['risk:gated'])] }) }, async ({ api }) => {
      const result = await classifyRange(api, sha(1), sha(5));
      assert.equal(result.class, 'gated');
      assert.equal(result.relation, 'ahead');
      assert.equal(result.reasons.length, 1);
      assert.match(result.reasons[0], /#3 .*risk:gated/);
    });
  });

  test('gated when a pull request carries both labels: a label can raise, never lower', async () => {
    await withGitHub({ history: history(3, { 2: [pull(2, sha(2), ['risk:routine', 'risk:gated'])] }) }, async ({ api }) => {
      const result = await classifyRange(api, sha(0), sha(2));
      assert.equal(result.class, 'gated');
      assert.match(result.reasons[0], /#2 .*risk:gated/);
    });
  });

  test('gated when a commit has no pull request', async () => {
    await withGitHub({ history: history(4, { 2: [] }) }, async ({ api }) => {
      const result = await classifyRange(api, sha(0), sha(3));
      assert.equal(result.class, 'gated');
      assert.match(result.reasons[0], new RegExp(`commit ${sha12(2)} did not come in through a merged pull request`));
    });
  });

  test('gated when the pull request is not the merged one into main of this repository', async () => {
    const cases = {
      'not merged': pull(2, sha(2), ['risk:routine'], { merged_at: null }),
      'merged as another commit': pull(2, sha(1), ['risk:routine']),
      'another base branch': pull(2, sha(2), ['risk:routine'], { base: { ref: 'release', repo: { full_name: REPO } } }),
      'another repository': pull(2, sha(2), ['risk:routine'], { base: { ref: 'main', repo: { full_name: 'someone/fork' } } }),
    };
    for (const [name, pr] of Object.entries(cases)) {
      await withGitHub({ history: history(3, { 2: [pr] }) }, async ({ api }) => {
        const result = await classifyRange(api, sha(1), sha(2));
        assert.equal(result.class, 'gated', name);
        assert.match(result.reasons[0], /did not come in through a merged pull request/, name);
      });
    }
  });

  test('gated when the risk label is missing or the labels cannot be read', async () => {
    await withGitHub({ history: history(4, { 2: [pull(2, sha(2), ['documentation'])], 3: [pull(3, sha(3), undefined)] }) }, async ({ api }) => {
      const result = await classifyRange(api, sha(1), sha(3));
      assert.equal(result.class, 'gated');
      assert.match(result.reasons[0], /#2 .*has no risk:routine label/);
      assert.match(result.reasons[1], /#3 .*labels could not be read/);
      assert.deepEqual(result.commits[0].pulls[0].labels, [], 'labels other than the two risk labels are never carried along');
    });
  });

  test('gated on the first deploy: no previous production source', async () => {
    await withGitHub({ history: history(3) }, async ({ api, state }) => {
      const result = await classifyRange(api, '', sha(2));
      assert.equal(result.class, 'gated');
      assert.equal(result.relation, 'first');
      assert.match(result.reasons[0], /first deploy is always gated/);
      assert.deepEqual(state.calls, [], 'nothing needs to be asked');
    });
  });

  test('gated when the previous source is not an ancestor of the new one', async () => {
    await withGitHub({ history: history(6) }, async ({ api }) => {
      const older = await classifyRange(api, sha(4), sha(2));
      assert.equal(older.class, 'gated');
      assert.equal(older.relation, 'not-ancestor');
      assert.match(older.reasons[0], /is not an ancestor/);
    });
    await withGitHub({ history: history(6), diverged: sha(3) }, async ({ api }) => {
      const diverged = await classifyRange(api, sha(3), sha(5));
      assert.equal(diverged.class, 'gated');
      assert.equal(diverged.relation, 'not-ancestor');
    });
  });

  test('gated when the source is the one production already runs', async () => {
    await withGitHub({ history: history(3) }, async ({ api }) => {
      const result = await classifyRange(api, sha(2), sha(2));
      assert.equal(result.class, 'gated');
      assert.equal(result.relation, 'identical');
    });
  });

  test('gated when the GitHub API keeps failing, and the reason names the path and status only', async () => {
    await withGitHub({ history: history(4), fail: path => (path.endsWith('/pulls') ? 500 : undefined) }, async ({ api, state }) => {
      const result = await classifyRange(api, sha(1), sha(3));
      assert.equal(result.class, 'gated');
      assert.equal(result.relation, 'ahead');
      assert.match(result.reasons[0], /could not be classified \(GitHub API \/commits\/[0-9a-f]{40}\/pulls: HTTP 500\); unclassified counts as gated/);
      assert.doesNotMatch(result.reasons.join(' '), /SERVER-MESSAGE/);
      assert.equal(state.calls.filter(call => call.includes('/pulls')).length, 3, 'three attempts, then it stops asking');
    });
    await withGitHub({ history: history(4), fail: path => (path.startsWith('/compare/') ? 403 : undefined) }, async ({ api }) => {
      const result = await classifyRange(api, sha(1), sha(3));
      assert.equal(result.class, 'gated');
      assert.equal(result.relation, 'unknown');
    });
  });

  test('a failure that passes on retry does not change the class', async () => {
    await withGitHub({ history: history(4), fail: (path, hit) => (hit === 1 ? 502 : undefined) }, async ({ api }) => {
      const result = await classifyRange(api, sha(1), sha(3));
      assert.equal(result.class, 'routine');
    });
  });

  test('gated when a SHA is unknown to GitHub', async () => {
    await withGitHub({ history: history(3) }, async ({ api }) => {
      const result = await classifyRange(api, sha(1), sha(99));
      assert.equal(result.class, 'gated');
      assert.equal(result.relation, 'unknown');
      assert.match(result.reasons[0], /HTTP 404/);
    });
  });

  test('a long range is read page by page: 230 routine commits are routine', async () => {
    await withGitHub({ history: history(232) }, async ({ api, state }) => {
      const result = await classifyRange(api, sha(1), sha(231));
      assert.equal(result.class, 'routine');
      assert.equal(result.commits.length, 230);
      assert.equal(result.commits.at(-1).sha, sha(231));
      const pages = state.calls.filter(call => call.startsWith('/compare/')).map(call => new URL(call, 'http://mock').searchParams.get('page'));
      assert.deepEqual(pages, ['1', '2', '3']);
    });
  });

  test('a gated pull request on the last page of a long range is found', async () => {
    await withGitHub({ history: history(232, { 215: [pull(215, sha(215), ['risk:gated'])] }) }, async ({ api }) => {
      const result = await classifyRange(api, sha(1), sha(231));
      assert.equal(result.class, 'gated');
      assert.match(result.reasons[0], /#215 /);
    });
  });

  test('gated when the commit list does not add up to the reported total', async () => {
    await withGitHub({ history: history(8), totalOffset: 2 }, async ({ api, state }) => {
      const result = await classifyRange(api, sha(1), sha(7));
      assert.equal(result.class, 'gated');
      assert.match(result.reasons[0], /listed 6 of 8 commits/);
      assert.ok(!state.calls.some(call => call.includes('/pulls')), 'no commit is classified from an incomplete list');
    });
  });

  test('gated without classifying one by one when the range is longer than the limit', async () => {
    await withGitHub({ history: history(MAX_RANGE_COMMITS + 3) }, async ({ api, state }) => {
      const result = await classifyRange(api, sha(0), sha(MAX_RANGE_COMMITS + 2));
      assert.equal(result.class, 'gated');
      assert.match(result.reasons[0], new RegExp(`${MAX_RANGE_COMMITS + 2} commits`));
      assert.equal(state.calls.length, 1);
    });
  });
});

describe('findPreviousProduction: the newest successful production deploy', () => {
  test('none when no run has a manifest (the workflow only ever ran as a no-op)', async () => {
    await withGitHub({ productionRuns: [productionRun(30), productionRun(20)] }, async ({ api }) => {
      assert.deepEqual(await findPreviousProduction(api), { previous: null, expired: false });
    });
  });

  test('skips no-op runs, runs of another workflow and its own run; takes the newest manifest and its last attempt', async () => {
    const world = {
      productionRuns: [productionRun(60), productionRun(50), run(40, '.github/workflows/other.yml'), productionRun(30, { run_attempt: 2 }), productionRun(20)],
      artifacts: [productionArtifact(60, 9), productionArtifact(40, 8), productionArtifact(30, 5, 1), productionArtifact(30, 6, 2), productionArtifact(20, 3), stagingArtifact(50, 7)],
    };
    await withGitHub(world, async ({ api }) => {
      const found = await findPreviousProduction(api, { excludeRunId: '60' });
      assert.deepEqual(found, { previous: { sha: sha(6), runId: '30', artifact: `poii-production-manifest-${sha(6)}-2` }, expired: false });
    });
  });

  test('ignores a run of another repository even if the listing returns it', async () => {
    const world = {
      productionRuns: [productionRun(50, { head_repository: { full_name: 'someone/fork' } }), productionRun(40)],
      artifacts: [productionArtifact(50, 9), productionArtifact(40, 4)],
    };
    await withGitHub(world, async ({ api }) => {
      assert.equal((await findPreviousProduction(api)).previous.sha, sha(4));
    });
  });

  test('reports an expired manifest instead of falling back to an older deploy', async () => {
    const world = { productionRuns: [productionRun(50), productionRun(40)], artifacts: [productionArtifact(50, 9, 1, { expired: true }), productionArtifact(40, 4)] };
    await withGitHub(world, async ({ api }) => {
      assert.deepEqual(await findPreviousProduction(api), { previous: null, expired: true });
    });
  });

  test('pages through the run list', async () => {
    const noops = Array.from({ length: 60 }, (_, i) => productionRun(1000 - i));
    await withGitHub({ productionRuns: [...noops, productionRun(7)], artifacts: [productionArtifact(7, 2)] }, async ({ api, state }) => {
      assert.equal((await findPreviousProduction(api)).previous.runId, '7');
      assert.equal(state.calls.filter(call => call.startsWith('/actions/workflows/')).length, 2);
    });
  });

  test('throws when GitHub cannot be asked: the caller must not guess', async () => {
    await withGitHub({ fail: path => (path.startsWith('/actions/workflows/') ? 503 : undefined) }, async ({ api }) => {
      await assert.rejects(findPreviousProduction(api), error => error instanceof ApiError && error.status === 503);
    });
  });
});

describe('resolveStaging: which staging release is promoted', () => {
  test('after a staging run: its manifest for the attempt that just finished', async () => {
    await withGitHub({ runs: [stagingRun(11)], artifacts: [stagingArtifact(11, 4), artifact(11, 'playwright-report')] }, async ({ api }) => {
      assert.deepEqual(await resolveStaging(api, { runId: '11' }), { found: true, sourceSha: sha(4), runId: '11', artifact: `poii-staging-manifest-${sha(4)}-1` });
    });
  });

  test('a staging run that deployed nothing is a no-op, not an error', async () => {
    await withGitHub({ runs: [stagingRun(11), stagingRun(12, { run_attempt: 2 })], artifacts: [stagingArtifact(12, 4, 1)] }, async ({ api }) => {
      assert.equal((await resolveStaging(api, { runId: '11' })).found, false);
      assert.equal((await resolveStaging(api, { runId: '12' })).found, false, 'a manifest of an earlier attempt is not this attempt\'s proof');
    });
  });

  test('refuses a run that is not a successful main run of Deploy staging in this repository', async () => {
    const bad = [
      stagingRun(1, { conclusion: 'failure' }), stagingRun(2, { head_branch: 'feature' }), stagingRun(3, { head_repository: { full_name: 'someone/fork' } }),
      run(4, '.github/workflows/ci.yml'),
    ];
    await withGitHub({ runs: bad, artifacts: bad.map(r => stagingArtifact(r.id, 4)) }, async ({ api }) => {
      for (const r of bad) await assert.rejects(resolveStaging(api, { runId: String(r.id) }), PromotionError, `run ${r.id}`);
    });
  });

  test('manual dispatch: the newest staging manifest for the SHA, whatever its attempt number', async () => {
    const world = {
      runs: [stagingRun(11), stagingRun(12, { run_attempt: 2 }), stagingRun(13, { conclusion: 'failure' })],
      artifacts: [
        stagingArtifact(11, 4, 1, { created_at: '2026-11-25T10:00:00Z' }), stagingArtifact(12, 4, 2, { created_at: '2026-11-25T11:00:00Z' }),
        stagingArtifact(13, 4, 1, { created_at: '2026-11-25T12:00:00Z' }), stagingArtifact(11, 5),
      ],
    };
    await withGitHub(world, async ({ api }) => {
      assert.deepEqual(await resolveStaging(api, { sourceSha: sha(4) }), { found: true, sourceSha: sha(4), runId: '12', artifact: `poii-staging-manifest-${sha(4)}-2` });
    });
  });

  test('manual dispatch stops when staging never deployed that SHA or the manifest expired', async () => {
    await withGitHub({ runs: [stagingRun(11)], artifacts: [stagingArtifact(11, 4, 1, { expired: true })] }, async ({ api }) => {
      await assert.rejects(resolveStaging(api, { sourceSha: sha(4) }), /No unexpired staging manifest/);
      await assert.rejects(resolveStaging(api, { sourceSha: 'main' }), PromotionError);
    });
  });
});

describe('readManifest: the staging manifest is the proof', () => {
  test('accepts a manifest whose environment, SHA, observed version and file name agree', () => {
    const { name, manifest } = readManifest(manifestDir('staging', 4), { environment: 'staging', sourceSha: sha(4) });
    assert.equal(name, `staging-20261125T133211Z-${sha12(4)}.json`);
    assert.equal(manifest.api, API_IMAGE);
  });

  test('refuses anything else', () => {
    const expect = { environment: 'staging', sourceSha: sha(4) };
    const bad = {
      'another environment': manifestDir('staging', 4, { environment: 'production' }),
      'ready version differs from the source': manifestDir('staging', 4, { observedReadyVersion: sha(3) }),
      'another source': manifestDir('staging', 5),
      'source field differs from the file name': manifestDir('staging', 4, { sourceSha: sha(5), observedReadyVersion: sha(5) }),
      'image by tag': manifestDir('staging', 4, { api: 'ghcr.io/wb-devworld/poii-api:latest' }),
      'web image from another registry path': manifestDir('staging', 4, { web: API_IMAGE }),
      'no deploy time': manifestDir('staging', 4, { deployedAt: 'yesterday' }),
      'file name time differs from deployedAt': manifestDir('staging', 4, {}, `staging-20261125T000000Z-${sha12(4)}.json`),
      'production file name': manifestDir('staging', 4, {}, `production-20261125T133211Z-${sha12(4)}.json`),
      'missing directory': join(tmpdir(), 'poii-promotion-test-does-not-exist'),
    };
    for (const [name, dir] of Object.entries(bad)) assert.throws(() => readManifest(dir, expect), PromotionError, name);
    const two = manifestDir('staging', 4);
    writeFileSync(join(two, 'extra.json'), '{}');
    assert.throws(() => readManifest(two, expect), /exactly one file/);
    const notJson = manifestDir('staging', 4);
    writeFileSync(join(notJson, `staging-20261125T133211Z-${sha12(4)}.json`), 'not json');
    assert.throws(() => readManifest(notJson, expect), /not JSON/);
  });

  test('reads a production manifest the same way', () => {
    const dir = manifestDir('production', 4, { promotedFrom: `staging-20261125T133211Z-${sha12(4)}.json`, promotionClass: 'gated' });
    assert.equal(readManifest(dir, { environment: 'production', sourceSha: sha(4) }).manifest.promotionClass, 'gated');
    assert.throws(() => readManifest(dir, { environment: 'staging', sourceSha: sha(4) }), PromotionError);
  });
});

describe('recheck: has production moved since the gate looked?', () => {
  const deployed = n => ({ productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, n)] });

  test('proceeds when nothing moved, also on a first deploy', async () => {
    await withGitHub({ history: history(8), ...deployed(2) }, async ({ api }) => {
      const result = await recheck(api, { newSha: sha(5), gatePreviousSha: sha(2), gateClass: 'routine' });
      assert.equal(result.proceed, true);
      assert.equal(result.previous.artifact, `poii-production-manifest-${sha(2)}-1`);
    });
    await withGitHub({ history: history(8) }, async ({ api }) => {
      const result = await recheck(api, { newSha: sha(5), gatePreviousSha: '', gateClass: 'gated' });
      assert.deepEqual([result.proceed, result.previous], [true, null]);
    });
  });

  test('proceeds when production moved forward and the run was approved or the shorter range is still routine', async () => {
    await withGitHub({ history: history(8, { 3: [pull(3, sha(3), ['risk:gated'])] }), ...deployed(4) }, async ({ api, state }) => {
      const approved = await recheck(api, { newSha: sha(6), gatePreviousSha: sha(2), gateClass: 'gated' });
      assert.equal(approved.proceed, true);
      assert.equal(approved.previous.sha, sha(4));
      assert.ok(!state.calls.some(call => call.includes('/pulls')), 'an approved run is not classified again');
      const routine = await recheck(api, { newSha: sha(6), gatePreviousSha: sha(3), gateClass: 'routine' });
      assert.equal(routine.proceed, true);
    });
  });

  test('is superseded when production already runs this source or a later one', async () => {
    await withGitHub({ history: history(8), ...deployed(6) }, async ({ api }) => {
      for (const n of [6, 4]) {
        const result = await recheck(api, { newSha: sha(n), gatePreviousSha: sha(2), gateClass: 'gated' });
        assert.equal(result.proceed, false, `source ${n}`);
        assert.match(result.note, /Superseded/);
      }
    });
  });

  test('stops a routine run when production moved back and the longer range is gated', async () => {
    await withGitHub({ history: history(8, { 3: [pull(3, sha(3), ['risk:gated'])] }), ...deployed(2) }, async ({ api }) => {
      await assert.rejects(recheck(api, { newSha: sha(6), gatePreviousSha: sha(4), gateClass: 'routine' }), /classified routine, and from there the promotion is gated/);
    });
  });

  test('stops when the previous deploy can no longer be found or GitHub cannot be asked', async () => {
    await withGitHub({ history: history(8) }, async ({ api }) => {
      await assert.rejects(recheck(api, { newSha: sha(6), gatePreviousSha: sha(4), gateClass: 'gated' }), PromotionError);
    });
    await withGitHub({ history: history(8), ...deployed(4), fail: path => (path.startsWith('/compare/') ? 500 : undefined) }, async ({ api }) => {
      await assert.rejects(recheck(api, { newSha: sha(6), gatePreviousSha: sha(2), gateClass: 'gated' }), ApiError);
    });
  });
});

describe('compareRange and the API client', () => {
  test('lists the commits oldest first and excludes the base', async () => {
    await withGitHub({ history: history(5) }, async ({ api }) => {
      assert.deepEqual(await compareRange(api, sha(1), sha(3)), { relation: 'ahead', commits: [sha(2), sha(3)], total: 2 });
    });
  });

  test('refuses a plain-http API that is not loopback, a missing token and a malformed repository', () => {
    assert.throws(() => createApi({ baseUrl: 'http://api.example.test', token: TOKEN, repo: REPO }), /must use https/);
    assert.throws(() => createApi({ token: '', repo: REPO }), /GITHUB_TOKEN is required/);
    assert.throws(() => createApi({ token: TOKEN, repo: 'not a repo' }), /owner\/name/);
  });

  test('sends the token only as a header and only makes GET requests', async () => {
    await withGitHub({ history: history(4), productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, 1)] }, async ({ api, state }) => {
      await findPreviousProduction(api);
      await classifyRange(api, sha(1), sha(3));
      assert.ok(state.calls.length > 3);
      assert.ok(state.calls.every(call => !call.includes(TOKEN)));
    });
  });
});

describe('promotion-class.mjs on the command line', () => {
  let cliCounter = 0;
  function cli(args, gh, extraEnv = {}) {
    const id = cliCounter++;
    const outputFile = join(workDir, `output-${id}.txt`);
    const summaryFile = join(workDir, `summary-${id}.md`);
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: gh?.url ?? 'http://127.0.0.1:9',
      GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, PROMOTION_RETRY_DELAY_MS: '1', ...extraEnv,
    };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    return new Promise(resolve => {
      execFile(process.execPath, [SCRIPT, ...args], { env }, (error, stdout, stderr) => {
        const read = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
        const outputs = Object.fromEntries(read(outputFile).split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        resolve({ code: error ? error.code : 0, stdout, stderr, outputs, summary: read(summaryFile) });
      });
    });
  }
  const everything = result => `${result.stdout}${result.stderr}${result.summary}${JSON.stringify(result.outputs)}`;

  test('classify: a routine promotion, with outputs for the deploy job and nothing private printed', async () => {
    const world = { history: history(6), productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, 2)] };
    await withGitHub(world, async gh => {
      const result = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_run', STAGING_RUN_ID: '77' });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.outputs, {
        promote: 'true', promotion_class: 'routine', relation: 'ahead', previous_sha: sha(2),
        staging_manifest: `staging-20261125T133211Z-${sha12(5)}.json`, api_image: API_IMAGE, web_image: WEB_IMAGE,
      });
      assert.match(result.summary, /Promotion class: \*\*routine\*\*/);
      assert.ok(result.summary.includes(`| \`${sha12(4)}\` | #4 | risk:routine | routine |`));
      assert.match(result.summary, /runs in the `production` environment/);
      assert.doesNotMatch(everything(result), /MUST-NOT-BE-PRINTED/);
      assert.ok(!everything(result).includes(TOKEN));
    });
  });

  test('classify: the first deploy is gated', async () => {
    await withGitHub({ history: history(6), productionRuns: [productionRun(50)] }, async gh => {
      const result = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_dispatch' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.promotion_class, 'gated');
      assert.equal(result.outputs.relation, 'first');
      assert.equal(result.outputs.previous_sha, '');
      assert.equal(result.outputs.promote, 'true');
      assert.match(result.summary, /waits for the owner's approval/);
    });
  });

  test('classify: a gated pull request in the range is named by number', async () => {
    const world = { history: history(6, { 4: [pull(4, sha(4), ['risk:gated', 'SOME-OTHER-LABEL-MUST-NOT-BE-PRINTED'])] }), productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, 2)] };
    await withGitHub(world, async gh => {
      const result = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_run' });
      assert.equal(result.outputs.promotion_class, 'gated');
      assert.ok(result.summary.includes(`pull request #4 (commit ${sha12(4)}) is labelled risk:gated`));
      assert.doesNotMatch(everything(result), /MUST-NOT-BE-PRINTED/);
    });
  });

  test('classify: an expired previous manifest is gated and says so', async () => {
    const world = { history: history(6), productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, 2, 1, { expired: true })] };
    await withGitHub(world, async gh => {
      const result = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_run' });
      assert.equal(result.outputs.promotion_class, 'gated');
      assert.match(result.summary, /has expired/);
      assert.doesNotMatch(result.summary, /first deploy/);
    });
  });

  test('classify: a staging redeploy of the source production already runs promotes nothing; a manual dispatch may (gated)', async () => {
    const world = { history: history(6), productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, 5)] };
    await withGitHub(world, async gh => {
      const chained = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_run' });
      assert.deepEqual([chained.code, chained.outputs.promote, chained.outputs.promotion_class], [0, 'false', 'gated']);
      const manual = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_dispatch' });
      assert.deepEqual([manual.code, manual.outputs.promote, manual.outputs.promotion_class], [0, 'true', 'gated']);
    });
  });

  test('classify: stops (no class, no outputs) when the staging manifest is not proof or production cannot be looked up', async () => {
    await withGitHub({ history: history(6) }, async gh => {
      const badManifest = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5, { observedReadyVersion: sha(4) }), EVENT_NAME: 'workflow_run' });
      assert.equal(badManifest.code, 1);
      assert.deepEqual(badManifest.outputs, {});
      assert.match(badManifest.stderr, /::error::.*observedReadyVersion/);
      assert.equal(gh.state.calls.length, 0, 'GitHub is not asked before the manifest is accepted');
    });
    await withGitHub({ history: history(6), fail: path => (path.startsWith('/actions/workflows/') ? 500 : undefined) }, async gh => {
      const result = await cli(['classify'], gh, { SOURCE_SHA: sha(5), STAGING_MANIFEST_DIR: manifestDir('staging', 5), EVENT_NAME: 'workflow_run' });
      assert.equal(result.code, 1);
      assert.deepEqual(result.outputs, {});
      assert.match(result.stderr, /previous production deploy could not be looked up/);
    });
  });

  test('resolve: after a staging run, and the no-op when it deployed nothing', async () => {
    await withGitHub({ runs: [stagingRun(11), stagingRun(12)], artifacts: [stagingArtifact(11, 4)] }, async gh => {
      const found = await cli(['resolve'], gh, { STAGING_RUN_ID: '11' });
      assert.equal(found.code, 0, found.stderr);
      assert.deepEqual(found.outputs, { found: 'true', source_sha: sha(4), staging_run_id: '11', staging_artifact: `poii-staging-manifest-${sha(4)}-1` });
      const noop = await cli(['resolve'], gh, { STAGING_RUN_ID: '12' });
      assert.deepEqual([noop.code, noop.outputs], [0, { found: 'false' }]);
      assert.match(noop.summary, /Nothing to promote/);
    });
  });

  test('resolve: needs exactly one of the run id and the SHA, and a token', async () => {
    await withGitHub({ runs: [stagingRun(11)], artifacts: [stagingArtifact(11, 4)] }, async gh => {
      assert.equal((await cli(['resolve'], gh, {})).code, 1);
      assert.equal((await cli(['resolve'], gh, { STAGING_RUN_ID: '11', SOURCE_SHA: sha(4) })).code, 1);
      const noToken = await cli(['resolve'], gh, { STAGING_RUN_ID: '11', GITHUB_TOKEN: undefined });
      assert.equal(noToken.code, 1);
      assert.match(noToken.stderr, /GITHUB_TOKEN is required/);
      assert.equal((await cli(['resolve'], gh, { SOURCE_SHA: sha(4) })).outputs.staging_run_id, '11');
    });
  });

  test('recheck: outputs for the deploy job; superseded is not a failure', async () => {
    const world = { history: history(8), productionRuns: [productionRun(50)], artifacts: [productionArtifact(50, 4)] };
    await withGitHub(world, async gh => {
      const same = await cli(['recheck'], gh, { SOURCE_SHA: sha(6), GATE_PREVIOUS_SHA: sha(4), GATE_CLASS: 'routine' });
      assert.equal(same.code, 0, same.stderr);
      assert.deepEqual(same.outputs, { proceed: 'true', previous_sha: sha(4), previous_run_id: '50', previous_artifact: `poii-production-manifest-${sha(4)}-1` });
      const stale = await cli(['recheck'], gh, { SOURCE_SHA: sha(3), GATE_PREVIOUS_SHA: sha(2), GATE_CLASS: 'gated' });
      assert.deepEqual([stale.code, stale.outputs.proceed], [0, 'false']);
      assert.match(stale.summary, /Superseded/);
      assert.equal((await cli(['recheck'], gh, { SOURCE_SHA: sha(6), GATE_PREVIOUS_SHA: sha(4), GATE_CLASS: 'unknown' })).code, 1);
    });
    await withGitHub({ ...world, fail: path => (path.startsWith('/actions/workflows/') ? 500 : undefined) }, async gh => {
      const result = await cli(['recheck'], gh, { SOURCE_SHA: sha(6), GATE_PREVIOUS_SHA: sha(4), GATE_CLASS: 'routine' });
      assert.equal(result.code, 1);
      assert.equal(result.outputs.proceed, undefined);
    });
  });

  test('check-manifest: reports the file name of a valid previous production manifest', async () => {
    const good = await cli(['check-manifest'], null, { MANIFEST_DIR: manifestDir('production', 4), MANIFEST_ENVIRONMENT: 'production', MANIFEST_SHA: sha(4) });
    assert.deepEqual([good.code, good.outputs], [0, { manifest_name: `production-20261125T133211Z-${sha12(4)}.json` }]);
    const wrong = await cli(['check-manifest'], null, { MANIFEST_DIR: manifestDir('staging', 4), MANIFEST_ENVIRONMENT: 'production', MANIFEST_SHA: sha(4) });
    assert.equal(wrong.code, 1);
    assert.equal((await cli(['nonsense'], null)).code, 1);
  });
});

describe('deploy-production.yml keeps the properties the policy relies on', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');

  test('starts only after Deploy staging or by hand, never from a pull request or a push', () => {
    const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
    assert.match(on, /workflow_run:\n\s+workflows: \["Deploy staging"\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
    assert.match(on, /workflow_dispatch:/);
    assert.doesNotMatch(on, /pull_request|push:|schedule:/);
  });

  test('is switched by POII_PRODUCTION_ENABLED and takes no permissions by default', () => {
    assert.match(yml, /ENABLED: \$\{\{ vars\.POII_PRODUCTION_ENABLED \}\}/);
    assert.match(yml, /\npermissions: \{\}\n/);
    assert.doesNotMatch(yml, /:\s*write\b/, 'no job may ask for a write permission');
  });

  test('anything but exactly routine goes to production-gated', () => {
    assert.match(yml, /name: \$\{\{ needs\.gate\.outputs\.promotion_class == 'routine' && 'production' \|\| 'production-gated' \}\}/);
  });

  test('the Dokploy step requires the Compose service to be the production one', () => {
    assert.match(yml, /EXPECT_WEB_BASE_URL: \$\{\{ vars\.PRODUCTION_WEB_BASE_URL \}\}/);
  });

  test('deploys one at a time and never cancels a running deploy', () => {
    assert.match(yml, /'deploy-production'/);
    assert.match(yml, /cancel-in-progress: false/);
    assert.doesNotMatch(yml, /cancel-in-progress: true/);
  });

  test('the gate job has no environment and reads no secret', () => {
    const gate = yml.slice(yml.indexOf('\n  gate:'), yml.indexOf('\n  deploy:'));
    assert.ok(gate.length > 100);
    assert.doesNotMatch(gate, /environment:/);
    assert.doesNotMatch(gate, /secrets\./);
  });

  test('no secret is passed on a command line or echoed', () => {
    for (const line of yml.split('\n').filter(line => line.includes('secrets.'))) {
      assert.match(line, /^\s+(HAS_URL|HAS_TOKEN|HAS_COMPOSE|DOKPLOY_URL|DOKPLOY_TOKEN|DOKPLOY_COMPOSE_ID): \$\{\{ secrets\.[A-Z_]+( != '')? \}\}$/, line);
    }
  });
});
