import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { TASK_TRACKER_SCENARIO } from '../lib/api/mock/task-push';
import { login, openRoadmapItem, signOut } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * task-push (#1816): a task under a roadmap item goes to the connected tracker, driven through
 * the Simple roadmap's feature panel on the mock (invented alert features).
 *
 * Card task-push: protects = with a tracker connected ("task-tracker" scenario) a task linked to
 * its record links to it from its row; a task added while the tracker refuses the push is saved
 * and shows the refusal on its row behind an (i), with Retry, which asks the tracker again; a
 * viewer sees the link but no Retry; with no tracker connected nothing shows; fails_when = the
 * row has no tracker link, the failure is silent, or there is no Retry; no_claim = a real tracker.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId('floating-card');
const toasts = (page: Page) => page.getByTestId('toasts');
const task = (page: Page, title: string) =>
  panel(page).getByTestId('card-task').filter({ hasText: title });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-export');
  await expect(panel(page)).toBeVisible();
}

async function addTask(page: Page, title: string) {
  await tap(panel(page).getByRole('button', { name: '+ Add a task' }));
  await panel(page).getByLabel('New task').fill(title);
  await tap(panel(page).getByRole('button', { name: 'Add', exact: true }));
  await expect(toasts(page)).toContainText(`Added the task “${title}”`);
}

const tracked = (page: Page) =>
  page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      TASK_TRACKER_SCENARIO,
    ] as const);

test('a task links to its tracker record; a refused push shows on the task with Retry', async ({
  page,
}) => {
  await tracked(page);
  await open(page);
  const link = task(page, 'Write the setup guide').getByTestId('task-tracker-link');
  await expect(link).toHaveText('ENG-12 ↗');
  await expect(link).toHaveAttribute('href', 'https://tracker.example.com/ENG-12');
  await expect(task(page, 'Write the setup guide').getByTestId('task-tracker-error')).toHaveCount(
    0,
  );

  await addTask(page, 'Draft the export help page');
  const row = task(page, 'Draft the export help page');
  const failed = row.getByTestId('task-tracker-error');
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('no tracker connector has been verified');
  const retry = failed.getByRole('button', { name: 'Retry' });
  const asked = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/v1\/simple\/tasks\/[^/]+\/tracker-push$/.test(r.url()),
  );
  await tap(retry);
  await asked;
  // Still refused: the task stays saved and the failure stays on it.
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeEnabled();
  await expect(row).toContainText('No owner · No due date');
});

test('a viewer sees the tracker link but no Retry', async ({ page }) => {
  await tracked(page);
  await open(page);
  await addTask(page, 'Draft the export help page');
  await expect(
    task(page, 'Draft the export help page').getByTestId('task-tracker-error'),
  ).toBeVisible();
  await page.goto('/home');
  await signOut(page);
  await open(page, 'viewer@example.com');
  await expect(task(page, 'Write the setup guide').getByTestId('task-tracker-link')).toBeVisible();
  const row = task(page, 'Draft the export help page');
  await expect(row.getByTestId('task-tracker-error')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('with no tracker connected a task shows no tracker mark', async ({ page }) => {
  await open(page);
  await addTask(page, 'Draft the export help page');
  const row = task(page, 'Draft the export help page');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('task-tracker-error')).toHaveCount(0);
  await expect(panel(page).getByTestId('task-tracker-link')).toHaveCount(0);
});
