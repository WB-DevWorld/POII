import { expect, test } from '@playwright/test';

test('home page renders and reports a ready API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('record of evidence');
  await expect(page.getByTestId('api-status')).toContainText('ready');
  await expect(page.getByText('AI off')).toBeVisible();
});

test('manifest is served for installation', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.name).toBe('POII');
});
