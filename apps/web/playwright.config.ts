import { defineConfig } from '@playwright/test';

// Core-journey smoke. Starts the built API and web app against the configured PostgreSQL.
const apiPort = Number(process.env.SMOKE_API_PORT ?? 3001);
const webPort = Number(process.env.SMOKE_WEB_PORT ?? 3000);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: webUrl, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `${apiUrl}/health/ready`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: { ...process.env, PORT: String(apiPort), GIT_SHA: process.env.GIT_SHA ?? 'smoke' },
    },
    {
      command: `pnpm exec next start --hostname 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: { ...process.env, PORT: String(webPort), HOSTNAME: '127.0.0.1', API_INTERNAL_URL: apiUrl },
    },
  ],
});
