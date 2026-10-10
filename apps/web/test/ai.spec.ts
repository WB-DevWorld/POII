import { expect, test } from '@playwright/test';

// #13 AI smoke, with AI off (as in CI): the source page links to the AI page, which explains why AI is
// unavailable (off, or never send to AI) and points to the manual path. No provider is involved.
const apiPort = Number(process.env.SMOKE_API_PORT ?? 3001);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const runId = `${Date.now().toString(36)}`;

test('AI page explains AI is off and never-send sources are unavailable', async ({ page, request }) => {
  const allowed = await request.post(`${apiUrl}/v1/sources`, {
    data: { title: `AI smoke allowed ${runId}`, kind: 'paste', content: `AI smoke ${runId}: Decision: ship weekly.` },
  });
  expect(allowed.ok()).toBeTruthy();
  const allowedId = (await allowed.json()).id as string;
  const secret = await request.post(`${apiUrl}/v1/sources`, {
    data: { title: `AI smoke never send ${runId}`, kind: 'paste', content: `AI smoke secret ${runId}.`, aiAllowed: false },
  });
  expect(secret.ok()).toBeTruthy();
  const secretId = (await secret.json()).id as string;

  await page.goto(`/sources/${allowedId}`);
  await page.getByTestId('ai-link').click();
  await page.waitForURL(new RegExp(`/sources/${allowedId}/ai`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI-assisted extraction');
  await expect(page.getByTestId('ai-unavailable')).toHaveAttribute('data-reason', 'off');
  await expect(page.getByTestId('ai-prompt')).toHaveCount(0);

  await page.goto(`/sources/${secretId}/ai`);
  await expect(page.getByTestId('ai-unavailable')).toHaveAttribute('data-reason', 'never_send');
  await expect(page.getByTestId('ai-unavailable')).toContainText('never send to AI');
  await expect(page.getByRole('button', { name: /Prepare preview|Send/ })).toHaveCount(0);

  // The API refuses AI regardless of the page (off here: 503 ai_disabled).
  const direct = await request.post(`${apiUrl}/v1/ai/preview`, { data: { sourceId: secretId } });
  expect(direct.status()).toBe(503);
});
