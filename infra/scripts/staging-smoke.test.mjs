// Tests for staging-smoke.sh against an in-process mock of the staging host (web root plus /health routed
// to the API). The mock is not POII. Needs bash, curl and node; no network beyond 127.0.0.1.
// Run: node --test "infra/scripts/*.test.mjs"
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./staging-smoke.sh', import.meta.url));
const SHA = 'b'.repeat(40);
const OLD_SHA = 'c'.repeat(40);

/** Mock staging host. `version` is the SHA the API reports; `rootStatus` the web root's status code. */
async function startStaging({ version = SHA, rootStatus = 200 } = {}) {
  const state = { version, rootStatus };
  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health/live') return json(200, { status: 'ok', version: state.version });
    if (req.url === '/health/ready') return json(200, { status: 'ready', version: state.version, aiEnabled: false });
    if (req.url === '/') {
      res.writeHead(state.rootStatus, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>POII</title>');
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

let workDir;
before(() => { workDir = mkdtempSync(join(tmpdir(), 'poii-smoke-test-')); });
after(() => rmSync(workDir, { recursive: true, force: true }));

let runCounter = 0;
function runSmoke(mode, extraEnv = {}) {
  const outputFile = join(workDir, `out-${runCounter++}.txt`);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot ?? '',
    POII_EXPECTED_SHA: SHA,
    POII_READY_INTERVAL_SECONDS: '1',
    GITHUB_OUTPUT: outputFile,
    ...extraEnv,
  };
  return new Promise(resolve => {
    execFile('bash', [SCRIPT, mode], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      let output = '';
      try { output = readFileSync(outputFile, 'utf8'); } catch {}
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr, output });
    });
  });
}

describe('staging-smoke.sh check', () => {
  test('passes when health reports the SHA, the root answers 200 and unknown routes 404, and skips Playwright with a reason', async () => {
    const staging = await startStaging();
    try {
      const result = await runSmoke('check', { POII_WEB_BASE_URL: `${staging.url}/` });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /PASS {2}GET \/health\/live -> 200, status ok/);
      assert.match(result.stdout, /PASS {2}GET \/health\/ready -> 200, status ready/);
      assert.match(result.stdout, /PASS {2}GET web root -> 200/);
      assert.match(result.stdout, /PASS {2}GET unknown route -> 404/);
      assert.match(result.stdout, /SKIP {2}core-journey Playwright smoke: no authentication method is approved for staging yet/);
    } finally {
      await staging.close();
    }
  });

  test('fails on the wrong SHA and on a failing web root', async () => {
    const staging = await startStaging({ version: OLD_SHA, rootStatus: 500 });
    try {
      const result = await runSmoke('check', { POII_WEB_BASE_URL: staging.url });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /FAIL {2}GET \/health\/ready -> HTTP 200, status 'ready', version 'c{40}'/);
      assert.match(result.stdout, /FAIL {2}GET web root -> HTTP 500/);
      assert.match(result.stderr, /3 staging smoke check\(s\) failed/);
    } finally {
      await staging.close();
    }
  });

  test('uses a separate API base when given', async () => {
    const web = await startStaging({ version: OLD_SHA });
    const api = await startStaging();
    try {
      const result = await runSmoke('check', { POII_WEB_BASE_URL: web.url, POII_API_BASE_URL: api.url });
      assert.equal(result.code, 0, result.stdout + result.stderr);
    } finally {
      await web.close();
      await api.close();
    }
  });

  test('the core-journey hook fails loudly when requested before a staging runner exists', async () => {
    const staging = await startStaging();
    try {
      const result = await runSmoke('check', { POII_WEB_BASE_URL: staging.url, POII_STAGING_E2E_AUTH: 'local-sign-in' });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /no staging runner is implemented yet/);
    } finally {
      await staging.close();
    }
  });

  test('requires the base URL and the expected SHA', async () => {
    assert.match((await runSmoke('check', { POII_WEB_BASE_URL: '' })).stderr, /POII_WEB_BASE_URL is required/);
    assert.match((await runSmoke('check', { POII_WEB_BASE_URL: 'http://127.0.0.1:9', POII_EXPECTED_SHA: '' })).stderr, /POII_EXPECTED_SHA is required/);
    assert.match((await runSmoke('nonsense', { POII_WEB_BASE_URL: 'http://127.0.0.1:9' })).stderr, /usage/);
  });
});

describe('staging-smoke.sh wait', () => {
  test('waits until /health/ready reports the new SHA and records it as a step output', async () => {
    const staging = await startStaging({ version: OLD_SHA });
    const flip = setTimeout(() => { staging.state.version = SHA; }, 1500);
    try {
      const result = await runSmoke('wait', { POII_WEB_BASE_URL: staging.url, POII_READY_TIMEOUT_SECONDS: '15' });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`version '${OLD_SHA}'`));
      assert.match(result.stdout, new RegExp(`Ready: the API reports ${SHA}`));
      assert.equal(result.output, `observed_ready_version=${SHA}\n`);
    } finally {
      clearTimeout(flip);
      await staging.close();
    }
  });

  test('times out with the last observation when the SHA never appears', async () => {
    const staging = await startStaging({ version: OLD_SHA });
    try {
      const result = await runSmoke('wait', { POII_WEB_BASE_URL: staging.url, POII_READY_TIMEOUT_SECONDS: '2' });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Timed out after 2s: \/health\/ready never reported b{40} \(last: HTTP 200, status 'ready', version 'c{40}'\)/);
      assert.equal(result.output, '');
    } finally {
      await staging.close();
    }
  });

  test('treats an unreachable host as not ready', async () => {
    const staging = await startStaging();
    const { url } = staging;
    await staging.close();
    const result = await runSmoke('wait', { POII_WEB_BASE_URL: url, POII_READY_TIMEOUT_SECONDS: '1' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /last: HTTP 000/);
  });
});
