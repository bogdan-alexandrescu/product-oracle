import { expect, test, type Page } from './test';

import { login } from './helpers';

/*
 * #1588: "today" is the Company's day (America/Los_Angeles in the mock), not UTC's. At
 * 8 PM PDT on Oct 22 it is already Oct 23 in UTC; a date a person is offered as today
 * reads Oct 22.
 *
 * protects=the day a form fills in for today; fails_when=it is UTC's day, a day ahead in
 * the evening; no_claim=the day the API stores (the person's pick is sent as picked).
 */

const EVENING = '2026-10-23T03:00:00Z'; // Oct 22, 8:00 PM PDT

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem('po-mock-scenario', 'launches'));
  await page.clock.setSystemTime(new Date(EVENING));
  await login(page);
}

test("a new changelog entry's Released on is the Company's today in the evening", async ({
  page,
}) => {
  await start(page);
  await page.goto('/plan/documents');
  await page.getByTestId('roadmap-changelog-link').click();
  await expect(page).toHaveURL(/\/roadmap\/changelog$/);
  await page.getByRole('button', { name: 'New entry' }).first().click();
  await expect(page.getByRole('dialog').getByLabel('Released on')).toHaveValue('2026-10-22');
});

test("a launch note's Mark sent day is the Company's today in the evening", async ({ page }) => {
  await start(page);
  await page.goto('/plan/documents');
  await page.getByTestId('roadmap-launches-link').click();
  await expect(page.getByTestId('launches-table')).toBeVisible();
  await page.getByTestId('launch-row').filter({ hasText: 'Hard budget caps' }).click();
  const inspector = page.getByTestId('launch-inspector').filter({ visible: true });
  await inspector.getByTestId('mark-launched').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Mark launched' }).click();
  const note = inspector.getByTestId('launch-note').filter({ hasText: 'Pilot customer contact' });
  await note.getByRole('button', { name: 'Mark sent' }).click();
  await expect(note.getByTestId('mark-sent-form').getByLabel('On')).toHaveValue('2026-10-22');
});
