#!/usr/bin/env node
// Decides how a release that staging deployed and checked is promoted to production: `routine`
// (automatic, environment `production`) or `gated` (waits for the owner, environment `production-gated`).
// Node 24, no dependencies. Used by .github/workflows/deploy-production.yml; see
// docs/runbooks/production-deploy.md and docs/adr/0013-production-promotion-mechanics.md.
//
// Subcommands (first argument):
//   resolve         find the "Deploy staging" run and the manifest artifact to promote
//   classify        check the downloaded staging manifest, find the previous production deploy, decide the class
//   recheck         in the deploy job, after any approval: has production moved since the gate looked?
//   check-manifest  validate one downloaded manifest and report its file name
//
// Environment:
//   GITHUB_TOKEN            required; read-only use (GET requests only); never printed
//   GITHUB_REPOSITORY       required; owner/name
//   GITHUB_API_URL          optional; default https://api.github.com (https only, except loopback for tests)
//   GITHUB_RUN_ID           optional; the current run, never taken as the previous production deploy
//   resolve:        STAGING_RUN_ID (the run that triggered us) or SOURCE_SHA (manual dispatch), exactly one
//   classify:       SOURCE_SHA, STAGING_MANIFEST_DIR, EVENT_NAME (optional), STAGING_RUN_ID (optional, for the summary)
//   recheck:        SOURCE_SHA, GATE_PREVIOUS_SHA (empty when the gate saw none), GATE_CLASS
//   check-manifest: MANIFEST_DIR, MANIFEST_ENVIRONMENT, MANIFEST_SHA
//
// Rule: a promotion is `routine` only if every commit between the previous production source and the
// new source came in through a merged pull request into main that is labelled `risk:routine` and not
// `risk:gated`. Everything else is `gated`: no previous production deploy, the same source again, a
// previous source that is not an ancestor, a commit without such a pull request, a missing label, or
// anything GitHub could not tell us. Unclassified counts as gated (docs/release-policy.md).
//
// Output hygiene: prints SHAs, run ids, pull request numbers and the two risk label names only. Pull
// request titles, authors, other labels and response bodies are never printed.

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STAGING_WORKFLOW_PATH = '.github/workflows/deploy-staging.yml';
export const PRODUCTION_WORKFLOW_PATH = '.github/workflows/deploy-production.yml';
const PRODUCTION_WORKFLOW_FILE = 'deploy-production.yml';
const BASE_BRANCH = 'main';
const ROUTINE_LABEL = 'risk:routine';
const GATED_LABEL = 'risk:gated';
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,18}$/;
const STAGING_ARTIFACT = /^poii-staging-manifest-([0-9a-f]{40})-([1-9][0-9]{0,3})$/;
const PRODUCTION_ARTIFACT = /^poii-production-manifest-([0-9a-f]{40})-([1-9][0-9]{0,3})$/;
const MANIFEST_FILE = /^(staging|production)-(\d{8}T\d{6}Z)-([0-9a-f]{12})\.json$/;
const IMAGE_PATTERNS = {
  api: /^ghcr\.io\/wb-devworld\/poii-api@sha256:[0-9a-f]{64}$/,
  web: /^ghcr\.io\/wb-devworld\/poii-web@sha256:[0-9a-f]{64}$/,
};
/** A range longer than this is not classified commit by commit; it is gated. */
export const MAX_RANGE_COMMITS = 500;
/** How many successful "Deploy production" runs are searched for the previous manifest. */
export const MAX_PRODUCTION_RUNS = 100;
/** Attempt numbers tried when a manual dispatch looks for a staging manifest by source SHA. */
export const MAX_STAGING_ATTEMPTS = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 64 * 1024;

/** A condition that stops the run (exit 1): nothing may be promoted on a guess. */
export class PromotionError extends Error {}
/** GitHub answered with an error, an unexpected shape, or not at all. */
export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function fail(message) {
  throw new PromotionError(message);
}

const short = sha => (typeof sha === 'string' ? sha.slice(0, 12) : '?');
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Minimal read-only GitHub REST client for one repository. Network errors, HTTP 429 and 5xx are
 * retried; every other failure, and a body that is not JSON, becomes an ApiError that names the
 * path and the status and nothing else.
 */
export function createApi({ baseUrl = 'https://api.github.com', token, repo, attempts = 3, retryDelayMs = 2000, fetchImpl = fetch }) {
  if (!token) fail('GITHUB_TOKEN is required');
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('GITHUB_REPOSITORY must be owner/name');
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    fail('GITHUB_API_URL is not a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) fail('GITHUB_API_URL must use https (the token travels in a header)');
  const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}/repos/${repo}`;

  async function get(path, query = {}) {
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            'user-agent': 'poii-promotion-class',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        last = new ApiError(`GitHub API ${path}: request failed (${error?.name ?? 'error'})`);
        continue;
      }
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) {
        last = new ApiError(`GitHub API ${path}: HTTP ${response.status}`, response.status);
        continue;
      }
      if (!response.ok) throw new ApiError(`GitHub API ${path}: HTTP ${response.status}`, response.status);
      try {
        return JSON.parse(text);
      } catch {
        throw new ApiError(`GitHub API ${path}: the response is not JSON`, response.status);
      }
    }
    throw last;
  }
  return { get, repo };
}

function acceptedRun(run, repo, workflowPath) {
  return Boolean(run) && run.path === workflowPath && run.conclusion === 'success' && run.head_branch === BASE_BRANCH &&
    sameRepo(run.head_repository?.full_name, repo) && (run.repository === undefined || sameRepo(run.repository?.full_name, repo));
}

async function listRunArtifacts(api, runId) {
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await api.get(`/actions/runs/${runId}/artifacts`, { per_page: 100, page });
    if (!Array.isArray(data?.artifacts)) throw new ApiError(`GitHub API /actions/runs/${runId}/artifacts: unexpected shape`);
    out.push(...data.artifacts);
    if (data.artifacts.length < 100) break;
  }
  return out;
}

function manifestArtifacts(artifacts, pattern) {
  return artifacts
    .map(artifact => {
      const match = typeof artifact?.name === 'string' ? pattern.exec(artifact.name) : null;
      return match ? { name: artifact.name, sha: match[1], attempt: Number(match[2]), expired: artifact.expired === true, createdAt: String(artifact.created_at ?? ''), runId: artifact.workflow_run?.id } : null;
    })
    .filter(Boolean);
}

/**
 * Finds the staging manifest artifact to promote.
 *   runId      the "Deploy staging" run whose completion started this workflow: its manifest for the
 *              attempt that just finished, or { found: false } when that attempt deployed nothing
 *              (staging switched off, a dry run, or no published release).
 *   sourceSha  manual dispatch: the newest unexpired staging manifest for that source.
 * Either way the run must be a successful main run of deploy-staging.yml in this repository.
 */
export async function resolveStaging(api, { runId, sourceSha }) {
  if (runId) {
    if (!RUN_ID.test(String(runId))) fail('STAGING_RUN_ID must be a run id');
    const run = await api.get(`/actions/runs/${runId}`);
    if (!acceptedRun(run, api.repo, STAGING_WORKFLOW_PATH)) {
      fail(`Run ${runId} is not a successful main run of "Deploy staging" in this repository; nothing is promoted from it`);
    }
    const mine = manifestArtifacts(await listRunArtifacts(api, runId), STAGING_ARTIFACT)
      .filter(artifact => !artifact.expired && artifact.attempt === run.run_attempt);
    if (mine.length === 0) return { found: false, reason: `Deploy staging run ${runId} wrote no release manifest in its last attempt (staging deployed nothing). Nothing to promote.` };
    if (mine.length > 1) fail(`Deploy staging run ${runId} has ${mine.length} manifests for one attempt; expected one`);
    return { found: true, sourceSha: mine[0].sha, runId: String(runId), artifact: mine[0].name };
  }
  if (!SHA.test(String(sourceSha ?? ''))) fail('SOURCE_SHA must be a full 40-character lowercase hex SHA');
  const candidates = [];
  for (let attempt = 1; attempt <= MAX_STAGING_ATTEMPTS; attempt += 1) {
    const name = `poii-staging-manifest-${sourceSha}-${attempt}`;
    const data = await api.get('/actions/artifacts', { name, per_page: 100 });
    if (!Array.isArray(data?.artifacts)) throw new ApiError('GitHub API /actions/artifacts: unexpected shape');
    candidates.push(...manifestArtifacts(data.artifacts, STAGING_ARTIFACT).filter(a => a.name === name && !a.expired && RUN_ID.test(String(a.runId ?? ''))));
  }
  candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  for (const candidate of candidates) {
    const run = await api.get(`/actions/runs/${candidate.runId}`);
    if (acceptedRun(run, api.repo, STAGING_WORKFLOW_PATH)) {
      return { found: true, sourceSha: candidate.sha, runId: String(candidate.runId), artifact: candidate.name };
    }
  }
  fail(`No unexpired staging manifest for ${sourceSha} from a successful main run of "Deploy staging" exists (kept 90 days; attempts 1 to ${MAX_STAGING_ATTEMPTS} were tried). Staging must deploy and check a source before it can be promoted`);
}

/**
 * The newest successful main run of deploy-production.yml that uploaded a production manifest.
 * Returns { previous: { sha, runId, artifact } | null, expired }. `expired` is true when the newest
 * such manifest has passed its retention: a previous deploy existed but can no longer be read.
 * Throws ApiError when GitHub cannot be asked; the caller must not guess then.
 */
export async function findPreviousProduction(api, { excludeRunId, maxRuns = MAX_PRODUCTION_RUNS } = {}) {
  const perPage = 50;
  let scanned = 0;
  for (let page = 1; scanned < maxRuns; page += 1) {
    const data = await api.get(`/actions/workflows/${PRODUCTION_WORKFLOW_FILE}/runs`, { status: 'success', branch: BASE_BRANCH, per_page: perPage, page });
    if (!Array.isArray(data?.workflow_runs)) throw new ApiError(`GitHub API /actions/workflows/${PRODUCTION_WORKFLOW_FILE}/runs: unexpected shape`);
    for (const run of data.workflow_runs) {
      if (scanned >= maxRuns) break;
      scanned += 1;
      if (!RUN_ID.test(String(run?.id ?? '')) || String(run.id) === String(excludeRunId ?? '')) continue;
      if (!acceptedRun(run, api.repo, PRODUCTION_WORKFLOW_PATH)) continue;
      const manifests = manifestArtifacts(await listRunArtifacts(api, run.id), PRODUCTION_ARTIFACT);
      if (manifests.length === 0) continue;
      const newest = manifests.sort((a, b) => b.attempt - a.attempt)[0];
      if (newest.expired) return { previous: null, expired: true };
      return { previous: { sha: newest.sha, runId: String(run.id), artifact: newest.name }, expired: false };
    }
    if (data.workflow_runs.length < perPage) break;
  }
  return { previous: null, expired: false };
}

/**
 * Compares previous...next and lists the commits in between.
 * Returns { relation: 'identical' | 'not-ancestor' | 'ahead', commits }. Throws ApiError on any
 * answer that does not add up (missing commits, a wrong total, an unknown SHA).
 */
export async function compareRange(api, previousSha, newSha) {
  if (previousSha === newSha) return { relation: 'identical', commits: [] };
  const path = `/compare/${previousSha}...${newSha}`;
  const first = await api.get(path, { per_page: 100, page: 1 });
  if (first?.status !== 'ahead' || first.behind_by !== 0 || first.merge_base_commit?.sha !== previousSha) {
    if (['behind', 'diverged', 'ahead', 'identical'].includes(first?.status)) return { relation: 'not-ancestor', commits: [] };
    throw new ApiError(`GitHub API ${path}: unexpected shape`);
  }
  const total = first.total_commits;
  if (!Number.isInteger(total) || total < 1 || first.ahead_by !== total) throw new ApiError(`GitHub API ${path}: the commit counts do not add up`);
  if (total > MAX_RANGE_COMMITS) return { relation: 'ahead', commits: null, total };
  const commits = [];
  for (let page = 1, data = first; ; page += 1) {
    if (page > 1) data = await api.get(path, { per_page: 100, page });
    if (!Array.isArray(data?.commits) || data.commits.some(commit => !SHA.test(String(commit?.sha ?? '')))) throw new ApiError(`GitHub API ${path}: unexpected shape`);
    commits.push(...data.commits.map(commit => commit.sha));
    if (commits.length >= total || data.commits.length === 0) break;
  }
  if (commits.length !== total || new Set(commits).size !== total || !commits.includes(newSha) || commits.includes(previousSha)) {
    throw new ApiError(`GitHub API ${path}: listed ${commits.length} of ${total} commits, or not the expected ones`);
  }
  return { relation: 'ahead', commits, total };
}

/** One commit: the merged pull request(s) into main it came in through, and whether they are routine. */
async function classifyCommit(api, sha) {
  const pulls = await api.get(`/commits/${sha}/pulls`, { per_page: 100 });
  if (!Array.isArray(pulls)) throw new ApiError(`GitHub API /commits/${sha}/pulls: unexpected shape`);
  const merged = pulls.filter(pr => pr && Number.isInteger(pr.number) && pr.number > 0 && typeof pr.merged_at === 'string' && pr.merged_at &&
    pr.merge_commit_sha === sha && pr.base?.ref === BASE_BRANCH && sameRepo(pr.base?.repo?.full_name, api.repo));
  if (merged.length === 0) return { sha, pulls: [], reasons: [`commit ${short(sha)} did not come in through a merged pull request into ${BASE_BRANCH}`] };
  const reasons = [];
  const rows = merged.map(pr => {
    const names = Array.isArray(pr.labels) ? pr.labels.map(label => label?.name) : null;
    const gated = names?.includes(GATED_LABEL) ?? false;
    const routine = names?.includes(ROUTINE_LABEL) ?? false;
    if (names === null) reasons.push(`pull request #${pr.number} (commit ${short(sha)}): labels could not be read`);
    else if (gated) reasons.push(`pull request #${pr.number} (commit ${short(sha)}) is labelled ${GATED_LABEL}`);
    else if (!routine) reasons.push(`pull request #${pr.number} (commit ${short(sha)}) has no ${ROUTINE_LABEL} label`);
    return { number: pr.number, labels: [gated ? GATED_LABEL : null, routine ? ROUTINE_LABEL : null].filter(Boolean) };
  });
  return { sha, pulls: rows, reasons };
}

/**
 * Decides the promotion class for previousSha..newSha. Never throws for GitHub trouble: what cannot
 * be determined is gated, with the reason.
 * Returns { class, relation: 'first' | 'identical' | 'not-ancestor' | 'ahead' | 'unknown', reasons, commits }.
 */
export async function classifyRange(api, previousSha, newSha) {
  if (!previousSha) return { class: 'gated', relation: 'first', reasons: ['no previous production deploy was found: the first deploy is always gated'], commits: [] };
  let relation = 'unknown';
  const commits = [];
  try {
    const range = await compareRange(api, previousSha, newSha);
    relation = range.relation;
    if (relation === 'identical') return { class: 'gated', relation, reasons: [`${short(newSha)} is the source production already runs: a redeploy is not a routine promotion`], commits };
    if (relation === 'not-ancestor') return { class: 'gated', relation, reasons: [`the previous production source ${short(previousSha)} is not an ancestor of ${short(newSha)}`], commits };
    if (range.commits === null) return { class: 'gated', relation, reasons: [`${range.total} commits since the previous production deploy, more than the ${MAX_RANGE_COMMITS} that are classified one by one`], commits };
    const reasons = [];
    for (const sha of range.commits) {
      const row = await classifyCommit(api, sha);
      commits.push(row);
      reasons.push(...row.reasons);
    }
    return { class: reasons.length === 0 ? 'routine' : 'gated', relation, reasons, commits };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { class: 'gated', relation, reasons: [`the range could not be classified (${error.message}); unclassified counts as gated`], commits };
  }
}

/**
 * Deploy-time check, run inside the deploy job (after any approval, inside the concurrency group).
 * Returns { proceed, previous, note }. proceed is false when this run is superseded: production
 * already runs this source or one that this source is not a successor of. Throws when it cannot be
 * shown that deploying is still covered by the class the gate decided.
 */
export async function recheck(api, { newSha, gatePreviousSha, gateClass, excludeRunId }) {
  const { previous } = await findPreviousProduction(api, { excludeRunId });
  const nowSha = previous?.sha ?? '';
  if (nowSha === (gatePreviousSha ?? '')) return { proceed: true, previous, note: 'Production has not moved since this run was classified.' };
  if (!previous) fail(`The gate saw the previous production source ${short(gatePreviousSha)}, but its manifest can no longer be found; start a new run so it is classified afresh`);
  const range = await compareRange(api, nowSha, newSha);
  if (range.relation !== 'ahead') {
    return { proceed: false, previous, note: `Superseded: production moved to ${short(nowSha)} since this run was classified, and ${short(newSha)} is not a later source. Nothing was deployed.` };
  }
  if (gateClass !== 'gated') {
    const fresh = await classifyRange(api, nowSha, newSha);
    if (fresh.class !== 'routine') {
      fail(`Production moved to ${short(nowSha)} since this run was classified routine, and from there the promotion is gated (${fresh.reasons[0] ?? 'no reason given'}). Start a new run so it is classified afresh`);
    }
  }
  return { proceed: true, previous, note: `Production moved forward to ${short(nowSha)} since this run was classified; ${short(newSha)} is a later source${gateClass === 'gated' ? ' and this run was approved' : ' and the shorter range is still routine'}.` };
}

/**
 * Validates the one manifest file in a directory (a downloaded artifact) and returns { name, manifest }.
 * The manifest is the proof of what was deployed and observed: the environment must be the expected
 * one and the version /health/ready reported must be the source SHA.
 */
export function readManifest(dir, { environment, sourceSha }) {
  if (!['staging', 'production'].includes(environment)) fail('MANIFEST_ENVIRONMENT must be staging or production');
  if (!SHA.test(String(sourceSha ?? ''))) fail('The expected source SHA is not a full 40-character lowercase hex SHA');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail(`The ${environment} manifest was not downloaded (directory missing)`);
  }
  if (entries.length !== 1) fail(`Expected exactly one file in the ${environment} manifest artifact, found ${entries.length}`);
  const name = entries[0];
  const match = MANIFEST_FILE.exec(name);
  if (!match || match[1] !== environment || match[3] !== sourceSha.slice(0, 12)) fail(`The ${environment} manifest file name does not match ${environment}-<UTC time>-${sourceSha.slice(0, 12)}.json`);
  const file = join(dir, name);
  if (!statSync(file).isFile() || statSync(file).size > MAX_MANIFEST_BYTES) fail(`The ${environment} manifest is not a small regular file`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`The ${environment} manifest is not JSON`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`The ${environment} manifest is not a JSON object`);
  if (manifest.environment !== environment) fail(`The manifest's environment is not "${environment}"`);
  if (manifest.sourceSha !== sourceSha) fail(`The ${environment} manifest names another source than ${sourceSha}`);
  if (manifest.observedReadyVersion !== manifest.sourceSha) fail(`The ${environment} manifest does not show /health/ready reporting the source SHA (observedReadyVersion differs from sourceSha)`);
  for (const key of ['api', 'web']) {
    if (typeof manifest[key] !== 'string' || !IMAGE_PATTERNS[key].test(manifest[key])) fail(`The ${environment} manifest's ${key} image reference is missing or malformed`);
  }
  const deployedAt = typeof manifest.deployedAt === 'string' ? Date.parse(manifest.deployedAt) : NaN;
  if (Number.isNaN(deployedAt)) fail(`The ${environment} manifest has no valid deployedAt`);
  const stamp = new Date(deployedAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  if (stamp !== match[2]) fail(`The ${environment} manifest's file name and its deployedAt disagree`);
  return { name, manifest };
}

// ---- command line -------------------------------------------------------------------------------

/** Job-output values are one line of printable text: newlines would inject further outputs. */
function setOutput(name, value) {
  if (!/^[a-z_]{1,64}$/.test(name)) throw new Error(`Internal error: output name ${name}`);
  const line = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 1000);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${line}\n`);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function say(message) {
  console.log(message);
  summary(message);
}

function apiFromEnv(env) {
  return createApi({
    baseUrl: env.GITHUB_API_URL || 'https://api.github.com',
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    retryDelayMs: env.PROMOTION_RETRY_DELAY_MS ? Number(env.PROMOTION_RETRY_DELAY_MS) : 2000,
  });
}

function requireSha(env, name) {
  if (!SHA.test(String(env[name] ?? ''))) fail(`${name} must be a full 40-character lowercase hex SHA`);
  return env[name];
}

async function commandResolve(env) {
  if (Boolean(env.STAGING_RUN_ID) === Boolean(env.SOURCE_SHA)) fail('Give exactly one of STAGING_RUN_ID (after a staging run) or SOURCE_SHA (manual dispatch)');
  const api = apiFromEnv(env);
  const result = await resolveStaging(api, { runId: env.STAGING_RUN_ID, sourceSha: env.SOURCE_SHA });
  if (!result.found) {
    say(result.reason);
    setOutput('found', 'false');
    return;
  }
  say(`Promoting source \`${result.sourceSha}\` from Deploy staging run ${result.runId} (artifact \`${result.artifact}\`).`);
  setOutput('found', 'true');
  setOutput('source_sha', result.sourceSha);
  setOutput('staging_run_id', result.runId);
  setOutput('staging_artifact', result.artifact);
}

function commitTable(commits) {
  const shown = commits.slice(0, 100);
  const lines = ['| Commit | Pull request | Risk label | Counts as |', '| --- | --- | --- | --- |'];
  for (const row of shown) {
    const pulls = row.pulls.length ? row.pulls.map(pr => `#${pr.number}`).join(', ') : 'none';
    const labels = row.pulls.length ? row.pulls.map(pr => (pr.labels.length ? pr.labels.join(' + ') : 'none')).join(', ') : 'none';
    lines.push(`| \`${short(row.sha)}\` | ${pulls} | ${labels} | ${row.reasons.length ? 'gated' : 'routine'} |`);
  }
  if (commits.length > shown.length) lines.push(`| … | ${commits.length - shown.length} more | | |`);
  return lines.join('\n');
}

async function commandClassify(env) {
  const sourceSha = requireSha(env, 'SOURCE_SHA');
  if (!env.STAGING_MANIFEST_DIR) fail('STAGING_MANIFEST_DIR is required');
  const { name, manifest } = readManifest(env.STAGING_MANIFEST_DIR, { environment: 'staging', sourceSha });
  const api = apiFromEnv(env);
  let found;
  try {
    found = await findPreviousProduction(api, { excludeRunId: env.GITHUB_RUN_ID });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    fail(`The previous production deploy could not be looked up (${error.message}). Nothing is promoted while the state of production is unknown; run again later`);
  }
  const previousSha = found.previous?.sha ?? '';
  const result = await classifyRange(api, previousSha, sourceSha);
  if (found.expired) result.reasons = ['the manifest artifact of the previous production deploy has expired (kept 90 days), so the range since then cannot be determined'];
  // A staging redeploy of the source production already runs must not restart production by itself.
  const promote = !(result.relation === 'identical' && env.EVENT_NAME !== 'workflow_dispatch');

  console.log(`Staging manifest: ${name}`);
  console.log(`Previous production source: ${previousSha || 'none'}`);
  for (const row of result.commits) {
    console.log(`${row.sha}  ${row.pulls.length ? row.pulls.map(pr => `#${pr.number} [${pr.labels.join(', ') || 'no risk label'}]`).join(' ') : 'no merged pull request'}`);
  }
  for (const reason of result.reasons) console.log(`gated: ${reason}`);
  console.log(`Promotion class: ${result.class}`);
  summary([
    `### Promotion class: **${result.class}**`,
    '',
    `- Source: \`${sourceSha}\``,
    `- Staging manifest: \`${name}\`${RUN_ID.test(String(env.STAGING_RUN_ID ?? '')) ? ` (Deploy staging run ${env.STAGING_RUN_ID})` : ''}`,
    `- Previous production source: ${previousSha ? `\`${previousSha}\` (Deploy production run ${found.previous.runId})` : 'none found'}`,
    `- Commits since then: ${result.commits.length}`,
    '',
    ...(result.reasons.length ? ['Gated because:', '', ...result.reasons.slice(0, 30).map(reason => `- ${reason}`), ...(result.reasons.length > 30 ? [`- … and ${result.reasons.length - 30} more`] : []), ''] : ['Every commit came in through a merged pull request labelled `risk:routine`.', '']),
    ...(result.commits.length ? [commitTable(result.commits), ''] : []),
    promote
      ? (result.class === 'routine' ? 'The deploy job runs in the `production` environment.' : 'The deploy job runs in the `production-gated` environment and waits for the owner\'s approval.')
      : 'Production already runs this source and this run was started by a staging deploy, so nothing is promoted. A manual dispatch redeploys it (gated).',
    '',
  ].join('\n'));
  setOutput('promote', promote ? 'true' : 'false');
  setOutput('promotion_class', result.class);
  setOutput('relation', result.relation);
  setOutput('previous_sha', previousSha);
  setOutput('staging_manifest', name);
  setOutput('api_image', manifest.api);
  setOutput('web_image', manifest.web);
}

async function commandRecheck(env) {
  const newSha = requireSha(env, 'SOURCE_SHA');
  const gatePreviousSha = env.GATE_PREVIOUS_SHA ?? '';
  if (gatePreviousSha !== '' && !SHA.test(gatePreviousSha)) fail('GATE_PREVIOUS_SHA must be empty or a full SHA');
  if (!['routine', 'gated'].includes(env.GATE_CLASS)) fail('GATE_CLASS must be routine or gated');
  const api = apiFromEnv(env);
  let result;
  try {
    result = await recheck(api, { newSha, gatePreviousSha, gateClass: env.GATE_CLASS, excludeRunId: env.GITHUB_RUN_ID });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    fail(`Could not confirm that production is where the gate saw it (${error.message}). Nothing was deployed; run again later`);
  }
  say(result.note);
  setOutput('proceed', result.proceed ? 'true' : 'false');
  setOutput('previous_sha', result.previous?.sha ?? '');
  setOutput('previous_run_id', result.previous?.runId ?? '');
  setOutput('previous_artifact', result.previous?.artifact ?? '');
}

function commandCheckManifest(env) {
  if (!env.MANIFEST_DIR) fail('MANIFEST_DIR is required');
  const { name } = readManifest(env.MANIFEST_DIR, { environment: env.MANIFEST_ENVIRONMENT, sourceSha: env.MANIFEST_SHA });
  console.log(`Manifest: ${name}`);
  setOutput('manifest_name', name);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  switch (argv[0]) {
    case 'resolve': return commandResolve(env);
    case 'classify': return commandClassify(env);
    case 'recheck': return commandRecheck(env);
    case 'check-manifest': return commandCheckManifest(env);
    default: fail('usage: promotion-class.mjs resolve|classify|recheck|check-manifest');
  }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    if (error instanceof PromotionError || error instanceof ApiError) {
      console.error(`::error::${error.message}`);
      summary(`**Stopped:** ${error.message}\n`);
    } else {
      console.error(`::error::Unexpected failure: ${error?.name ?? 'Error'}: ${error?.message ?? ''}`);
    }
    process.exitCode = 1;
  });
}
