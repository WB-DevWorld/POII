#!/usr/bin/env node
// Short-lived GitHub token for the POII agent bot (GitHub App "wbdevworld-poii-agent").
//
// Agents commit and open pull requests as this App, never through the owner's account,
// so that the owner's approvals gate something. The App's private key stays in a file
// outside the repository; this script reads it to sign a JSON Web Token, exchanges it
// for a one-hour installation token, and never prints or logs the key.
//
// Configuration (environment variables, or the repo-root `.env`, which is gitignored):
//   POII_AGENT_APP_ID            numeric App ID
//   POII_AGENT_INSTALLATION_ID   numeric installation ID on WB-DevWorld/POII
//   POII_AGENT_PRIVATE_KEY_PATH  path to the App's PEM file
//
// Usage:
//   node scripts/agent-token.mjs                 prints a token (for GH_TOKEN=$(...) gh ...)
//   node scripts/agent-token.mjs check           prints App slug and expiry, not the token
//   node scripts/agent-token.mjs git-credential  git credential helper protocol (see below)
//
// Git credential helper (repo-local, so every push from this checkout goes out as the bot):
//   git config --local credential.helper ''
//   git config --local --add credential.helper '!node C:/dev/poii/scripts/agent-token.mjs git-credential'
//
// Tokens are cached in the OS temp directory until five minutes before they expire.

import { createSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.github.com";
const CACHE = join(tmpdir(), "poii-agent-token.json");

function loadConfig() {
  const env = { ...process.env };
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const appId = env.POII_AGENT_APP_ID;
  const installationId = env.POII_AGENT_INSTALLATION_ID;
  const keyPath = env.POII_AGENT_PRIVATE_KEY_PATH;
  if (!appId || !installationId || !keyPath) {
    throw new Error("missing POII_AGENT_APP_ID, POII_AGENT_INSTALLATION_ID or POII_AGENT_PRIVATE_KEY_PATH");
  }
  return { appId, installationId, keyPath };
}

function appJwt(appId, pem) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(pem).toString("base64url")}`;
}

async function mint() {
  const { appId, installationId, keyPath } = loadConfig();
  const pem = readFileSync(keyPath, "utf8");
  const headers = {
    Authorization: `Bearer ${appJwt(appId, pem)}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "poii-agent-token",
  };
  const app = await fetch(`${API}/app`, { headers });
  if (!app.ok) throw new Error(`App JWT rejected: HTTP ${app.status}`);
  const { slug } = await app.json();
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, { method: "POST", headers });
  if (!res.ok) throw new Error(`installation token refused: HTTP ${res.status}`);
  const { token, expires_at: expiresAt } = await res.json();
  const entry = { slug, token, expiresAt };
  try {
    writeFileSync(CACHE, JSON.stringify(entry), { mode: 0o600 });
  } catch {
    // cache is an optimisation only
  }
  return entry;
}

async function getToken() {
  try {
    if (existsSync(CACHE)) {
      const cached = JSON.parse(readFileSync(CACHE, "utf8"));
      if (Date.parse(cached.expiresAt) - Date.now() > 5 * 60 * 1000) return cached;
    }
  } catch {
    // fall through to a fresh token
  }
  return mint();
}

function readStdin() {
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(data));
  });
}

const mode = process.argv[2] ?? "token";
try {
  if (mode === "git-credential") {
    const action = process.argv[3];
    const input = await readStdin();
    if (action !== "get") process.exit(0);
    const host = /^host=(.*)$/m.exec(input)?.[1];
    if (host && host !== "github.com") process.exit(0);
    const { token } = await getToken();
    process.stdout.write(`username=x-access-token\npassword=${token}\n`);
  } else if (mode === "check") {
    const { slug, expiresAt } = await getToken();
    console.log(`app=${slug} token expires ${expiresAt}`);
  } else if (mode === "token") {
    const { token } = await getToken();
    process.stdout.write(token);
  } else {
    console.error("usage: agent-token.mjs [token|check|git-credential get]");
    process.exit(2);
  }
} catch (err) {
  console.error(`agent-token: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
