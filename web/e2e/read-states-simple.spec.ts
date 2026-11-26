import { MOCK_SCENARIO_KEY, ONE_PAGER_PLAN_LOOSE_SCENARIO } from '../lib/api/mock/server';
import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * #1586 on Simple's one-pager and rail: a read that failed says so (Could not load ..., its reason
 * behind an (i)), never reads as "none": no plan, no marks, no code (Not in the Ground Truth), no
 * status, no day, or a Roadmap count without the part it could not read. Each case is checked both
 * ways: answered, then failed. Against the mock's invented PRDs (Guided setup, Team invites PRD,
 * Usage alerts).
 *
 * Card: protects=a Simple one-pager and its rail say when a read failed (Could not load, the
 * reason behind an (i)) and not that there is none, while an answered read shows its plan,
 * marks, code, status and day; fails_when=a failed read shows no plan, no marks, Not in the
 * Ground Truth, no status or a short count as if it were fine; no_claim=how the real API fails.
 */

const DESKTOP = { width: 1440, height: 900 };

const scenario = (page: Page, s: string) =>
  page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, s] as const);

const failGets = (page: Page, path: string) =>
  page.evaluate((p) => localStorage.setItem('po-mock-fail', p), path);

const loadError = (page: Page, text: string) =>
  page.getByTestId('load-error').filter({ hasText: text });

test.use({ viewport: DESKTOP });

test('Simple one-pager: a plan that could not be read says so, never no plan', async ({ page }) => {
  await scenario(page, 'simple-plan');
  await login(page);
  await page.goto('/simple/one-pagers/guided-setup');
  await expect(page.getByTestId('milestone-part')).toBeVisible();
  await expect(page.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/simple/prds/guided-setup/plan');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Guided setup' })).toBeVisible();
  const failed = loadError(page, 'Could not load the plan.');
  await expect(failed).toBeVisible();
  await failed.getByRole('button', { name: 'About the error' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Mock failure');
  await expect(page.getByTestId('milestone-part')).toHaveCount(0);
});

test("Simple one-pager: the features' marks that could not be read say so, never no marks", async ({
  page,
}) => {
  await scenario(page, 'simple-plan');
  await login(page);
  await page.goto('/simple/one-pagers/guided-setup');
  const builds = page.getByTestId('milestone-part').getByTestId('part-builds');
  await expect(builds.getByRole('listitem').first().getByTestId('cs-mark')).toBeVisible();
  await expect(page.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/simple/roadmap?prd=guided-setup');
  await page.reload();
  await expect(loadError(page, "Could not load the features' marks.")).toBeVisible();
  await expect(builds).toContainText('What we build');
  await expect(builds.getByTestId('cs-mark')).toHaveCount(0);
});

test('Simple one-pager: codes that could not be read say so, never Not in the Ground Truth', async ({
  page,
}) => {
  await scenario(page, ONE_PAGER_PLAN_LOOSE_SCENARIO);
  await login(page);
  await page.goto('/simple/one-pagers/guided-setup');
  const rows = page
    .getByRole('region', { name: 'Timeline' })
    .getByTestId('timeline-no-milestone-item');
  await expect(rows.getByRole('button', { name: 'Calendar invite sync' })).toBeVisible();
  await expect(rows.getByTestId('not-in-gt')).toHaveText('Not in the Ground Truth');
  await expect(loadError(page, "Could not load the features' codes.")).toHaveCount(0);

  await failGets(page, '/v1/simple/roadmap');
  await page.reload();
  await expect(loadError(page, "Could not load the features' codes.")).toBeVisible();
  await expect(rows.getByRole('button', { name: 'Calendar invite sync' })).toBeVisible();
  await expect(rows.getByTestId('not-in-gt')).toHaveCount(0);
});

test('Simple one-pager: a status that could not be read says so, never no status', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/one-pagers');
  await page
    .getByTestId('one-pager-row')
    .filter({ hasText: 'Team invites PRD' })
    .getByRole('link', { name: 'Team invites PRD' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team invites PRD' })).toBeVisible();
  await expect(page.getByTestId('one-pager-status')).toHaveText('In review');
  await expect(loadError(page, "Could not load the PRD's status.")).toHaveCount(0);
  const slug = new URL(page.url()).pathname.split('/').at(-1)!;

  await failGets(page, `/v1/documents/${slug}`);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Team invites PRD' })).toBeVisible();
  const failed = loadError(page, "Could not load the PRD's status.");
  await expect(failed).toBeVisible();
  await failed.getByRole('button', { name: 'About the error' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Mock failure');
  await expect(page.getByTestId('one-pager-status')).toHaveCount(0);
});

test('Simple one-pager: the day of the version under review that could not be read says so', async ({
  page,
}) => {
  await scenario(page, 'run-review');
  await login(page);
  await page.goto('/simple/one-pagers');
  await page.getByRole('link', { name: 'Usage alerts PRD' }).first().click();
  const meta = page.getByTestId('one-pager-meta');
  await expect(page.getByRole('region', { name: "The run's PRD review" })).toContainText(
    'waits for your review of version 2.',
  );
  await expect(meta).toContainText(/Version 2 · [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(loadError(page, "Could not load the version's day.")).toHaveCount(0);
  const slug = new URL(page.url()).pathname.split('/').at(-1)!;

  await failGets(page, `/v1/documents/${slug}/versions/2`);
  await page.reload();
  await expect(loadError(page, "Could not load the version's day.")).toBeVisible();
  await expect(meta).toContainText('Version 2');
  await expect(meta).not.toContainText(/Version 2 · [A-Z][a-z]{2} \d{1,2}, \d{4}/);
});

test('the rail: a Roadmap count whose light count could not be read says a part could not load', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/one-pagers');
  const roadmap = page.getByTestId('simple-nav-roadmap-count');
  await expect(roadmap).toHaveAttribute('title', /on the roadmap waiting on you/, {
    timeout: 15_000,
  });
  await expect(roadmap).not.toHaveAttribute('title', /could not load/i);

  await failGets(page, '/v1/simple/roadmap/waiting');
  await page.reload();
  await expect(roadmap).toHaveAttribute('title', /(; a part could not load|^Could not load)$/, {
    timeout: 15_000,
  });
  await expect(roadmap).toHaveAttribute('aria-label', /(; a part could not load|^Could not load)$/);
});
