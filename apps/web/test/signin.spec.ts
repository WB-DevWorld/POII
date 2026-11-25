import { expect, test, type BrowserContext } from '@playwright/test';

// Sign-in journey in a browser (ADR-0009), against the real built API and web app under local-signin, the
// adapter staging runs. Selected by POII_E2E_IDENTITY=local-signin (playwright.config.ts); the smoke and AI
// specs keep running under local-owner. The API-level rules are covered by apps/api/test/auth.signin.test.ts.
//
// One test on purpose: the steps share one browser session, and the API allows three sign-in attempts per
// 10 s from one address. This test makes exactly two (one wrong, one right).
const login = process.env.POII_OWNER_LOGIN ?? 'owner';
// Generated for this run and handed in by the environment; never written to a file or printed.
const password = process.env.POII_OWNER_BOOTSTRAP_PASSWORD ?? '';
const runId = `${Date.now().toString(36)}`;
const sourceTitle = `Sign-in journey ${runId}`;
const SESSION_COOKIE = 'poii_session';
const SIGNIN_WITH_NEXT = /\/signin\?next=%2Fdecisions$/;

/** The session cookie's flags. The value is never returned, so no assertion message can contain it. */
async function sessionCookie(context: BrowserContext): Promise<{ httpOnly: boolean; sameSite: string } | null> {
  const cookie = (await context.cookies()).find(c => c.name === SESSION_COOKIE);
  return cookie ? { httpOnly: cookie.httpOnly, sameSite: cookie.sameSite } : null;
}

test('sign-in journey: redirect → wrong password → sign in → write → sign out', async ({ page, context }) => {
  expect(password.length, 'POII_OWNER_BOOTSTRAP_PASSWORD is set for this run').toBeGreaterThanOrEqual(12);

  await test.step('signed out, a protected page redirects to /signin and keeps the target', async () => {
    await page.goto('/decisions');
    await expect(page).toHaveURL(SIGNIN_WITH_NEXT);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    await expect(page.locator('input[name="next"]')).toHaveValue('/decisions');
    await expect(page.getByTestId('sign-out')).toHaveCount(0);
    expect(await sessionCookie(context)).toBeNull();
  });

  await test.step('a wrong password shows the error and stays signed out', async () => {
    await page.locator('#signin-login').fill(login);
    await page.locator('#signin-password').fill(`not-the-password-${runId}`);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('problem')).toContainText('Login or password is wrong.');
    await expect(page).toHaveURL(SIGNIN_WITH_NEXT);
    expect(await sessionCookie(context)).toBeNull();
  });

  await test.step('the right password signs in and lands on the requested page', async () => {
    await page.locator('#signin-password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/decisions$/);
    // The page itself, not only the address: the redirect must render the requested page, signed in.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Current decisions');
    await expect(page.getByTestId('sign-out')).toBeVisible();
  });

  await test.step('the session cookie is HttpOnly and out of reach of page scripts', async () => {
    expect(await sessionCookie(context)).toEqual({ httpOnly: true, sameSite: 'Lax' });
    expect(await page.evaluate(name => document.cookie.includes(name), SESSION_COOKIE)).toBe(false);
  });

  await test.step('the session carries a write: a pasted source is saved and listed', async () => {
    await page.goto('/sources/new');
    await page.locator('#src-title').fill(sourceTitle);
    await page.locator('#src-content').fill(`Sign-in journey ${runId}.\nDecision: sign-in is covered by a browser test.\n`);
    await page.getByRole('button', { name: 'Save source', exact: true }).click();
    await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}\?notice=created/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(sourceTitle);
    await page.goto('/sources');
    await expect(page.getByTestId('sources-table').getByRole('link', { name: sourceTitle, exact: true })).toBeVisible();
  });

  await test.step('sign-out returns to /signin and protected pages redirect again', async () => {
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/signin\?signedOut=1$/);
    await expect(page.getByTestId('notice')).toHaveText('Signed out.');
    expect(await sessionCookie(context)).toBeNull();
    await page.goto('/decisions');
    await expect(page).toHaveURL(SIGNIN_WITH_NEXT);
    await expect(page.getByTestId('sign-out')).toHaveCount(0);
  });
});
