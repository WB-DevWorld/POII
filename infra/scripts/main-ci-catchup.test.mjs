// Tests for main-ci-catchup.sh. `gh` is MOCKED: a stand-in on PATH answers from a scenario file and records
// every call, so the order of the workflows the script starts can be checked. Nothing talks to GitHub.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./main-ci-catchup.sh', import.meta.url));
const REPO = 'example/poii';
const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

// The stand-in for `gh`. It reads and rewrites the scenario file named by FAKE_GH_STATE.
const FAKE_GH = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const line = args.join(' ');
state.calls.push(line);
const done = (out, code = 0) => { writeFileSync(file, JSON.stringify(state)); if (out !== '') process.stdout.write(out + '\n'); process.exit(code); };
const field = name => { const hit = args.find(a => a.startsWith(name + '=')); return hit ? hit.slice(name.length + 1) : undefined; };
const path = args.find(a => a.startsWith('repos/')) ?? '';
if (args[0] === 'workflow' && args[1] === 'run') {
  state.started.push(args[2] + (field('source_sha') ? ' source_sha=' + field('source_sha') : ''));
  done('');
}
if (args[0] !== 'api') done('unexpected gh call: ' + line, 1);
if (/\/pulls\/\d+$/.test(path)) done(state.pr);
if (path.endsWith('/commits/main')) {
  if (line.includes('committer')) done(state.head + '\t' + state.committed);
  const next = state.laterHeads.length ? state.laterHeads.shift() : state.head;
  done(next);
}
if (path.endsWith('/actions/artifacts')) done(String(state.released));
const runs = /\/actions\/workflows\/([^/]+)\/runs$/.exec(path);
if (runs) {
  if (field('event') === 'workflow_dispatch') {
    const run = state.runs[runs[1]];
    done(run && state.started.some(s => s.startsWith(runs[1])) ? String(run.id) : '');
  }
  if (state.ciAnswer !== undefined) done(state.ciAnswer);
  const ci = state.ci;
  done([ci.count, ci.event, ci.actor, ci.status, ci.conclusion].join('\t'));
}
const one = /\/actions\/runs\/(\d+)$/.exec(path);
if (one) {
  const run = Object.values(state.runs).find(r => String(r.id) === one[1]);
  const answer = run.polls.length > 1 ? run.polls.shift() : run.polls[0];
  done(answer.replace(' ', '\t'));
}
done('unexpected gh api call: ' + line, 1);
`;

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'poii-catchup-test-'));
  writeFileSync(join(dir, 'fake-gh.mjs'), FAKE_GH);
  writeFileSync(join(dir, 'gh'), '#!/usr/bin/env bash\nexec node "$FAKE_GH_JS" "$@"\n', { mode: 0o755 });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const NO_RUN = { count: 0, event: '-', actor: '-', status: '-', conclusion: '-' };
const PUSHED = { count: 1, event: 'push', actor: 'someone', status: 'in_progress', conclusion: '-' };
const tokenCi = (status, conclusion) => ({ count: 1, event: 'workflow_dispatch', actor: 'github-actions[bot]', status, conclusion });
const passing = id => ({ id, polls: ['in_progress none', 'completed success'] });
const ALL_PASS = { 'ci.yml': passing(101), 'publish.yml': passing(102), 'deploy-staging.yml': passing(103) };

let counter = 0;
function run(scenario, env = {}) {
  const stateFile = join(dir, `state-${counter++}.json`);
  const summaryFile = join(dir, `summary-${counter}.md`);
  writeFileSync(stateFile, JSON.stringify({
    head: SHA, committed: '2026-01-01T00:00:00Z', laterHeads: [], pr: 'auto-merged', ci: NO_RUN, released: 0, runs: ALL_PASS,
    ...scenario, calls: [], started: [],
  }));
  const fullEnv = {
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    SystemRoot: process.env.SystemRoot ?? '',
    FAKE_GH_JS: join(dir, 'fake-gh.mjs'),
    FAKE_GH_STATE: stateFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    CATCHUP_NO_SLEEP: '1',
    GH_TOKEN: 'not-a-token',
    REPO,
    EVENT: 'workflow_run',
    PR_NUMBER: '7',
    STAGING_ENABLED: 'true',
    PRODUCTION_ENABLED: '',
    ...env,
  };
  return new Promise(resolve => {
    execFile('bash', [SCRIPT], { env: fullEnv, timeout: 60_000 }, (error, stdout, stderr) => {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr, started: state.started, calls: state.calls });
    });
  });
}

describe('main-ci-catchup.sh (gh MOCKED)', () => {
  test('after an auto-merge with no CI run it starts CI, the publish and the staging deploy, in that order, and stops while production is off', async () => {
    const result = await run({});
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml', `deploy-staging.yml source_sha=${SHA}`]);
    assert.match(result.stdout, /PR #7 was merged by auto-merge/);
    assert.match(result.stdout, /CI run \[101\].* succeeded/);
    assert.match(result.stdout, /Publish immutable images run \[102\].* succeeded/);
    assert.match(result.stdout, /Deploy staging run \[103\].* succeeded/);
    assert.match(result.stdout, /Production deploys are switched off/);
  });

  test('with production switched on it also starts Deploy production for the same commit and does not wait for it', async () => {
    const result = await run({}, { PRODUCTION_ENABLED: 'true' });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml', `deploy-staging.yml source_sha=${SHA}`, `deploy-production.yml source_sha=${SHA}`]);
  });

  test('a pull request merged by a person, one that is not auto-merging, and one still waiting start nothing', async () => {
    for (const [pr, words] of [['merged-by-someone', /that push starts CI itself/], ['no-auto-merge', /is not auto-merging/], ['closed', /is not auto-merging/], ['waiting', /has not merged yet/]]) {
      const result = await run({ pr });
      assert.equal(result.code, 0, pr + result.stdout + result.stderr);
      assert.deepEqual(result.started, [], pr);
      assert.match(result.stdout, words);
    }
  });

  test('a head commit that already has a CI run from a push is left alone, on every event', async () => {
    for (const env of [{}, { EVENT: 'schedule', PR_NUMBER: '' }, { EVENT: 'workflow_dispatch', PR_NUMBER: '' }]) {
      const result = await run({ ci: PUSHED }, env);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(result.started, []);
      assert.match(result.stdout, /already has a CI run\. Nothing to do/);
    }
  });

  test('a finished run that names no pull request falls back to the head of main and starts the chain when it has no CI run', async () => {
    const result = await run({}, { PR_NUMBER: '' });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /names no pull request/);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml', `deploy-staging.yml source_sha=${SHA}`]);
  });

  test('a later run repairs a broken chain: a passed CI run started with the workflow token and no images continues at the publish step', async () => {
    const result = await run({ ci: tokenCi('completed', 'success'), released: 0 }, { EVENT: 'schedule', PR_NUMBER: '' });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.started, ['publish.yml', `deploy-staging.yml source_sha=${SHA}`]);
    assert.match(result.stdout, /Continuing at the publish step/);
  });

  test('a token-started CI run that already has images, is still running, or failed starts nothing', async () => {
    const cases = [
      [{ ci: tokenCi('completed', 'success'), released: 1 }, /already has CI and published images/],
      [{ ci: tokenCi('in_progress', '-') }, /is still running/],
      [{ ci: tokenCi('completed', 'failure') }, /ended as `failure`\. Nothing is published/],
    ];
    for (const [scenario, words] of cases) {
      const result = await run(scenario, { EVENT: 'schedule', PR_NUMBER: '' });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(result.started, []);
      assert.match(result.stdout, words);
    }
  });

  test('when CI fails the chain stops with an error and nothing is published', async () => {
    const result = await run({ runs: { ...ALL_PASS, 'ci.yml': { id: 101, polls: ['in_progress none', 'completed failure'] } } });
    assert.equal(result.code, 1);
    assert.deepEqual(result.started, ['ci.yml']);
    assert.match(result.stdout, /CI run \[101\].* ended as `failure`\. The chain stops here/);
  });

  test('when the publish fails nothing is deployed', async () => {
    const result = await run({ runs: { ...ALL_PASS, 'publish.yml': { id: 102, polls: ['completed failure'] } } });
    assert.equal(result.code, 1);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml']);
  });

  test('when main moves on after CI nothing more is started for the old commit', async () => {
    const result = await run({ laterHeads: [NEWER] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.started, ['ci.yml']);
    assert.match(result.stdout, /main has moved on/);
  });

  test('when main moves on after the publish nothing is deployed for the old commit', async () => {
    const result = await run({ laterHeads: [SHA, NEWER] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml']);
    assert.match(result.stdout, /nothing is deployed for this one/);
  });

  test('with staging switched off the chain ends after the publish', async () => {
    const result = await run({}, { STAGING_ENABLED: '' });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml']);
    assert.match(result.stdout, /Staging deploys are switched off/);
  });

  test('a started run that never appears stops the chain with an error', async () => {
    const result = await run({ runs: { 'ci.yml': passing(101) } });
    assert.equal(result.code, 1);
    assert.deepEqual(result.started, ['ci.yml', 'publish.yml']);
    assert.match(result.stdout, /did not appear within three minutes/);
  });

  test('an odd answer about the CI runs is never read as "no run": the job fails and starts nothing', async () => {
    const result = await run({ ciAnswer: 'Not Found' }, { EVENT: 'schedule', PR_NUMBER: '' });
    assert.equal(result.code, 1);
    assert.deepEqual(result.started, []);
    assert.match(result.stdout, /Could not count the CI runs/);
  });
});
