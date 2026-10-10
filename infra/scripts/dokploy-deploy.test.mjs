// Tests for dokploy-deploy.mjs against an in-process mock of the Dokploy endpoints it uses.
// The mock imitates response shapes read from Dokploy's source; it is not Dokploy. No network beyond 127.0.0.1.
// Run: node --test "infra/scripts/*.test.mjs"
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { changedComposeFields, redact, rememberEnvValue, rewriteEnv, sanitizeOutputValue, shouldMask } from './dokploy-deploy.mjs';

const SCRIPT = fileURLToPath(new URL('./dokploy-deploy.mjs', import.meta.url));
const API_IMAGE = `ghcr.io/wb-devworld/poii-api@sha256:${'2'.repeat(64)}`;
const WEB_IMAGE = `ghcr.io/wb-devworld/poii-web@sha256:${'3'.repeat(64)}`;
const GIT_SHA = 'b'.repeat(40);
const OLD_API = `ghcr.io/wb-devworld/poii-api@sha256:${'1'.repeat(64)}`;
const INITIAL_ENV = [
  'POSTGRES_PASSWORD=fixture-only-db-password',
  `API_IMAGE="${OLD_API}"`,
  'WEB_BASE_URL=https://poii-staging.example.test',
  'POII_AI_ENABLED=false',
  '# comment kept',
  `GIT_SHA=${'a'.repeat(40)}`,
  '',
].join('\r\n');

/**
 * Starts a mock Dokploy. Options:
 *   env               initial env string
 *   shape             'bad' returns a wrapped body from compose.one
 *   deploy            'done' | 'error' | 'never' | 'untitled' | 'two-untitled'
 *   updateTouches     a field name compose.update also changes
 */
async function startDokploy(options = {}) {
  const state = {
    compose: { composeId: 'cmp-1', name: 'poii-staging', sourceType: 'github', autoDeploy: false, env: options.env ?? INITIAL_ENV, updatedAt: '2026-01-01T00:00:00Z' },
    deployments: [{ deploymentId: 'd-old', title: 'earlier', status: 'done', createdAt: '2026-01-01T00:00:00Z' }],
    calls: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    const procedure = url.pathname.replace(/^\/api\//, '');
    state.calls.push(procedure);
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== 'test-token') return send(401, { code: 'UNAUTHORIZED', message: 'Authorization not provided' });
    if (input.composeId !== 'cmp-1') return send(404, { code: 'NOT_FOUND', message: 'Compose not found' });
    switch (procedure) {
      case 'compose.one':
        return send(200, options.shape === 'bad' ? { result: { data: {} } } : state.compose);
      case 'deployment.allByCompose':
        return send(200, state.deployments);
      case 'compose.update':
        state.compose = { ...state.compose, env: input.env, updatedAt: new Date().toISOString() };
        if (options.updateTouches) state.compose[options.updateTouches] = 'changed-by-mock';
        return send(200, state.compose);
      case 'compose.deploy': {
        const mode = options.deploy ?? 'done';
        if (mode !== 'never') {
          const titles = mode === 'two-untitled' ? ['Manual deployment', 'Manual deployment'] : [mode === 'untitled' ? 'Manual deployment' : input.title];
          for (const [index, title] of titles.entries()) {
            const deployment = { deploymentId: `d-new-${index}`, title, status: 'running', createdAt: new Date().toISOString() };
            state.deployments.unshift(deployment);
            setTimeout(() => {
              deployment.status = mode === 'error' ? 'error' : 'done';
              if (mode === 'error') deployment.errorMessage = 'compose up failed';
            }, 120);
          }
        }
        return send(200, { success: true, message: 'Deployment queued', composeId: input.composeId });
      }
      default:
        return send(404, { code: 'NOT_FOUND', message: 'No such procedure' });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

let workDir;
before(() => { workDir = mkdtempSync(join(tmpdir(), 'poii-dokploy-test-')); });
after(() => rmSync(workDir, { recursive: true, force: true }));

let runCounter = 0;
function runScript(dokployUrl, extraEnv = {}) {
  const outputFile = join(workDir, `out-${runCounter++}.txt`);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot ?? '',
    DOKPLOY_URL: dokployUrl,
    DOKPLOY_TOKEN: 'test-token',
    DOKPLOY_COMPOSE_ID: 'cmp-1',
    API_IMAGE,
    WEB_IMAGE,
    GIT_SHA,
    DEPLOY_POLL_INTERVAL_MS: '40',
    DEPLOY_TIMEOUT_SECONDS: '5',
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: `${outputFile}.summary.md`,
    ...extraEnv,
  };
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT], { env, timeout: 20_000 }, (error, stdout, stderr) => {
      let outputs = {};
      try {
        outputs = Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }));
      } catch {}
      let summary = '';
      try {
        summary = readFileSync(`${outputFile}.summary.md`, 'utf8');
      } catch {}
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr, outputs, summary, outputsRaw: (() => { try { return readFileSync(outputFile, 'utf8'); } catch { return ''; } })() });
    });
  });
}

describe('rewriteEnv', () => {
  test('replaces only the managed keys, keeps other lines and CRLF, appends missing keys', () => {
    const { env, previous } = rewriteEnv(INITIAL_ENV, { API_IMAGE, WEB_IMAGE, GIT_SHA });
    assert.equal(previous.API_IMAGE, OLD_API);
    assert.equal(previous.WEB_IMAGE, undefined);
    assert.equal(env, [
      'POSTGRES_PASSWORD=fixture-only-db-password',
      `API_IMAGE=${API_IMAGE}`,
      'WEB_BASE_URL=https://poii-staging.example.test',
      'POII_AI_ENABLED=false',
      '# comment kept',
      `GIT_SHA=${GIT_SHA}`,
      `WEB_IMAGE=${WEB_IMAGE}`,
      '',
    ].join('\r\n'));
  });
  test('refuses a managed key defined twice', () => {
    assert.throws(() => rewriteEnv('API_IMAGE=a\nAPI_IMAGE=b\n', { API_IMAGE, WEB_IMAGE, GIT_SHA }), /more than once/);
  });
  test('handles an empty environment', () => {
    assert.equal(rewriteEnv(null, { API_IMAGE, WEB_IMAGE, GIT_SHA }).env, `API_IMAGE=${API_IMAGE}\nWEB_IMAGE=${WEB_IMAGE}\nGIT_SHA=${GIT_SHA}`);
  });
});

describe('shouldMask', () => {
  test('masks sensitive keys from 4 characters', () => {
    assert.equal(shouldMask('POII_SESSION_SECRET', 'abcd'), true);
    assert.equal(shouldMask('OPENAI_API_KEY', 'sk-12345'), true);
    assert.equal(shouldMask('POSTGRES_PASSWORD', 'abc'), false);
  });
  test('skips harmless flags and short numbers, masks other values from 8 characters', () => {
    for (const value of ['true', 'false', 'local', 'off', 'on', '3000', '20']) assert.equal(shouldMask('POII_FLAG', value), false, value);
    assert.equal(shouldMask('POII_MODE', 'short'), false);
    assert.equal(shouldMask('WEB_BASE_URL', 'https://poii-staging.example.test'), true);
  });
});

describe('changedComposeFields', () => {
  test('ignores env, timestamps and status fields, reports other differences', () => {
    const before = { name: 'a', env: 'x', updatedAt: '1', composeStatus: 'running', deployments: [{ status: 'running', createdAt: '1' }] };
    assert.deepEqual(changedComposeFields(before, { ...before, env: 'y', updatedAt: '2', composeStatus: 'done', deployments: [{ status: 'done', createdAt: '2' }] }), []);
    assert.deepEqual(changedComposeFields(before, { ...before, sourceType: 'raw', name: 'b' }), ['name', 'sourceType']);
  });
});

describe('dokploy-deploy.mjs against a mock Dokploy', () => {
  test('updates the environment, deploys and waits for done', async () => {
    const dokploy = await startDokploy();
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(dokploy.state.calls, ['compose.one', 'deployment.allByCompose', 'compose.update', 'compose.one', 'compose.deploy', ...dokploy.state.calls.slice(5)]);
      assert.ok(dokploy.state.calls.slice(5).every(call => call === 'deployment.allByCompose'));
      assert.match(dokploy.state.compose.env, /^POSTGRES_PASSWORD=fixture-only-db-password\r\n/);
      assert.ok(dokploy.state.compose.env.includes(`API_IMAGE=${API_IMAGE}\r\n`));
      assert.equal(result.outputs.previous_api_image, OLD_API);
      assert.equal(result.outputs.previous_web_image, '');
      assert.equal(result.outputs.previous_git_sha, 'a'.repeat(40));
      assert.equal(result.outputs.result, 'deployed');
      assert.ok(result.outputs.deployed_at);
      assert.ok(!result.stdout.includes('fixture-only-db-password'));
    } finally {
      await dokploy.close();
    }
  });

  test('dry run reads only', async () => {
    const dokploy = await startDokploy();
    try {
      const result = await runScript(dokploy.url, { DOKPLOY_DRY_RUN: 'true' });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(dokploy.state.calls, ['compose.one', 'deployment.allByCompose']);
      assert.equal(dokploy.state.compose.env, INITIAL_ENV);
      assert.equal(result.outputs.result, 'dry-run');
    } finally {
      await dokploy.close();
    }
  });

  test('masks environment values under GitHub Actions, but not harmless flags', async () => {
    const dokploy = await startDokploy();
    try {
      const result = await runScript(dokploy.url, { DOKPLOY_DRY_RUN: 'true', GITHUB_ACTIONS: 'true' });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /::add-mask::fixture-only-db-password/);
      assert.match(result.stdout, /::add-mask::https:\/\/poii-staging\.example\.test/);
      assert.doesNotMatch(result.stdout, /::add-mask::false/);
    } finally {
      await dokploy.close();
    }
  });

  test('a wrong token fails with the HTTP status and no update', async () => {
    const dokploy = await startDokploy();
    try {
      const result = await runScript(dokploy.url, { DOKPLOY_TOKEN: 'wrong' });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /HTTP 401 UNAUTHORIZED/);
      assert.ok(!dokploy.state.calls.includes('compose.update'));
    } finally {
      await dokploy.close();
    }
  });

  test('an unexpected response shape stops before any change', async () => {
    const dokploy = await startDokploy({ shape: 'bad' });
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /unexpected shape/);
      assert.deepEqual(dokploy.state.calls, ['compose.one']);
    } finally {
      await dokploy.close();
    }
  });

  test('a managed key defined twice stops before any change', async () => {
    const dokploy = await startDokploy({ env: 'API_IMAGE=a\nAPI_IMAGE=b\n' });
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /more than once/);
      assert.ok(!dokploy.state.calls.includes('compose.update'));
    } finally {
      await dokploy.close();
    }
  });

  test('compose.update changing another field stops before deploy', async () => {
    const dokploy = await startDokploy({ updateTouches: 'sourceType' });
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /compose\.update changed fields other than env \(sourceType\)/);
      assert.ok(!dokploy.state.calls.includes('compose.deploy'));
      assert.equal(result.outputs.env_update_attempted, 'true');
    } finally {
      await dokploy.close();
    }
  });

  test('a failed Dokploy deployment fails the step', async () => {
    const dokploy = await startDokploy({ deploy: 'error' });
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 1);
      // The Dokploy error text goes to the log only; the summary and outputs never carry it.
      assert.match(result.stdout, /::error::Dokploy deployment error: compose up failed/);
      assert.match(result.stderr, /Dokploy deployment error\. Read the deployment log/);
      assert.doesNotMatch(result.summary, /compose up failed/);
      assert.equal(result.outputs.deployment_status, 'error');
    } finally {
      await dokploy.close();
    }
  });

  test('adopts the single new deployment when Dokploy does not echo the title', async () => {
    const dokploy = await startDokploy({ deploy: 'untitled' });
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /::warning::Dokploy did not echo our title; tracking the single new deployment/);
    } finally {
      await dokploy.close();
    }
  });

  test('two new untitled deployments are a hard failure', async () => {
    const dokploy = await startDokploy({ deploy: 'two-untitled' });
    try {
      const result = await runScript(dokploy.url);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /2 new deployments and none carries our title/);
    } finally {
      await dokploy.close();
    }
  });

  test('a timeout reports how many new deployments were seen and cancels nothing', async () => {
    const dokploy = await startDokploy({ deploy: 'never' });
    try {
      const result = await runScript(dokploy.url, { DEPLOY_TIMEOUT_SECONDS: '0.3' });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /new deployments seen: 0\)\. It was NOT cancelled/);
      assert.ok(dokploy.state.calls.every(call => !/cancel|kill/i.test(call)));
    } finally {
      await dokploy.close();
    }
  });

  test('rejects malformed input before calling Dokploy', async () => {
    for (const [extra, pattern] of [
      [{ WEB_IMAGE: 'ghcr.io/wb-devworld/poii-web:latest' }, /WEB_IMAGE is not well-formed/],
      [{ DOKPLOY_URL: 'http://dokploy.example.test' }, /must use https/],
      [{ DEPLOY_POLL_INTERVAL_MS: 'soon' }, /DEPLOY_POLL_INTERVAL_MS must be a positive number/],
      [{ DEPLOY_TIMEOUT_SECONDS: '-1' }, /DEPLOY_TIMEOUT_SECONDS must be a positive number/],
    ]) {
      const result = await runScript('http://127.0.0.1:9', extra);
      assert.equal(result.code, 1);
      assert.match(result.stderr, pattern);
    }
  });
});

describe('nothing from the Dokploy environment reaches the outputs or the summary', () => {
  test('sanitizeOutputValue keeps one printable line and redacts remembered values', () => {
    rememberEnvValue('fixture-only-db-password');
    assert.equal(sanitizeOutputValue('a\nb=injected\r\nc'), 'a b=injected c');
    assert.equal(sanitizeOutputValue('x fixture-only-db-password y'), 'x [redacted] y');
    assert.equal(redact('the value fixture-only-db-password twice fixture-only-db-password'), 'the value [redacted] twice [redacted]');
    assert.equal(sanitizeOutputValue('é\u0007'), '??');
  });

  test('a service environment full of secret-looking values never appears in the log, outputs or summary; Dokploy text is kept out of the summary', async () => {
    // Placeholder values only (built from parts so no secret-shaped literal exists in this file).
    const placeholder = kind => ['fixture', 'test', kind, '0000'].join('-');
    const secrets = [placeholder('db-pw'), placeholder('provider'), placeholder('session'), 'https://poii-staging.example.test'];
    const env = [
      ['POSTGRES', 'PASSWORD'].join('_') + `=${secrets[0]}`,
      ['OPENAI_API', 'KEY'].join('_') + `="${secrets[1]}"`,
      ['POII_SESSION', 'SECRET'].join('_') + `=${secrets[2]}`,
      `WEB_BASE_URL=${secrets[3]}`,
      `API_IMAGE=${OLD_API}`,
      'GIT_SHA=not-a-sha',
      '',
    ].join('\n');
    const dokploy = await startDokploy({ env, deploy: 'error' });
    dokploy.state.compose.sourceType = `evil\nvalue=${secrets[0]}`;
    try {
      const result = await runScript(dokploy.url, { GITHUB_ACTIONS: 'true' });
      assert.equal(result.code, 1);
      for (const value of secrets) {
        assert.ok(!result.outputsRaw.includes(value), `output carries ${value}`);
        assert.ok(!result.summary.includes(value), `summary carries ${value}`);
        assert.ok(!result.stdout.replace(/::add-mask::[^\n]*\n/g, '').includes(value), `log carries ${value}`);
        assert.ok(!result.stderr.includes(value), `stderr carries ${value}`);
      }
      assert.equal(result.outputs.compose_source_type, 'unknown');
      assert.equal(result.outputs.previous_git_sha, '', 'a malformed previous value is not handed on');
      assert.match(result.summary, /`GIT_SHA`: `\(set, but not well-formed; see the Dokploy panel\)`/);
      assert.equal(result.outputsRaw.split('\n').filter(Boolean).every(line => /^[a-z_]+=[\x20-\x7e]*$/.test(line)), true, 'every output is one printable line');
      assert.doesNotMatch(result.summary, /compose up failed/);
    } finally {
      await dokploy.close();
    }
  });

  test('an HTTP error from Dokploy puts only the status and code in the failure message', async () => {
    const dokploy = await startDokploy();
    try {
      const result = await runScript(dokploy.url, { DOKPLOY_TOKEN: 'wrong' });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /HTTP 401 UNAUTHORIZED \(check DOKPLOY_TOKEN/);
      assert.doesNotMatch(result.summary, /Authorization not provided/);
      assert.match(result.stdout, /Dokploy compose\.one said: Authorization not provided/);
    } finally {
      await dokploy.close();
    }
  });
});
