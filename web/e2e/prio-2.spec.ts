import { COMPANY_TITLE, OLD_ITEM } from '../lib/api/mock/one-roadmap';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import {
  PRIORITIES_ONE_FEATURE_SCENARIO,
  PRIORITIES_PLAN_GOAL_OUTSIDE_SCENARIO,
} from '../lib/api/mock/simple-priorities';

import { login } from './helpers';
import { expect, test } from './test';
import { dateIntoThisQuarter } from './this-quarter';

import type { Page } from '@playwright/test';

/**
 * prio-2 (#1739, #1895, #1898, #1910, #1911): Simple Priorities as the Nov 25 re-audit read it, as the owner in a
 * 1512 × 756 window, on invented data. Split at a dated line, each part is numbered from 1; the rows that miss the
 * line with no goal and no effort fold under one "Needs triage"; the All chip is the sum of the parts; a row not on
 * the company roadmap carries a small tag and the list says what a move does once; a goal card on Goal buckets
 * leads to its work this quarter outside the plan.
 */

test.use({ viewport: { width: 1512, height: 756 } });

async function open(page: Page, scenario: string, query = '') {
  await page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId('prio-row').first()).toBeVisible();
}

const numbers = async (page: Page, above: boolean): Promise<number[]> =>
  (
    await page
      .locator(`[data-testid="prio-row"][data-above="${above}"] [data-testid="prio-rank"]`)
      .allInnerTexts()
  ).map(Number);
const oneToN = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test('#1898 #1910 #1895 #1739 each part reads 1, 2, 3…, triage folds inside Misses, All is the sum of the parts', async ({
  page,
}) => {
  await open(page, 'simple-plan');
  const heads = page.getByTestId('prio-part-head');
  await expect(heads).toHaveCount(2);
  await expect(heads.nth(1)).toContainText(/^Misses this quarter/);
  const partCount = async (i: number) =>
    Number((await page.getByTestId('prio-part-count').nth(i).innerText()).split(' ')[0]);
  const makes = await partCount(0);
  // Misses counts every row below the line, its folded Needs triage group too.
  const misses = await partCount(1);
  // Needs triage: the rows that miss the line with no goal and no effort, folded, with their count.
  const triage = page.getByTestId('prio-triage-head');
  await expect(triage).toHaveText(/Needs triage\s*1 feature/);
  const toggle = triage.getByRole('button', { name: /^. Needs triage$/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('prio-row')).toHaveCount(makes + misses - 1);
  // Each part numbered from 1, the rank in the number's title.
  expect(await numbers(page, true)).toEqual(oneToN(makes));
  expect(await numbers(page, false)).toEqual(oneToN(misses - 1));
  const firstMiss = page.locator('[data-testid="prio-row"][data-above="false"]').first();
  await expect(firstMiss.getByTestId('prio-rank')).toHaveAttribute('title', /^Rank \d+$/);
  // The All chip is the parts' sum.
  await expect(page.getByTestId('cs-legend').getByRole('button', { name: /^All / })).toHaveText(
    `All ${makes + misses}`,
  );
  // Open, the triage row shows, last in Misses, with no goal and Add effort.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('prio-row')).toHaveCount(makes + misses);
  expect(await numbers(page, false)).toEqual(oneToN(misses));
  const triaged = page.getByTestId('prio-row').last();
  await expect(triaged.getByTestId('prio-goal')).toHaveText('No goal');
  await expect(triaged.getByRole('button', { name: 'Add effort' })).toBeVisible();
  // #1739: Value / effort counts the same set as missing this quarter.
  await page.getByRole('tab', { name: 'Value / effort' }).click();
  await expect(page.getByTestId('line-caption').first()).toContainText(
    `${misses} of ${makes + misses} miss this quarter`,
  );
});

test('#1911 a row not on the company roadmap has a small tag; what a move does is said once', async ({
  page,
}) => {
  await open(page, 'one-roadmap');
  const sentence = `Not on ${COMPANY_TITLE} yet: moving it adds it there, under Later.`;
  const row = page.getByTestId('prio-row').filter({
    has: page.getByTestId('prio-title').getByText(OLD_ITEM, { exact: true }),
  });
  await expect(row.getByTestId('prio-adds')).toHaveText(`Not on ${COMPANY_TITLE}`);
  await expect(page.getByText(sentence, { exact: true })).toBeHidden();
  const note = page.getByTestId('prio-adds-note');
  await expect(note).toHaveCount(1);
  await note.getByRole('button', { name: `About Not on ${COMPANY_TITLE}` }).click();
  await expect(page.locator('#prio-adds-text')).toHaveText(sentence);
});

test('#1739 a goal card with no plan work leads to its features this quarter outside the plan', async ({
  page,
}) => {
  await open(page, PRIORITIES_PLAN_GOAL_OUTSIDE_SCENARIO);
  await dateIntoThisQuarter(page, [
    { title: 'Alert rules engine', start: '2026-11-02', end: '2026-11-27' },
  ]);
  // The Ranked list has Grow retention's feature making this quarter.
  const made = page.locator('[data-testid="prio-row"][data-above="true"]').filter({
    has: page.getByTestId('prio-title').getByText('Alert rules engine', { exact: true }),
  });
  await expect(made.getByTestId('prio-goal')).toHaveText('Grow retention');
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  const card = page.locator('[data-testid="plan-goal"][data-goal="Grow retention"]');
  await expect(card.getByTestId('plan-goal-count')).toContainText(
    '0 features in the Guided setup plan',
  );
  const more = card.getByTestId('plan-goal-outside');
  await expect(more).toHaveText('+ 1 outside the plan');
  await more.click();
  const outside = page.locator('[data-testid="plan-outside-goal"][data-key="grow-retention"]');
  await expect(outside).toContainText('Alert rules engine');
  await expect(outside).toBeInViewport();
});

test('#1739 a count of one reads "1 feature", never "1 features"', async ({ page }) => {
  await open(page, PRIORITIES_ONE_FEATURE_SCENARIO);
  const legend = page.getByTestId('cs-legend');
  await expect(legend.getByRole('button', { name: /^All / })).toHaveText('All 1');
  // The Show note, picked to the one feature being built.
  await legend.getByRole('button', { name: 'In progress 1' }).click();
  await expect(page.getByTestId('cs-prio-bar')).toContainText('1 feature being built.');
  // The goal filter line, opened from Home's goal card.
  await page.goto('/simple');
  await page.getByTestId('home-goal-link').filter({ hasText: 'Grow retention' }).click();
  await expect(page.getByTestId('prio-goal-filter')).toContainText(
    /^Showing Grow retention only: 1 of 1 feature(?!s)/,
  );
});
