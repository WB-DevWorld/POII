import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// The rest of the manual journey (BUILD-BASELINE §4.1) in a browser, against the real built API and web app, AI
// and peers off: step 4 (lifecycle status through the record page) and step 8 (back up, restore into a clean
// install), on the two fixtures smoke.spec.ts does not use. Every test adds its own source, so the tests do not
// depend on each other, on the other spec files or on what the database already holds.
const repoRoot = join(__dirname, '..', '..', '..');
const webDir = join(__dirname, '..');
const apiDir = join(repoRoot, 'apps', 'api');
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A fixture with a per-run, per-test marker, so no run deduplicates into another run's (or test's) source. */
function fixture(name: 'intent-vs-observed' | 'price-conflict', tag: string): string {
  const text = readFileSync(join(repoRoot, 'fixtures', `${name}.md`), 'utf8');
  return `${text.replace(/\r\n?/g, '\n').trimEnd()}\n\nJourney run ${runId} (${tag}).\n`;
}

const LIMIT_DESIGN = 'Each partner token is limited to **100 requests per minute** on the public routing API.';
const LIMIT_LOG = 'gateway: rate limit policy loaded: partner_token 1000 req/min, burst 200';
const PRICE_EMAIL = 'the unit price for the Type-B brass widget is **EUR 12.40**';
const PRICE_CATALOGUE = '| Type-B brass widget | EUR 11.90 |';
const PRICE_MEMO = 'We use **EUR 12.40** per Type-B widget for the Q3 budget and the first order of 500 units.';

const LIFECYCLE = ['proposed', 'decided', 'implemented', 'observed', 'unknown'] as const;
type Lifecycle = (typeof LIFECYCLE)[number];
const ID = '[0-9a-f-]{36}';

// ----- page helpers (same approach as smoke.spec.ts) ----------------------------------------------

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

// How long a submit may take to redirect. Generous on purpose: on a busy machine the first requests of a run have
// been seen to wait some 20 s before the browser sent them; a correct but slow answer is not a failure.
const SUBMIT_TIMEOUT_MS = 45_000;
/** Per test. Each passes in well under 30 s; the margin is for a run whose first requests are held up like that. */
const SLOW_START_TIMEOUT_MS = 180_000;

/** Clicks a submit button and waits for the redirect; fails fast with the API's message if a notice appears. */
async function submit(page: Page, button: string, url: RegExp) {
  await page.getByRole('button', { name: button, exact: true }).click();
  const outcome = await Promise.race([
    page.waitForURL(url, { timeout: SUBMIT_TIMEOUT_MS }).then(() => 'ok' as const),
    page
      .getByTestId('problem')
      .first()
      .waitFor({ timeout: SUBMIT_TIMEOUT_MS })
      .then(() => 'problem' as const),
  ]);
  if (outcome === 'problem') throw new Error(`"${button}" failed: ${await page.getByTestId('problem').first().innerText()}`);
}

function idFrom(page: Page, kind: 'records' | 'sources'): string {
  const match = new RegExp(`/${kind}/(${ID})`).exec(page.url());
  if (!match?.[1]) throw new Error(`not on a ${kind} page: ${page.url()}`);
  return match[1];
}

/** The lifecycle status tag of a record page, or of one row in a list. */
const statusTag = (scope: Page | Locator) => scope.getByTitle('Lifecycle status', { exact: true });

/** The list row (records list, or "records citing this source") that links to the record. */
const rowFor = (list: Locator, recordId: string) => list.locator('li').filter({ has: list.page().locator(`a[href="/records/${recordId}"]`) });

async function addSource(page: Page, title: string, content: string): Promise<string> {
  await page.goto('/sources/new');
  await page.locator('#src-title').fill(title);
  await page.locator('#src-content').fill(content);
  await submit(page, 'Save source', new RegExp(`/sources/${ID}\\?notice=created`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  return idFrom(page, 'sources');
}

type Candidate = {
  needle: string;
  title: string;
  kind: 'fact' | 'requirement' | 'decision' | 'question';
  /** Lifecycle status chosen on the candidate form; the form's default (unknown) when left out. */
  status?: Lifecycle;
  /** A person added inline as "stated by" (always a third party here: the fixtures' people are not the workspace owner). */
  statedBy?: string;
  /** Effective time: a `datetime-local` value (UTC) for known, or the explicit status unknown. */
  effective?: { at: string } | 'unknown';
};

/** Creates a candidate on the source page from a real selection of `needle`; ends on the new record's page. */
async function createCandidate(page: Page, sourceId: string, candidate: Candidate): Promise<string> {
  await page.goto(`/sources/${sourceId}`);
  await expect(page.getByRole('button', { name: 'Use current selection' })).toBeVisible();
  const span = await spanOf(page, candidate.needle);
  await selectText(page, candidate.needle);
  await expect(page.locator('#cand-start')).toHaveValue(String(span.start));
  await expect(page.locator('#cand-end')).toHaveValue(String(span.end));
  await expect(page.getByTestId('selected-excerpt').locator('blockquote')).toHaveText(candidate.needle);
  await page.locator('#cand-title').fill(candidate.title);
  await page.locator('#cand-kind').selectOption(candidate.kind);
  if (candidate.status) await page.locator('#cand-status').selectOption(candidate.status);
  if (candidate.statedBy) {
    await page.getByText('Add a person or assistant').click();
    await page.locator('#cand-newname').fill(candidate.statedBy);
  }
  await page.locator('#cand-role').selectOption('third_party');
  await page.locator('#cand-mode').selectOption('quoted');
  if (candidate.effective === 'unknown') {
    await page.locator('#cand-effective-status').selectOption('unknown');
  } else if (candidate.effective) {
    await page.locator('#cand-effective-status').selectOption('known');
    await page.locator('#cand-effective-at').fill(candidate.effective.at);
  }
  await submit(page, 'Create candidate', new RegExp(`/records/${ID}\\?notice=created`));
  await expect(page.getByTestId('record-title')).toHaveText(candidate.title);
  await expect(page.getByTestId('review-state').first()).toHaveText('candidate');
  return idFrom(page, 'records');
}

/** Confirms the candidate whose page is open. */
async function confirmHere(page: Page) {
  await submit(page, 'Confirm', /notice=confirmed/);
  await expect(page.getByTestId('review-state').first()).toHaveText('confirmed');
  await expect(page.getByTestId('approval-summary')).toContainText(/Approved by .+ with authority owner/);
}

/**
 * Step 4: sets the lifecycle status through the record page's own control. The page is opened without a notice
 * first, so the redirect to `?notice=status` proves that this submit went through (and not an earlier one).
 */
async function setStatus(page: Page, recordUrl: string, status: Lifecycle, note?: string) {
  await page.goto(recordUrl);
  await page.locator('#status-status').selectOption(status);
  if (note) await page.locator('#status-note').fill(note);
  await submit(page, 'Set status', /notice=status/);
  await expect(page.getByTestId('notice')).toHaveAttribute('data-notice', 'status');
  await expect(statusTag(page)).toHaveText(status);
}

/** The change kinds in the record's history table, newest first. */
const historyKinds = (page: Page) => page.getByTestId('versions').locator('tbody tr td:nth-child(2)');

// ----- step 4 on intent-vs-observed ---------------------------------------------------------------

test('intent and observed: lifecycle status set on the record page shows on the record, in the list and on the source', async ({ page }) => {
  test.setTimeout(SLOW_START_TIMEOUT_MS);
  const sourceTitle = `Rate limit: design and log ${runId}`;
  const intentTitle = `Partner tokens are limited to 100 requests per minute (${runId})`;
  const observedTitle = `Staging gateway allows 1000 requests per minute (${runId})`;
  const sourceId = await addSource(page, sourceTitle, fixture('intent-vs-observed', 'status'));

  // The intended design, a decision by the fixture's author. Nothing is chosen for the status: it starts unknown.
  const intentId = await createCandidate(page, sourceId, {
    needle: LIMIT_DESIGN, title: intentTitle, kind: 'decision', statedBy: `Mara ${runId}`, effective: { at: '2026-04-10T00:00' },
  });
  const intentUrl = `/records/${intentId}`;
  await expect(statusTag(page)).toHaveText('unknown');
  // The control offers exactly the five statuses of §4.1 and starts on the record's own.
  expect((await page.locator('#status-status option').allTextContents()).sort()).toEqual([...LIFECYCLE].sort());
  await expect(page.locator('#status-status')).toHaveValue('unknown');

  // A candidate's status can be set; confirming keeps it; a confirmed record's status can still change.
  await setStatus(page, intentUrl, 'proposed', 'drafted in the design note');
  await expect(page.getByTestId('review-state').first()).toHaveText('candidate');
  await confirmHere(page);
  await expect(statusTag(page)).toHaveText('proposed');
  await setStatus(page, intentUrl, 'decided', 'approved design');
  await expect(page.getByTestId('review-state').first()).toHaveText('confirmed');
  await expect(page.getByTestId('approval-summary')).toContainText('replacing nothing');
  await expect(page.locator('#status-status')).toHaveValue('decided');
  // Every status change is a version of its own, with its note.
  await expect(historyKinds(page)).toHaveText(['status', 'confirm', 'status', 'create']);
  await expect(page.getByTestId('versions').locator('tbody tr').first()).toContainText('approved design');
  await expect(page.getByTestId('time-observed')).toContainText('unknown');

  // The observed behaviour, a fact from the deployment log.
  const observedId = await createCandidate(page, sourceId, { needle: LIMIT_LOG, title: observedTitle, kind: 'fact' });
  const observedUrl = `/records/${observedId}`;
  await expect(statusTag(page)).toHaveText('unknown');
  await setStatus(page, observedUrl, 'implemented', 'policy loaded by the gateway');
  await setStatus(page, observedUrl, 'unknown');
  // "observed" with a known time needs the time: the form says so and changes nothing.
  await page.goto(observedUrl);
  await page.locator('#status-status').selectOption('observed');
  await page.locator('#status-obs-status').selectOption('known');
  await page.getByRole('button', { name: 'Set status', exact: true }).click();
  const statusForm = page.getByRole('form', { name: 'Set status' });
  await expect(statusForm.getByTestId('problem')).toContainText('Observed time is marked known');
  await expect(statusTag(page)).toHaveText('unknown');
  await page.locator('#status-status').selectOption('observed');
  await page.locator('#status-obs-status').selectOption('known');
  await page.locator('#status-obs-at').fill('2026-06-02T14:07');
  await page.locator('#status-note').fill('seen on staging');
  await page.getByRole('button', { name: 'Set status', exact: true }).click();
  await page.waitForURL(/notice=status/, { timeout: SUBMIT_TIMEOUT_MS });
  await expect(statusTag(page)).toHaveText('observed');
  await expect(page.getByTestId('time-observed')).toContainText('2026-06-02 14:07 UTC');
  await expect(historyKinds(page)).toHaveText(['status', 'status', 'status', 'create']);
  await confirmHere(page);
  await expect(statusTag(page)).toHaveText('observed');

  // Each record's own page.
  await page.goto(intentUrl);
  await expect(statusTag(page)).toHaveText('decided');
  await expect(page.getByTestId('attribution-block')).toContainText(`Mara ${runId}`);
  await page.goto(observedUrl);
  await expect(statusTag(page)).toHaveText('observed');
  await expect(page.getByTestId('evidence-list').locator('blockquote')).toHaveText(LIMIT_LOG);

  // The records list shows both with their status, and its status filter tells them apart.
  await page.goto('/records');
  const list = page.getByTestId('records-list');
  await expect(statusTag(rowFor(list, intentId))).toHaveText('decided');
  await expect(statusTag(rowFor(list, observedId))).toHaveText('observed');
  await expect(rowFor(list, intentId).getByTestId('review-state')).toHaveText('confirmed');
  await expect(rowFor(list, observedId).getByTestId('review-state')).toHaveText('confirmed');
  await page.locator('#f-status').selectOption('observed');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/lifecycleStatus=observed/);
  await expect(rowFor(list, observedId)).toHaveCount(1);
  await expect(rowFor(list, intentId)).toHaveCount(0);
  await page.locator('#f-status').selectOption('decided');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/lifecycleStatus=decided/);
  await expect(rowFor(list, intentId)).toHaveCount(1);
  await expect(rowFor(list, observedId)).toHaveCount(0);

  // The source shows intent and observed reality side by side: both records, each with its kind and status.
  await page.goto(`/sources/${sourceId}`);
  const citing = page.getByTestId('citing-records');
  await expect(citing.locator('li')).toHaveCount(2);
  await expect(rowFor(citing, intentId)).toContainText(intentTitle);
  await expect(rowFor(citing, intentId).locator('.tag.kind')).toHaveText('decision');
  await expect(statusTag(rowFor(citing, intentId))).toHaveText('decided');
  await expect(rowFor(citing, observedId)).toContainText(observedTitle);
  await expect(rowFor(citing, observedId).locator('.tag.kind')).toHaveText('fact');
  await expect(statusTag(rowFor(citing, observedId))).toHaveText('observed');

  // Current decisions: the design is decided and was never observed; the observed fact is not a decision.
  await page.goto('/decisions');
  const decision = page.getByTestId('decision').filter({ has: page.locator(`h2 a[href="/records/${intentId}"]`) });
  await expect(decision).toHaveCount(1);
  await expect(statusTag(decision)).toHaveText('decided');
  await expect(decision.getByTestId('staleness')).toHaveText('unknown');
  await expect(decision).toContainText('never observed');
  await expect(page.locator(`[data-testid="decision"] h2 a[href="/records/${observedId}"]`)).toHaveCount(0);
});

// ----- price-conflict -----------------------------------------------------------------------------

test('price conflict: both prices stay visible with their sources, and which one was approved, by whom', async ({ page }) => {
  test.setTimeout(SLOW_START_TIMEOUT_MS);
  const sourceTitle = `Widget price records ${runId}`;
  const emailTitle = `Supplier e-mail: Type-B widget costs EUR 12.40 (${runId})`;
  const catalogueTitle = `Catalogue page: Type-B widget costs EUR 11.90 (${runId})`;
  const decisionTitle = `Use EUR 12.40 per Type-B widget for Q3 (${runId})`;
  const jonas = `Jonas, head of purchasing ${runId}`;
  const sourceId = await addSource(page, sourceTitle, fixture('price-conflict', 'prices'));

  // Price one: the dated supplier e-mail. Confirmed.
  const emailId = await createCandidate(page, sourceId, {
    needle: PRICE_EMAIL, title: emailTitle, kind: 'fact', statedBy: `Harbor Supply orders desk ${runId}`, effective: { at: '2026-07-08T00:00' },
  });
  await expect(page.getByTestId('time-effective')).toContainText('2026-07-08 00:00 UTC');
  await confirmHere(page);

  // Price two: the catalogue page without a date. The missing date is explicit, and the record stays a candidate.
  const catalogueId = await createCandidate(page, sourceId, { needle: PRICE_CATALOGUE, title: catalogueTitle, kind: 'fact', effective: 'unknown' });
  await expect(page.getByTestId('time-effective').locator('.tag.warn')).toHaveText('unknown');
  await expect(page.getByTestId('approval-summary')).toContainText('Not approved');

  // The memo that settles it: stated by Jonas, approved by the workspace owner. Attribution is not approval.
  const decisionId = await createCandidate(page, sourceId, {
    needle: PRICE_MEMO, title: decisionTitle, kind: 'decision', status: 'decided', statedBy: jonas, effective: { at: '2026-07-15T00:00' },
  });
  await expect(page.getByTestId('approval-summary')).toContainText('Not approved');
  await confirmHere(page);
  await expect(page.getByTestId('approval-summary')).toContainText('replacing nothing');
  await expect(page.getByTestId('approval-summary')).not.toContainText('Jonas');
  await expect(page.getByTestId('attribution-block')).toContainText(jonas);
  await expect(page.getByTestId('attribution-block')).toContainText('third party');
  await expect(statusTag(page)).toHaveText('decided');
  await expect(page.getByTestId('time-effective')).toContainText('2026-07-15 00:00 UTC');

  // Each price opens its own span of the source.
  for (const [id, needle] of [[emailId, PRICE_EMAIL], [catalogueId, PRICE_CATALOGUE]] as const) {
    await page.goto(`/records/${id}`);
    await expect(page.getByTestId('evidence-list').locator('blockquote')).toHaveText(needle);
    await expect(page.getByTestId('evidence-link')).toContainText(sourceTitle);
    await page.getByTestId('evidence-link').click();
    await page.waitForURL(new RegExp(`/sources/${sourceId}\\?.*start=\\d+&end=\\d+`));
    await expect(page.locator('mark#span')).toHaveText(needle);
  }

  // The source lists all three: both prices (one confirmed, one still a candidate) and the decision.
  await page.goto(`/sources/${sourceId}`);
  const citing = page.getByTestId('citing-records');
  await expect(citing.locator('li')).toHaveCount(3);
  await expect(rowFor(citing, emailId)).toContainText('EUR 12.40');
  await expect(rowFor(citing, emailId).getByTestId('review-state')).toHaveText('confirmed');
  await expect(rowFor(citing, catalogueId)).toContainText('EUR 11.90');
  await expect(rowFor(citing, catalogueId).getByTestId('review-state')).toHaveText('candidate');
  await expect(rowFor(citing, catalogueId).getByTestId('attribution')).toContainText('said by unknown');
  await expect(rowFor(citing, decisionId).getByTestId('review-state')).toHaveText('confirmed');
  await expect(rowFor(citing, decisionId).getByTestId('attribution')).toContainText(`said by ${jonas}`);

  // The records list keeps the unapproved price next to the approved one.
  await page.goto('/records?kind=fact');
  const list = page.getByTestId('records-list');
  await expect(rowFor(list, emailId).getByTestId('review-state')).toHaveText('confirmed');
  await expect(rowFor(list, catalogueId).getByTestId('review-state')).toHaveText('candidate');
  await expect(rowFor(list, decisionId)).toHaveCount(0);

  // Current decisions: the approved price, who approved it, and its evidence in the memo. The prices are facts.
  await page.goto('/decisions');
  const decision = page.getByTestId('decision').filter({ has: page.locator(`h2 a[href="/records/${decisionId}"]`) });
  await expect(decision).toHaveCount(1);
  await expect(decision).toContainText(/Approved by .+ \(owner\)/);
  await expect(decision).toContainText('Replaced nothing.');
  for (const id of [emailId, catalogueId]) await expect(page.locator(`[data-testid="decision"] h2 a[href="/records/${id}"]`)).toHaveCount(0);
  await decision.getByRole('link', { name: /Primary evidence/ }).click();
  await page.waitForURL(new RegExp(`/sources/${sourceId}\\?.*start=\\d+&end=\\d+`));
  await expect(page.locator('mark#span')).toHaveText(PRICE_MEMO);
});

// ----- step 8: backup and restore -----------------------------------------------------------------

type Row = Record<string, unknown>;
type BackupFile = {
  format: string; formatVersion: number; workspace: { id: string };
  actors: Row[]; sources: Row[]; revisions: Row[]; tombstones: Row[]; records: Row[]; versions: Row[]; evidence: Row[]; approvals: Row[];
  auditEvents: Row[];
};

type Seed = { sourceId: string; sourceTitle: string; content: string; recordId: string; recordTitle: string };

/** A source with one confirmed decision whose status was set on the record page: something worth backing up. */
async function seedWorkspace(page: Page, tag: string): Promise<Seed> {
  const sourceTitle = `Rate limit note for ${tag} ${runId}`;
  const recordTitle = `Partner tokens: 100 requests per minute (${tag} ${runId})`;
  const content = fixture('intent-vs-observed', tag);
  const sourceId = await addSource(page, sourceTitle, content);
  const recordId = await createCandidate(page, sourceId, { needle: LIMIT_DESIGN, title: recordTitle, kind: 'decision', effective: { at: '2026-04-10T00:00' } });
  await confirmHere(page);
  await setStatus(page, `/records/${recordId}`, 'decided', `set before the ${tag}`);
  return { sourceId, sourceTitle, content, recordId, recordTitle };
}

/** Downloads a backup through the Backup page of the install at `base` ('' is the install under test). */
async function downloadBackup(page: Page, testInfo: TestInfo, base = ''): Promise<{ path: string; doc: BackupFile }> {
  await page.goto(`${base}/backup`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-backup').click()]);
  expect(download.suggestedFilename()).toMatch(/^poii-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  return { path, doc: JSON.parse(readFileSync(path, 'utf8')) as BackupFile };
}

/** The backup holds the seeded source (with its original bytes) and the record with its history and approval. */
function expectBackupHolds(doc: BackupFile, seed: Seed) {
  expect(doc.format).toBe('poii.backup');
  expect(doc.formatVersion).toBe(1);
  expect(doc.sources.find(s => s.id === seed.sourceId)).toMatchObject({ title: seed.sourceTitle, kind: 'paste', workspaceId: doc.workspace.id });
  const revision = doc.revisions.find(r => r.sourceId === seed.sourceId);
  expect(revision).toMatchObject({ revisionNo: 1, contentText: seed.content });
  expect(Buffer.from(String(revision?.originalBase64), 'base64').toString('utf8')).toBe(seed.content);
  expect(doc.records.find(r => r.id === seed.recordId)).toMatchObject({
    title: seed.recordTitle, kind: 'decision', reviewState: 'confirmed', lifecycleStatus: 'decided', versionNo: 3,
  });
  expect(doc.versions.filter(v => v.recordId === seed.recordId).map(v => v.changeKind).sort()).toEqual(['confirm', 'create', 'status']);
  expect(doc.approvals.filter(a => a.recordId === seed.recordId)).toHaveLength(1);
  const evidence = doc.evidence.filter(e => e.recordId === seed.recordId);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ sourceId: seed.sourceId, revisionId: revision?.id });
}

test('backup downloads as one JSON file holding the workspace; restore refuses a workspace that has data', async ({ page }, testInfo) => {
  test.setTimeout(SLOW_START_TIMEOUT_MS);
  const seed = await seedWorkspace(page, 'backup');
  const { path, doc } = await downloadBackup(page, testInfo);
  expectBackupHolds(doc, seed);

  // A file that is not JSON is refused in plain words.
  const restoreForm = page.getByTestId('restore-form');
  await page.locator('#restore-file').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not a backup') });
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(restoreForm.getByTestId('problem')).toHaveAttribute('data-code', 'invalid_input');
  await expect(restoreForm.getByTestId('problem')).toContainText('not valid JSON');

  // The real backup is refused here, because this workspace holds data. Nothing changes.
  await page.locator('#restore-file').setInputFiles(path);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(restoreForm.getByTestId('problem')).toHaveAttribute('data-code', 'workspace_not_empty');
  await expect(restoreForm.getByTestId('problem')).toContainText('Restore only works into an empty workspace');
  await expect(restoreForm.getByTestId('action-message')).toHaveCount(0);
  await page.goto(`/records/${seed.recordId}`);
  await expect(page.getByTestId('record-title')).toHaveText(seed.recordTitle);
  await expect(historyKinds(page)).toHaveText(['status', 'confirm', 'create']);
});

// A clean install for the restore: an empty, migrated database next to the one under test, with its own API and
// web server (the same builds the Playwright config starts) on free ports and its own storage directory.
type CleanInstall = { webUrl: string; stop: () => Promise<void> };
type PgClient = { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> };
let cleanInstall: CleanInstall | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

/** Starts a child without a shell and keeps the end of its output for the error message if it does not come up. */
function start(args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; tail: () => string } {
  const child = spawn(process.execPath, args, { cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => (output = `${output}${String(chunk)}`.slice(-2000)));
  return { child, tail: () => output };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  // Both servers leave on SIGTERM; do not wait for ever on one that does not.
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(killer);
}

/** Child output goes into error messages (and from there into the report): never with a connection string. */
const masked = (text: string) => text.replace(/postgres(ql)?:\/\/\S+/g, 'postgres://***');

async function waitUntilUp(url: string, tail: () => string) {
  try {
    await expect.poll(() => fetch(url).then(response => response.status, () => 0), { timeout: 60_000 }).toBe(200);
  } catch {
    throw new Error(`${url} did not come up. Last output: ${masked(tail())}`);
  }
}

async function startCleanInstall(databaseUrl: string): Promise<CleanInstall> {
  // pg is the API's dependency, not the web app's: load it from there instead of adding a dependency for one test.
  const pg = createRequire(join(apiDir, 'package.json'))('pg') as { Client: new (config: { connectionString: string }) => PgClient };
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  const name = `poii_restore_${runId}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  const storageDir = mkdtempSync(join(tmpdir(), 'poii-restore-storage-'));
  const children: ChildProcess[] = [];
  const stop = async () => {
    try {
      for (const child of children.reverse()) await stopChild(child);
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  };
  try {
    await admin(`CREATE DATABASE ${name}`);
    const [apiPort, webPort] = [await freePort(), await freePort()];
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const webUrl = `http://127.0.0.1:${webPort}`;
    const env = { ...process.env, DATABASE_URL: target.toString(), POII_STORAGE_LOCAL_DIR: storageDir };
    const migrated = spawnSync(process.execPath, [join(apiDir, 'dist', 'migrate.js')], { cwd: webDir, env, encoding: 'utf8' });
    if (migrated.status !== 0) throw new Error(`migrating the clean install failed: ${masked(String(migrated.stderr).slice(-1000))}`);
    const api = start([join(apiDir, 'dist', 'main.js')], { ...env, PORT: String(apiPort), GIT_SHA: 'smoke-restore' });
    children.push(api.child);
    await waitUntilUp(`${apiUrl}/health/ready`, api.tail);
    const web = start(
      [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)],
      { ...env, PORT: String(webPort), HOSTNAME: '127.0.0.1', API_INTERNAL_URL: apiUrl },
    );
    children.push(web.child);
    await waitUntilUp(webUrl, web.tail);
    return { webUrl, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

test.afterAll(async () => {
  await cleanInstall?.stop();
  cleanInstall = undefined;
});

/** What a record page shows, whitespace-normalised: tags, attribution, approval, times, evidence, full history. */
async function recordPageFacts(page: Page, url: string): Promise<Record<string, string>> {
  await page.goto(url);
  const text = async (locator: Locator) => ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: await text(page.getByTestId('record-title')),
    tags: await text(page.locator('h1 + p.tags')),
    attribution: await text(page.getByTestId('attribution-block')),
    approval: await text(page.getByTestId('approval-block')),
    effective: await text(page.getByTestId('time-effective')),
    observed: await text(page.getByTestId('time-observed')),
    evidence: await text(page.getByTestId('evidence-list')),
    supersession: await text(page.getByTestId('supersession')),
    history: await text(page.getByTestId('versions')),
  };
}

test('restore into a clean install reproduces the source, the record, its approval and its history', async ({ page }, testInfo) => {
  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, 'needs DATABASE_URL (as the API under test does) to create the empty database of the clean install');
  test.setTimeout(240_000);
  const seed = await seedWorkspace(page, 'restore');
  const before = await recordPageFacts(page, `/records/${seed.recordId}`);
  expect(before.history).toContain('snapshot');
  const { path, doc } = await downloadBackup(page, testInfo);
  expectBackupHolds(doc, seed);

  cleanInstall = await startCleanInstall(databaseUrl!);
  const clean = cleanInstall.webUrl;

  // The clean install is up and empty.
  await page.goto(`${clean}/`);
  await expect(page.getByTestId('api-status')).toContainText('ready');
  await page.goto(`${clean}/sources`);
  await expect(page.getByText('No sources here yet.')).toBeVisible();
  await page.goto(`${clean}/records/${seed.recordId}`);
  await expect(page.getByText('This record does not exist or was deleted.')).toBeVisible();

  // Restore through the Backup page; the result names the workspace and counts what the file holds.
  await page.goto(`${clean}/backup`);
  const restoreForm = page.getByTestId('restore-form');
  await page.locator('#restore-file').setInputFiles(path);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  const message = restoreForm.getByTestId('action-message');
  await expect(message).toContainText(`Restore finished into workspace ${doc.workspace.id}`, { timeout: 60_000 });
  await expect(restoreForm.getByTestId('problem')).toHaveCount(0);
  for (const [key, rows] of [['sources', doc.sources], ['revisions', doc.revisions], ['records', doc.records], ['approvals', doc.approvals], ['versions', doc.versions]] as const) {
    await expect(message).toContainText(new RegExp(`\\b${rows.length} ${key}\\b`));
  }

  // The record is the same record: identical page, with its approval and every version's snapshot.
  expect(await recordPageFacts(page, `${clean}/records/${seed.recordId}`)).toEqual(before);
  await expect(statusTag(page)).toHaveText('decided');
  await expect(page.getByTestId('approval-summary')).toContainText(/Approved by .+ with authority owner/);
  await expect(historyKinds(page)).toHaveText(['status', 'confirm', 'create']);
  // Its evidence opens the restored original at the exact span.
  await page.getByTestId('evidence-link').click();
  await page.waitForURL(new RegExp(`/sources/${seed.sourceId}\\?.*start=\\d+&end=\\d+`));
  expect(page.url().startsWith(clean)).toBeTruthy();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(seed.sourceTitle);
  await expect(page.locator('mark#span')).toHaveText(LIMIT_DESIGN);
  await expect(page.locator('#source-text')).toHaveAttribute('data-length', String(seed.content.length));
  await expect(page.locator('#source-text')).toContainText(`Journey run ${runId} (restore).`);
  // The derived views work on the restored data: current decisions and search.
  await page.goto(`${clean}/decisions`);
  await expect(page.locator(`[data-testid="decision"] h2 a[href="/records/${seed.recordId}"]`)).toHaveText(seed.recordTitle);
  await page.goto(`${clean}/search?q=gateway`);
  await expect(page.getByTestId('source-hit').filter({ hasText: seed.sourceTitle })).toHaveCount(1);

  // Restoring the same backup again changes nothing.
  await page.goto(`${clean}/backup`);
  await page.locator('#restore-file').setInputFiles(path);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(message).toContainText(`Restore finished into workspace ${doc.workspace.id}`, { timeout: 60_000 });
  for (const key of ['sources', 'revisions', 'records', 'approvals', 'versions']) await expect(message).toContainText(new RegExp(`\\b0 ${key}\\b`));
  expect(await recordPageFacts(page, `${clean}/records/${seed.recordId}`)).toEqual(before);

  // The restored install keeps working: its owner can change the record, and its own backup has the record too.
  await setStatus(page, `${clean}/records/${seed.recordId}`, 'implemented', 'after the restore');
  await expect(historyKinds(page)).toHaveText(['status', 'status', 'confirm', 'create']);
  const again = await downloadBackup(page, testInfo, clean);
  expect(again.doc.workspace.id).toBe(doc.workspace.id);
  expect(again.doc.records.find(r => r.id === seed.recordId)).toMatchObject({ title: seed.recordTitle, lifecycleStatus: 'implemented', versionNo: 4 });
});
