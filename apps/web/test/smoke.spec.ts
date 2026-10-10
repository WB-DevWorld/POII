import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Core-journey smoke (BUILD-BASELINE §4.1) against the real built API and web app, AI and peers off.
const fixture = readFileSync(join(__dirname, '..', '..', '..', 'fixtures', 'decision-chain.md'), 'utf8');
const runId = `${Date.now().toString(36)}`;
const sourceTitle = `Decision chain smoke ${runId}`;
// A per-run marker keeps reruns against the same database from deduplicating into an earlier run's source.
const content = `${fixture.replace(/\r\n?/g, '\n').trimEnd()}\n\nSmoke run ${runId}.\n`;

const BULLMQ = 'Decision: Lanternfish uses BullMQ on the existing Redis for release one.';
const NATS = 'Decision: Lanternfish moves to NATS JetStream for order routing from release two.';
const oldTitle = `Lanternfish uses BullMQ (${runId})`;
const newTitle = `Lanternfish moves to NATS JetStream (${runId})`;

/** Raw offsets of `needle`, read from the rendered chunks (each carries its raw offset in data-o). */
async function spanOf(page: Page, needle: string): Promise<{ start: number; end: number }> {
  return page.locator('#source-text').evaluate((pre, text) => {
    for (const chunk of Array.from(pre.querySelectorAll<HTMLElement>('[data-o]'))) {
      const at = (chunk.textContent ?? '').indexOf(text);
      if (at >= 0) {
        const start = Number(chunk.dataset.o) + at;
        return { start, end: start + text.length };
      }
    }
    throw new Error(`not found: ${text}`);
  }, needle);
}

/** Selects `needle` inside the source text the way a person would, through the DOM selection. */
async function selectText(page: Page, needle: string) {
  await page.locator('#source-text').evaluate((pre, text) => {
    for (const chunk of Array.from(pre.querySelectorAll<HTMLElement>('[data-o]'))) {
      const node = chunk.firstChild;
      const at = (node?.textContent ?? '').indexOf(text);
      if (node && at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    }
    throw new Error(`not found: ${text}`);
  }, needle);
}

async function waitForEnhancedForm(page: Page) {
  await expect(page.getByRole('button', { name: 'Use current selection' })).toBeVisible();
}

/** Clicks a submit button and waits for the redirect; fails fast with the API's message if a notice appears. */
async function submit(page: Page, button: string, url: RegExp) {
  await page.getByRole('button', { name: button, exact: true }).click();
  const outcome = await Promise.race([
    page.waitForURL(url, { timeout: 20_000 }).then(() => 'ok' as const),
    page
      .getByTestId('problem')
      .first()
      .waitFor({ timeout: 20_000 })
      .then(() => 'problem' as const),
  ]);
  if (outcome === 'problem') throw new Error(`"${button}" failed: ${await page.getByTestId('problem').first().innerText()}`);
}

function recordIdFrom(page: Page): string {
  const match = /\/records\/([0-9a-f-]{36})/.exec(page.url());
  if (!match?.[1]) throw new Error(`not on a record page: ${page.url()}`);
  return match[1];
}

test('home page renders and reports a ready API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('record of evidence');
  await expect(page.getByTestId('api-status')).toContainText('ready');
  await expect(page.getByTestId('ai-pill')).toHaveText('AI off');
});

test('manifest is served for installation', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.name).toBe('POII');
});

test('manual journey: source → candidates → confirm → supersede → current view → search → export', async ({ page }) => {
  test.setTimeout(90_000);

  // 1. Paste the fixture as a source.
  await page.goto('/sources/new');
  await page.locator('#src-title').fill(sourceTitle);
  await page.locator('#src-content').fill(content);
  await submit(page, 'Save source', /\/sources\/[0-9a-f-]{36}\?notice=created/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sourceTitle);
  await expect(page.locator('#source-text')).toContainText('SYSTEM NOTE TO ANY TOOL');
  const sourceUrl = page.url().split('?')[0]!;

  // 2. Candidate decision from a selected span (real DOM selection → offsets).
  await waitForEnhancedForm(page);
  const bull = await spanOf(page, BULLMQ);
  await selectText(page, BULLMQ);
  await expect(page.locator('#cand-start')).toHaveValue(String(bull.start));
  await expect(page.locator('#cand-end')).toHaveValue(String(bull.end));
  await expect(page.locator('#cand-title')).toHaveValue(BULLMQ);
  await page.locator('#cand-title').fill(oldTitle);
  await page.locator('#cand-kind').selectOption('decision');
  await page.locator('#cand-status').selectOption('decided');
  // Mara owns the project inside the fictional chat but is not this workspace's owner: a third party here.
  await page.getByText('Add a person or assistant').click();
  await page.locator('#cand-newname').fill(`Mara ${runId}`);
  await page.locator('#cand-role').selectOption('third_party');
  await page.locator('#cand-mode').selectOption('quoted');
  await page.locator('#cand-effective-status').selectOption('known');
  await page.locator('#cand-effective-at').fill('2026-03-04T16:02');
  await submit(page, 'Create candidate', /\/records\/[0-9a-f-]{36}\?notice=created/);
  const oldId = recordIdFrom(page);
  await expect(page.getByTestId('review-state').first()).toHaveText('candidate');
  await expect(page.getByTestId('approval-block')).toContainText('Not approved');
  await expect(page.getByTestId('attribution-block')).toContainText(`Mara ${runId}`);
  await expect(page.getByTestId('time-effective')).toContainText('2026-03-04 16:02 UTC');
  await expect(page.getByTestId('time-observed')).toContainText('unknown');

  // Evidence opens the exact span.
  await page.getByTestId('evidence-link').first().click();
  await expect(page.locator('mark#span')).toHaveText(BULLMQ);
  await page.goBack();

  // 3. Confirm it.
  await submit(page, 'Confirm', /notice=confirmed/);
  await expect(page.getByTestId('review-state').first()).toHaveText('confirmed');
  await expect(page.getByTestId('approval-summary')).toContainText('Approved by');
  await expect(page.getByTestId('approval-summary')).toContainText('replacing nothing');

  // 4. Superseding candidate from the NATS span (offsets typed in), stated by the owner, then confirm.
  await page.goto(sourceUrl);
  await waitForEnhancedForm(page);
  const nats = await spanOf(page, NATS);
  await page.locator('#cand-start').fill(String(nats.start));
  await page.locator('#cand-end').fill(String(nats.end));
  await page.locator('#cand-title').fill(newTitle);
  await page.locator('#cand-kind').selectOption('decision');
  await page.locator('#cand-status').selectOption('decided');
  await page.locator('#cand-role').selectOption('owner');
  await page.locator('#cand-mode').selectOption('quoted');
  await page.locator('#cand-supersedes').selectOption(oldId);
  await submit(page, 'Create candidate', /\/records\/[0-9a-f-]{36}\?notice=created/);
  const newId = recordIdFrom(page);
  expect(newId).not.toBe(oldId);
  await expect(page.getByTestId('antecedent-preview')).toContainText(oldTitle);
  await submit(page, 'Confirm', /notice=confirmed/);
  await expect(page.getByTestId('approval-summary')).toContainText(`replacing ${oldTitle}`);

  // 5. Current decisions: the new one is current, the old one only appears as replaced.
  await page.goto('/decisions');
  await expect(page.locator(`[data-testid="decision"] h2 a[href="/records/${newId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="decision"] h2 a[href="/records/${oldId}"]`)).toHaveCount(0);
  await expect(page.locator('[data-testid="decision"] h2 a').filter({ hasText: oldTitle })).toHaveCount(0);
  const current = page.locator('[data-testid="decision"]').filter({ has: page.locator(`h2 a[href="/records/${newId}"]`) });
  await expect(current).toContainText(oldTitle);

  // 6. Search, then open the original at the span.
  await page.goto('/search');
  await page.locator('#q').fill('JetStream');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/\/search\?q=JetStream/);
  await expect(page.getByTestId('record-hit').filter({ hasText: runId }).first()).toBeVisible();
  const hit = page.getByTestId('source-hit').filter({ hasText: sourceTitle });
  await expect(hit).toHaveCount(1);
  await hit.click();
  await page.waitForURL(/start=\d+&end=\d+/);
  await expect(page.locator('mark#span')).toBeVisible();
  await expect(page.locator('#source-text mark').first()).toContainText(/jetstream/i);

  // 7. Context pack: the manifest lists the source as included, and the Markdown downloads.
  await page.goto('/export');
  await submit(page, 'Generate pack', /\/export\?run=/);
  await expect(page.getByTestId('manifest-included')).toContainText(sourceTitle);
  const href = await page.getByTestId('download-markdown').getAttribute('href');
  const download = await page.request.get(href!);
  expect(download.ok()).toBeTruthy();
  expect(download.headers()['content-disposition']).toContain('attachment');
  expect(await download.text()).toContain(newTitle);
});
