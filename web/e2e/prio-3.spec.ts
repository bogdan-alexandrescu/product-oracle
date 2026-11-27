import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { PRIORITIES_LIVE_SHAPE_SCENARIO } from '../lib/api/mock/simple-priorities';

import { login } from './helpers';
import { expect, test } from './test';

import type { Page } from '@playwright/test';

/**
 * prio-3 (#1739, #1898, #1894): Simple Priorities on the live read's shape (the "priorities-live-shape" scenario,
 * invented data): one PRD's plan with no engineer-weeks of its own and the PRD's own milestone numbers, a goal whose
 * features make this quarter outside that plan, ranks above the line that skip. As the owner, 1512 × 756.
 */

test.use({ viewport: { width: 1512, height: 756 } });

async function open(page: Page, scenario: string) {
  await page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto('/simple/priorities');
  await expect(page.getByTestId('prio-row').first()).toBeVisible();
}

test('#1739 Goal buckets reads the weeks the other tabs read and names the PRD whose plan it counts', async ({
  page,
}) => {
  await open(page, PRIORITIES_LIVE_SHAPE_SCENARIO);
  // The Ranked list: Grow retention's two features make this quarter, 4 and 2 engineer-weeks.
  const made = page.locator('[data-testid="prio-row"][data-above="true"]').filter({
    has: page.getByTestId('prio-goal').getByText('Grow retention', { exact: true }),
  });
  await expect(made).toHaveCount(2);
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  // Never 0 weeks while the goals hold weeks this quarter.
  await expect(page.getByTestId('buckets-summary')).not.toContainText(/(^|\D)0 engineer-weeks/);
  const bar = page.locator('[data-testid="goal-bar"][data-goal="Grow retention"]');
  await expect(bar.getByTestId('goal-bar-total')).toHaveText('6 weeks');
  await expect(
    page
      .locator('[data-testid="goal-bar"][data-goal="Faster activation"]')
      .getByTestId('goal-bar-total'),
  ).toHaveText('6 weeks');
  // "In the plan" is one PRD's plan: the label says which.
  const card = page.locator('[data-testid="plan-goal"][data-goal="Grow retention"]');
  await expect(card.getByTestId('plan-goal-count')).toContainText(
    '0 features in the Guided setup plan',
  );
  await expect(card.getByTestId('plan-goal-outside')).toHaveText('+ 2 outside the plan');
});

for (const scenario of ['simple-plan', PRIORITIES_LIVE_SHAPE_SCENARIO])
  test(`#1898 a feature has one number on the Ranked list and on Value / effort (${scenario})`, async ({
    page,
  }) => {
    await open(page, scenario);
    const ranked = new Map<string, string>();
    for (const row of await page.getByTestId('prio-row').all())
      ranked.set(
        (await row.getAttribute('data-code'))!,
        await row.getByTestId('prio-rank').innerText(),
      );
    await page.getByRole('tab', { name: 'Value / effort' }).click();
    const side = page.getByTestId('side-row');
    await expect(side.first()).toBeVisible();
    const both: string[] = [];
    for (const row of await side.all()) {
      const code = (await row.getAttribute('data-code'))!;
      const n = await row.getByTestId('side-rank').innerText();
      if (ranked.has(code)) {
        expect(n, code).toBe(ranked.get(code));
        both.push(code);
      }
    }
    expect(both.length).toBeGreaterThan(5);
    // Makes this quarter reads 1, 2, 3 … on both tabs.
    const above = await page
      .locator('[data-testid="side-row"][data-above="true"] [data-testid="side-rank"]')
      .allInnerTexts();
    expect(above.map(Number)).toEqual(above.map((_, i) => i + 1));
  });

test('#1894 Priorities never prints a PRD-own milestone number', async ({ page }) => {
  await open(page, PRIORITIES_LIVE_SHAPE_SCENARIO);
  // A row whose milestone carries the PRD's own "M2" reads the PRD milestone's name.
  const row = page.locator('[data-testid="prio-row"][data-code="alert-rules"]');
  await expect(row.getByTestId('prio-milestone')).toHaveText(
    'Milestone Scale volume (99.7% setup success)',
  );
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  // The plan's milestones have no roadmap-wide code (the roadmap's M1 is Beta): their names, no number.
  const legend = page.getByTestId('milestone-chip');
  await expect(legend).toHaveCount(3);
  await expect(legend.nth(0)).toContainText(/^Prove it /);
  await expect(legend.nth(1)).toContainText(/^Scale volume /);
  await expect(legend.nth(2)).toContainText(/^Open to all /);
  for (const t of await legend.allInnerTexts()) expect(t).not.toMatch(/\bM\d/);
  const chips = page.getByTestId('plan-chip');
  await expect(chips.first()).toBeVisible();
  for (const t of await chips.allInnerTexts()) expect(t).not.toMatch(/\bM\d/);
});
