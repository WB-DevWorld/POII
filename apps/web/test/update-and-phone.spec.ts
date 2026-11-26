import { expect, test } from '@playwright/test';

// Two findings of the staff test on staging (26 Nov 2026):
// - Test 23: a form opened before a release and sent after it showed Next's bare "This page couldn't load".
//   The new build answers an unknown Server Action with `X-Nextjs-Action-Not-Found: 1`; this test plays that
//   answer back and expects POII's own explanation instead.
// - Test 28: on a phone, table columns were squeezed; they now keep a readable width and the table scrolls.
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test('a form sent to a newer release explains the update and offers a reload', async ({ page }) => {
  await page.goto('/sources/new');
  await page.getByLabel('Title').fill(`Update check ${runId}`);
  await page.getByLabel('Paste text or Markdown').fill(`Text for the update check ${runId}.`);

  // Answer the Server Action POST exactly as a newer build does when it does not know the action id.
  await page.route('**/sources/new', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action']) {
      await route.fulfill({
        status: 409,
        headers: { 'content-type': 'text/plain', 'x-nextjs-action-not-found': '1' },
        body: 'Server Action unavailable.',
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Save source' }).click();
  const box = page.getByTestId('page-error');
  await expect(box).toContainText('POII was updated while this page was open');
  await expect(box).toContainText('nothing was saved');
  await expect(box.getByRole('button', { name: 'Reload the page' })).toBeVisible();
  // The site navigation stays, so the person is not stranded.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  // Nothing was stored.
  await page.unroute('**/sources/new');
  await page.goto(`/search?q=${encodeURIComponent(runId)}`);
  await expect(page.getByText(`Text for the update check ${runId}`)).toHaveCount(0);
});

test('on a phone, table columns keep their width and the table scrolls sideways', async ({ page }) => {
  // A source of our own, so the sources table has at least one row whatever the database holds.
  await page.goto('/sources/new');
  await page.getByLabel('Title').fill(`Phone table check ${runId} with a long enough title to need room`);
  await page.getByLabel('Paste text or Markdown').fill(`Phone table text ${runId}.`);
  await page.getByRole('button', { name: 'Save source' }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}/);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/sources');
  const table = page.locator('main table').first();
  await expect(table).toBeVisible();

  const widths = await table.locator('thead th').evaluateAll((cells) => cells.map((c) => c.getBoundingClientRect().width));
  expect(widths.length).toBeGreaterThan(2);
  for (const width of widths) expect(width).toBeGreaterThanOrEqual(7 * 16 - 1);

  // The table is wider than the phone and its box scrolls; the page itself does not.
  const layout = await page.evaluate(() => {
    const t = document.querySelector('main table') as HTMLElement;
    const scroller = (t.closest('.table-wrap') as HTMLElement | null) ?? t;
    return {
      scrollerScrolls: scroller.scrollWidth > scroller.clientWidth,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  expect(layout.scrollerScrolls).toBe(true);
  expect(layout.pageOverflows).toBe(false);
});
