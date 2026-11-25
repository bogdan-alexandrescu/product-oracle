import { GROUND_TRUTH_PROPOSED_SCENARIO } from '../lib/api/mock/ground-truth';
import { MOCK_SCENARIO_KEY, UNIQUE_CODES_SCENARIO } from '../lib/api/mock/server';

import { login, openRoadmapItem } from './helpers';
import { expect, test, type Page } from './test';

/*
 * panel-stages (#1815, #1879), driven through the feature panel against the mock (invented data).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const panel = (page: Page) => page.getByTestId('floating-card');
const toasts = (page: Page) => page.getByTestId('toasts');
const statusPick = (page: Page) => panel(page).getByTestId('card-status-edit').getByLabel('Status');

async function changeStatus(page: Page) {
  await panel(page).getByRole('button', { name: 'Change the status' }).click();
}

test('a slice code is set as typed and the panel shows it at once', async ({ page }) => {
  // protects=the Code field takes f-29A and the panel reads F-29a right after Save; a malformed
  // code says why in plain words; fails_when=the letter is refused or the old code still shows;
  // no_claim=the rename rule (pytest).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    UNIQUE_CODES_SCENARIO,
  ] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await openRoadmapItem(page, 'setup-import');
  await panel(page).getByRole('button', { name: 'Change the code' }).click();
  await panel(page).getByLabel('Code').fill('F29');
  await panel(page).getByTestId('card-code-edit').getByRole('button', { name: 'Save' }).click();
  await expect(toasts(page)).toContainText('A code looks like F-31 or F-31a');
  await panel(page).getByRole('button', { name: 'Change the code' }).click();
  await panel(page).getByLabel('Code').fill('f-29A');
  await panel(page).getByTestId('card-code-edit').getByRole('button', { name: 'Save' }).click();
  await expect(panel(page).getByTestId('card-code-text')).toHaveText('F-29a', { timeout: 1500 });
});

for (const width of [390, 768, 1440]) {
  test(`the Code row keeps its code whole and its mark and confirm in view at ${width}`, async ({
    page,
  }) => {
    // protects=a code beside the Not in the Ground Truth mark never wraps one character per line,
    // and Confirm into the Ground Truth stays inside the panel; fails_when=F / - / 7 / 7 stack or
    // the action is cut off; no_claim=the confirm itself (gt-proposed-confirm.spec.ts).
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
      MOCK_SCENARIO_KEY,
      GROUND_TRUTH_PROPOSED_SCENARIO,
    ] as const);
    await login(page);
    await page.goto('/simple/goals');
    const chip = page.getByTestId('gm-chip').filter({ hasText: 'IP proxies' });
    await chip.getByRole('button').first().click();
    const code = page.getByTestId('card-code-text');
    await expect(code).toHaveText('F-77');
    const box = (await code.boundingBox())!;
    const line = await code.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 24);
    expect(box.height).toBeLessThan(line * 1.5);
    const confirm = page.getByTestId('card-code-confirm');
    await expect(confirm).toBeVisible();
    const c = (await confirm.boundingBox())!;
    const card = (await page.getByTestId('panel-fields').boundingBox())!;
    expect(c.x + c.width).toBeLessThanOrEqual(card.x + card.width + 1);
    expect(c.x).toBeGreaterThanOrEqual(card.x - 1);
  });
}

test('a feature moves back to Draft with a reason, is planned again with its dates, and Done reopens', async ({
  page,
}) => {
  // protects=the Status picker offers Draft, Planned and Done; a move back asks why before it
  // applies; Planned again keeps the dates; Done moves back to Planned; fails_when=Draft is not
  // offered, a move back applies with no reason, or the dates are lost; no_claim=history words
  // (pytest).
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-export');
  const dates = await panel(page).getByTestId('card-dates').textContent();
  await changeStatus(page);
  await expect(statusPick(page).locator('option')).toHaveText(['Draft', 'Planned', 'Done']);
  await statusPick(page).selectOption('draft');
  const save = panel(page).getByTestId('card-status-edit').getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await panel(page).getByLabel('Why it moves back').fill('Planned too early');
  await save.click();
  await expect(panel(page).getByTestId('card-status')).toHaveText('Draft');

  await changeStatus(page);
  await statusPick(page).selectOption('planned');
  await expect(panel(page).getByTestId('card-status')).toHaveText('Planned');
  await expect(panel(page).getByTestId('card-dates')).toHaveText(dates ?? '');

  await changeStatus(page);
  await statusPick(page).selectOption('done');
  await expect(panel(page).getByTestId('card-status')).toHaveText('Done');
  await changeStatus(page);
  await statusPick(page).selectOption('planned');
  await panel(page).getByLabel('Why it moves back').fill('Not live yet');
  await panel(page).getByTestId('card-status-edit').getByRole('button', { name: 'Save' }).click();
  await expect(panel(page).getByTestId('card-status')).toHaveText('Planned');
});
