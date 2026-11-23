import { GROUND_TRUTH_PROPOSED_SCENARIO } from '../lib/api/mock/ground-truth';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * gt-proposed: in the Ground Truth, one rule (the owner, Nov 23: every roadmap feature joins the
 * Ground Truth with the next F-code, from the UI). The "ground-truth-proposed" scenario (invented
 * data): Account discovery, a roadmap item on a feature a run only proposed, with no code. The Goal
 * map flags its chip Not in the Ground Truth, and the Ground Truth check lists it under Not in the
 * Ground Truth with Confirm it; its panel's Confirm into the Ground Truth confirms it with the next
 * F-code, and the chip shows that code and the check has one flag fewer.
 *
 * Test card: protects=a proposed roadmap feature is counted by the check and can be confirmed from
 * Simple's feature panel or the check; fails_when=the check leaves it out, or the panel offers only
 * a free-text Code; no_claim=the Ground Truth page's own feature panel (feature-code-on-join).
 */

const NAME = 'Account discovery';

async function open(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    MOCK_SCENARIO_KEY,
    GROUND_TRUTH_PROPOSED_SCENARIO,
  ] as const);
  await login(page);
}

const count = (page: Page) => page.getByTestId('gt-count-unlinked_item');
const row = (page: Page) =>
  page.getByTestId('gt-list-unlinked_item').getByTestId('gt-row').filter({ hasText: NAME });

async function flagged(page: Page): Promise<number> {
  await page.goto('/baseline');
  await expect(page.getByTestId('gt-band')).toBeVisible();
  return Number(await count(page).locator('span').last().innerText());
}

const chip = (page: Page) => page.getByTestId('gm-chip').filter({ hasText: NAME });

test('Confirm into the Ground Truth from the Goal map gives the chip its F-code', async ({
  page,
}) => {
  await open(page);
  const before = await flagged(page);
  await count(page).click();
  await expect(row(page).getByRole('button', { name: /Confirm it/ })).toBeVisible();

  await page.goto('/simple/goals');
  await expect(chip(page)).toContainText('Not in the Ground Truth');
  await chip(page).getByRole('button').first().click();
  await page.getByTestId('card-code-confirm').click();
  await expect(chip(page)).not.toContainText('Not in the Ground Truth');
  await expect(chip(page).getByTestId('gm-chip-name')).toHaveText(
    new RegExp(`^F-\\d+\\s*${NAME}$`),
  );

  expect(await flagged(page)).toBe(before - 1);
  await count(page).click();
  await expect(row(page)).toHaveCount(0);
});

test("The check's Confirm it gives the proposed feature the next F-code", async ({ page }) => {
  await open(page);
  const before = await flagged(page);
  await count(page).click();
  await row(page)
    .getByRole('button', { name: /Confirm it/ })
    .click();
  await expect(page.getByTestId('gt-notice')).toContainText(
    new RegExp(`Confirmed “${NAME}” as F-\\d+\\.`),
  );
  await expect(row(page)).toHaveCount(0);
  await expect(count(page).locator('span').last()).toHaveText(String(before - 1));
});
