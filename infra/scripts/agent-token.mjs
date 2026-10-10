#!/usr/bin/env node
// Mints a short-lived installation token for the agent GitHub App, so agents can commit and open PRs as
// the bot instead of the owner. Prepared for the bot-identity switch-over (docs/runbooks/bot-identity-switchover.md);
// unused until the App exists. No dependencies. Prints only the token on stdout.
//
// Env: POII_AGENT_APP_ID                  numeric App id
//      POII_AGENT_APP_PRIVATE_KEY_FILE    path to the App's PEM, kept OUTSIDE the repository
//      POII_AGENT_INSTALLATION_ID         optional; resolved from the repository when absent
//      GITHUB_REPOSITORY                  optional, default WB-DevWorld/POII
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const b64url = input => Buffer.from(input).toString('base64url');

/** RS256 JWT for GitHub App authentication (iat 60 s in the past, 9 minutes of validity). */
export function appJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function github(path, { method = 'GET', token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'poii-agent-token' },
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: ${response.status}`);
  return response.json();
}

export async function installationToken(env = process.env, fetchImpl = fetch) {
  const appId = env.POII_AGENT_APP_ID;
  const keyFile = env.POII_AGENT_APP_PRIVATE_KEY_FILE;
  if (!appId || !keyFile) throw new Error('POII_AGENT_APP_ID and POII_AGENT_APP_PRIVATE_KEY_FILE are required');
  const jwt = appJwt(appId, readFileSync(keyFile, 'utf8'));
  const repository = env.GITHUB_REPOSITORY ?? 'WB-DevWorld/POII';
  const installationId = env.POII_AGENT_INSTALLATION_ID ?? (await github(`/repos/${repository}/installation`, { token: jwt, fetchImpl })).id;
  const { token } = await github(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: jwt, fetchImpl });
  return token;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  installationToken().then(token => process.stdout.write(token)).catch(error => { console.error(error.message); process.exit(1); });
}
