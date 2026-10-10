#!/usr/bin/env node
// Points the staging Dokploy Compose service at new image digests and redeploys it.
// Node 24, no dependencies. Used by .github/workflows/deploy-staging.yml; see docs/runbooks/staging-deploy.md.
//
// Environment (all required unless marked optional):
//   DOKPLOY_URL              Dokploy origin, e.g. https://dokploy.example.org (with or without a trailing /api)
//   DOKPLOY_TOKEN            Dokploy API key, sent as the x-api-key header; never printed
//   DOKPLOY_COMPOSE_ID       composeId of the staging Compose service
//   API_IMAGE, WEB_IMAGE     ghcr.io/wb-devworld/poii-{api,web}@sha256:<64 hex>
//   GIT_SHA                  40-hex source commit
//   DEPLOY_TITLE             optional; unique title used to find this deployment in Dokploy's list
//   DEPLOY_TIMEOUT_SECONDS   optional; default 1200
//   DOKPLOY_DRY_RUN          optional; "true" reads and validates, changes nothing
//
// Behaviour: every Dokploy response is checked against the shape this script relies on; anything
// unexpected stops the deploy with an error instead of guessing. The script never cancels a
// deployment (a running migration is never cancelled) and never rolls back.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MANAGED_KEYS = ['API_IMAGE', 'WEB_IMAGE', 'GIT_SHA'];
const IMAGE_PATTERNS = {
  API_IMAGE: /^ghcr\.io\/wb-devworld\/poii-api@sha256:[0-9a-f]{64}$/,
  WEB_IMAGE: /^ghcr\.io\/wb-devworld\/poii-web@sha256:[0-9a-f]{64}$/,
  GIT_SHA: /^[0-9a-f]{40}$/,
};
const REQUEST_TIMEOUT_MS = 30_000;
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

class DeployError extends Error {}

function fail(message) {
  throw new DeployError(message);
}

function log(message) {
  console.log(message);
}

const SENSITIVE_KEY = /SECRET|PASSWORD|KEY|TOKEN/i;
const HARMLESS_VALUE = /^(?:true|false|local|off|on|\d{1,5})$/i;

/**
 * Decides whether a Dokploy environment value is hidden from the logs. Values of keys that look
 * sensitive are masked from 4 characters; other values from 8 characters, except harmless flags
 * and short numbers, so masking does not blank out every "true" or port number in the log.
 */
export function shouldMask(key, value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (SENSITIVE_KEY.test(key)) return trimmed.length >= 4;
  return trimmed.length >= 8 && !HARMLESS_VALUE.test(trimmed);
}

function maskEnvValue(key, value) {
  if (IN_ACTIONS && shouldMask(key, value)) console.log(`::add-mask::${value.trim()}`);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function readConfig(env) {
  const missing = ['DOKPLOY_URL', 'DOKPLOY_TOKEN', 'DOKPLOY_COMPOSE_ID', ...MANAGED_KEYS].filter(name => !env[name]);
  if (missing.length) fail(`Missing required environment: ${missing.join(', ')}`);
  for (const key of MANAGED_KEYS) {
    if (!IMAGE_PATTERNS[key].test(env[key])) fail(`${key} is not well-formed (expected ${IMAGE_PATTERNS[key]})`);
  }
  let base;
  try {
    base = new URL(env.DOKPLOY_URL);
  } catch {
    fail('DOKPLOY_URL is not a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    fail('DOKPLOY_URL must use https (the API key travels in a header)');
  }
  const apiBase = `${base.origin}${base.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
  const timeoutSeconds = Number(env.DEPLOY_TIMEOUT_SECONDS ?? 1200);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail('DEPLOY_TIMEOUT_SECONDS must be a positive number');
  const pollIntervalMs = Number(env.DEPLOY_POLL_INTERVAL_MS ?? 10_000);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) fail('DEPLOY_POLL_INTERVAL_MS must be a positive number');
  return {
    apiBase,
    token: env.DOKPLOY_TOKEN,
    composeId: env.DOKPLOY_COMPOSE_ID,
    target: Object.fromEntries(MANAGED_KEYS.map(key => [key, env[key]])),
    title: env.DEPLOY_TITLE || `POII staging ${env.GIT_SHA.slice(0, 12)}`,
    timeoutMs: timeoutSeconds * 1000,
    pollIntervalMs,
    dryRun: env.DOKPLOY_DRY_RUN === 'true',
  };
}

// Dokploy exposes its tRPC procedures over HTTP at <origin>/api/<router>.<procedure>:
// queries are GET with query-string input, mutations are POST with a JSON body.
async function call(cfg, procedure, { method = 'GET', query, body } = {}) {
  const url = new URL(`${cfg.apiBase}/${procedure}`);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'x-api-key': cfg.token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`Dokploy ${procedure}: request failed (${error?.name ?? 'error'})`);
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    fail(`Dokploy ${procedure}: HTTP ${response.status}, response is not JSON (check DOKPLOY_URL points at the Dokploy panel)`);
  }
  if (!response.ok) {
    const code = typeof data?.code === 'string' ? data.code : 'unknown';
    const message = typeof data?.message === 'string' ? data.message.slice(0, 300) : '';
    const hint = response.status === 401 || response.status === 403 ? ' (check DOKPLOY_TOKEN and its access to the POII project)' : '';
    fail(`Dokploy ${procedure}: HTTP ${response.status} ${code}${message ? `: ${message}` : ''}${hint}`);
  }
  return data;
}

export function parseEnvLine(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (!match) return null;
  let value = match[2].trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

/**
 * Replaces API_IMAGE, WEB_IMAGE and GIT_SHA in a Dokploy env string and keeps every other line byte for byte.
 * A managed key that appears more than once is ambiguous and stops the deploy; a missing one is appended.
 */
export function rewriteEnv(current, target) {
  const source = current ?? '';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source === '' ? [] : source.split(/\r?\n/);
  const previous = {};
  const seen = new Map();
  const next = lines.map((line, index) => {
    const parsed = parseEnvLine(line);
    if (!parsed || !MANAGED_KEYS.includes(parsed.key)) return line;
    seen.set(parsed.key, [...(seen.get(parsed.key) ?? []), index + 1]);
    previous[parsed.key] = parsed.value;
    return `${parsed.key}=${target[parsed.key]}`;
  });
  for (const [key, positions] of seen) {
    if (positions.length > 1) fail(`The Dokploy environment defines ${key} more than once (lines ${positions.join(', ')}); fix it in Dokploy first`);
  }
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) next.pop();
  for (const key of MANAGED_KEYS) if (!seen.has(key)) next.push(`${key}=${target[key]}`);
  const unmanagedBefore = lines.filter(line => !MANAGED_KEYS.includes(parseEnvLine(line)?.key));
  const unmanagedAfter = next.filter(line => !MANAGED_KEYS.includes(parseEnvLine(line)?.key));
  if (hadTrailingNewline) unmanagedAfter.push('');
  if (unmanagedBefore.join('\n') !== unmanagedAfter.join('\n')) fail('Internal error: rewriting the environment would change unrelated variables');
  return { env: next.join(eol) + (hadTrailingNewline ? eol : ''), previous };
}

function requireCompose(data, composeId) {
  if (!data || typeof data !== 'object' || data.composeId !== composeId) {
    fail('Dokploy compose.one returned an unexpected shape (no matching composeId); the API may have changed, see the runbook');
  }
  if (!(typeof data.env === 'string' || data.env === null || data.env === undefined)) {
    fail('Dokploy compose.one returned a non-string env; the API may have changed, see the runbook');
  }
  return data;
}

// Timestamps and run states move on their own (e.g. a previous deployment finishing); everything else must not.
const TIMESTAMP_KEY = /(?:At|Date|Time|^status|Status)$/;

function withoutTimestamps(value) {
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !TIMESTAMP_KEY.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, inner]) => [key, withoutTimestamps(inner)]));
}

/** Names of the fields, other than env, timestamp-like and status fields, that differ between two compose.one results. */
export function changedComposeFields(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter(key => key !== 'env' && !TIMESTAMP_KEY.test(key))
    .filter(key => JSON.stringify(withoutTimestamps(before?.[key])) !== JSON.stringify(withoutTimestamps(after?.[key])))
    .sort();
}

function requireDeployments(data) {
  if (!Array.isArray(data) || data.some(d => !d || typeof d.deploymentId !== 'string' || typeof d.status !== 'string')) {
    fail('Dokploy deployment.allByCompose returned an unexpected shape; the API may have changed, see the runbook');
  }
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function main(env = process.env) {
  const cfg = readConfig(env);
  if (IN_ACTIONS) console.log(`::add-mask::${cfg.composeId}`);

  log(`Reading the Dokploy Compose service${cfg.dryRun ? ' (dry run: nothing will be changed)' : ''}`);
  const compose = requireCompose(await call(cfg, 'compose.one', { query: { composeId: cfg.composeId } }), cfg.composeId);
  const currentEnv = compose.env ?? '';
  // Mask every value in the service environment before anything else can echo it.
  for (const line of currentEnv.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed && !MANAGED_KEYS.includes(parsed.key)) maskEnvValue(parsed.key, parsed.value);
  }
  if (compose.isolatedDeployment === true) log('::warning::Isolated Deployment is on for this Compose service; compose.dokploy.yaml expects it off');
  if (compose.autoDeploy === true) log('::warning::Dokploy autodeploy is on; pushes to the configured branch also redeploy staging outside this workflow');
  const sourceType = typeof compose.sourceType === 'string' ? compose.sourceType : 'unknown';
  log(`Compose source type: ${sourceType}`);
  setOutput('compose_source_type', sourceType);

  const { env: nextEnv, previous } = rewriteEnv(currentEnv, cfg.target);
  for (const key of MANAGED_KEYS) {
    log(`${key}: ${previous[key] ?? '(not set)'} -> ${cfg.target[key]}`);
    setOutput(`previous_${key.toLowerCase()}`, previous[key] ?? '');
  }
  summary([
    '### Dokploy',
    '',
    `- Compose source type: \`${sourceType}\``,
    ...MANAGED_KEYS.map(key => `- \`${key}\`: \`${previous[key] ?? '(not set)'}\` → \`${cfg.target[key]}\``),
    '',
  ].join('\n'));

  const before = requireDeployments(await call(cfg, 'deployment.allByCompose', { query: { composeId: cfg.composeId } }));
  const knownIds = new Set(before.map(d => d.deploymentId));
  if (before.some(d => d.status === 'running')) log('::warning::Dokploy reports a deployment of this service still running; ours will queue behind it');

  if (cfg.dryRun) {
    log('Dry run: the token, compose id and response shapes are valid. No environment change, no deploy.');
    summary('Dry run: Dokploy was read only. Nothing was changed or deployed.\n');
    setOutput('result', 'dry-run');
    return;
  }

  log('Updating the Compose environment (other variables unchanged)');
  setOutput('env_update_attempted', 'true');
  await call(cfg, 'compose.update', { method: 'POST', body: { composeId: cfg.composeId, env: nextEnv } });
  const after = requireCompose(await call(cfg, 'compose.one', { query: { composeId: cfg.composeId } }), cfg.composeId);
  if ((after.env ?? '') !== nextEnv) fail('Dokploy did not store the environment exactly as sent; stopping before deploy');
  const changed = changedComposeFields(compose, after);
  if (changed.length) fail(`compose.update changed fields other than env (${changed.join(', ')}); stopping before deploy`);

  log(`Triggering compose.deploy with title "${cfg.title}"`);
  const triggered = await call(cfg, 'compose.deploy', { method: 'POST', body: { composeId: cfg.composeId, title: cfg.title } });
  if (!(triggered === true || triggered?.success === true)) fail('Dokploy compose.deploy did not confirm the deployment was queued');
  const triggeredAt = Date.now();

  let deployment;
  let lastStatus = '';
  let newSeen = 0;
  let adoptionWarned = false;
  while (true) {
    const list = requireDeployments(await call(cfg, 'deployment.allByCompose', { query: { composeId: cfg.composeId } }));
    const fresh = list.filter(d => !knownIds.has(d.deploymentId));
    newSeen = fresh.length;
    const ours = fresh.filter(d => d.title === cfg.title);
    if (ours.length > 1) fail(`Dokploy lists ${ours.length} new deployments titled "${cfg.title}"; stopping rather than guessing which is ours`);
    deployment = ours[0];
    if (!deployment && fresh.length > 1) {
      fail(`Dokploy lists ${fresh.length} new deployments and none carries our title; stopping rather than guessing which is ours`);
    }
    if (!deployment && fresh.length === 1) {
      deployment = fresh[0];
      if (!adoptionWarned) {
        log('::warning::Dokploy did not echo our title; tracking the single new deployment');
        adoptionWarned = true;
      }
    }
    const status = deployment?.status ?? 'not started';
    if (status !== lastStatus) {
      log(`Dokploy deployment: ${status}`);
      lastStatus = status;
    }
    if (deployment?.status === 'done') break;
    if (deployment && ['error', 'cancelled'].includes(deployment.status)) {
      const reason = typeof deployment.errorMessage === 'string' ? deployment.errorMessage.slice(0, 500) : 'no error message';
      setOutput('deployment_status', deployment.status);
      fail(`Dokploy deployment ${deployment.status}: ${reason}. Read the deployment log in Dokploy; nothing was rolled back`);
    }
    if (deployment && !['running', 'done', 'error', 'cancelled'].includes(deployment.status)) {
      fail(`Dokploy reported an unknown deployment status "${deployment.status}"; stopping rather than guessing`);
    }
    if (Date.now() - triggeredAt > cfg.timeoutMs) {
      setOutput('deployment_status', deployment?.status ?? 'not-started');
      fail(`Timed out after ${Math.round(cfg.timeoutMs / 1000)} s waiting for the Dokploy deployment (last status: ${status}; new deployments seen: ${newSeen}). It was NOT cancelled and may still finish; check Dokploy`);
    }
    await sleep(cfg.pollIntervalMs);
  }
  const deployedAt = new Date().toISOString();
  setOutput('deployment_status', 'done');
  setOutput('deployed_at', deployedAt);
  setOutput('result', 'deployed');
  log(`Dokploy deployment done at ${deployedAt}`);
  summary(`Dokploy deployment finished (\`done\`) at ${deployedAt}.\n`);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    if (error instanceof DeployError) {
      console.error(`::error::${error.message}`);
      summary(`**Dokploy step failed:** ${error.message}\n`);
    } else {
      console.error(`::error::Unexpected failure: ${error?.name ?? 'Error'}: ${error?.message ?? ''}`);
    }
    process.exitCode = 1;
  });
}
