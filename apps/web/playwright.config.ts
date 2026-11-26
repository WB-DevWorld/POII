import { defineConfig } from '@playwright/test';

// Core-journey smoke. Starts the built API and web app against the configured PostgreSQL.
const apiPort = Number(process.env.SMOKE_API_PORT ?? 3001);
const webPort = Number(process.env.SMOKE_WEB_PORT ?? 3000);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

// POII_E2E_IDENTITY=local-signin runs only the sign-in journey (test/signin.spec.ts), with both servers under
// the local-signin adapter. Without it everything else runs under whatever the environment says (local-owner in
// CI), exactly as before. The owner password and the session secret come from the environment, generated per
// run; the database must not have a sign-in user yet (the bootstrap password applies only then).
const SIGNIN_SPEC = /signin\.spec\.ts$/;
const signin = process.env.POII_E2E_IDENTITY === 'local-signin';
if (process.env.POII_E2E_IDENTITY && !signin) throw new Error(`Unsupported POII_E2E_IDENTITY: ${process.env.POII_E2E_IDENTITY}`);
if (signin && !(process.env.POII_OWNER_BOOTSTRAP_PASSWORD && process.env.POII_SESSION_SECRET)) {
  throw new Error('POII_E2E_IDENTITY=local-signin needs POII_OWNER_BOOTSTRAP_PASSWORD and POII_SESSION_SECRET (generate both per run)');
}
// The sign-in cookie and the API's trusted origin both follow WEB_BASE_URL: it must be the origin the browser uses.
const identityEnv: Record<string, string> = signin ? { POII_IDENTITY_ADAPTER: 'local-signin', WEB_BASE_URL: webUrl } : {};
// Never take over a running server for the sign-in run: it would most likely be a local-owner one.
const reuseExistingServer = !process.env.CI && !signin;

export default defineConfig({
  testDir: './test',
  testMatch: signin ? SIGNIN_SPEC : /.*\.spec\.ts/,
  testIgnore: signin ? [] : SIGNIN_SPEC,
  timeout: 60_000,
  retries: 0,
  // One browser at a time. Every test talks to the same API and the same database, so parallel browsers buy
  // little, and on a busy machine several starting at once stalled each other's first requests.
  workers: 1,
  // The HTML report lists every action with its argument and a trace records what is typed and every cookie,
  // so the sign-in run writes neither: the password it types would end up in a CI artifact.
  reporter: signin ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: { baseURL: webUrl, trace: signin ? 'off' : 'retain-on-failure' },
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `${apiUrl}/health/ready`,
      timeout: 60_000,
      reuseExistingServer,
      env: { ...process.env, PORT: String(apiPort), GIT_SHA: process.env.GIT_SHA ?? 'smoke', ...identityEnv },
    },
    {
      command: `pnpm exec next start --hostname 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      timeout: 60_000,
      reuseExistingServer,
      env: { ...process.env, PORT: String(webPort), HOSTNAME: '127.0.0.1', API_INTERNAL_URL: apiUrl, ...identityEnv },
    },
  ],
});
