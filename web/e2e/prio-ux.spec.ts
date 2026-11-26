import { GROUND_TRUTH_FLAGS_SCENARIO } from '../lib/api/mock/ground-truth';
import { MOCK_SCENARIO_KEY, UNIQUE_CODES_SCENARIO } from '../lib/api/mock/server';
import { PRIORITIES_TWINS_SCENARIO } from '../lib/api/mock/simple-priorities';

import { login } from './helpers';
import { expect, test } from './test';

import type { Locator, Page } from '@playwright/test';

/**
 * prio-ux (#1738, #1739, #1773–#1777): Simple Priorities as the Nov 23 audit read it, as the owner in a
 * 1500 × 620 window. Finished work leaves the ranking and the ranks read 1, 2, 3… with no gap; every tab
 * names one period; a row's name takes the width with its details under it and its ⋯ at the name's line
 * end; the numbers are words and a rounded score with the model's numbers on hover; a code is shown once;
 * Value / effort's marks never cover each other and its side list says why its numbers skip.
 */

test.use({ viewport: { width: 1500, height: 620 } });

async function open(page: Page, query = '', scenario: string | null = null) {
  if (scenario)
    await page
      .context()
      .addInitScript(([k, v]) => localStorage.setItem(k, v), [
        MOCK_SCENARIO_KEY,
        scenario,
      ] as const);
  await login(page);
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId(query ? 'vxe-plot' : 'prio-row').first()).toBeVisible();
}

const rowByTitle = (page: Page, title: string) =>
  page.getByTestId('prio-row').filter({
    has: page.getByTestId('prio-title').getByText(title, { exact: true }),
  });

async function ranks(page: Page): Promise<number[]> {
  const all = await page.getByTestId('prio-rank').allInnerTexts();
  return all.map(Number).sort((a, b) => a - b);
}

const box = async (l: Locator) => (await l.boundingBox())!;

test('#1738 a feature marked Done leaves the ranking and the ranks close up', async ({ page }) => {
  await open(page);
  const first = page.getByTestId('prio-row').first();
  const title = (await first.getByTestId('prio-title').innerText()).trim();
  const before = await ranks(page);
  expect(before).toEqual(before.map((_, i) => i + 1));
  await first.getByTestId('prio-title').click();
  const panel = page.getByTestId('floating-card');
  await panel.getByRole('button', { name: 'Change the status' }).click();
  await panel.getByTestId('card-status-edit').getByLabel('Status').selectOption('done');
  await expect(panel.getByTestId('card-status')).toHaveText('Done');
  await page.keyboard.press('Escape');
  await expect(rowByTitle(page, title)).toHaveCount(0);
  await expect(page.getByTestId('prio-rank')).toHaveCount(before.length - 1);
  // No gap where it was: the ranks read 1, 2, 3…
  expect(await ranks(page)).toEqual(before.slice(0, -1));
});

test('#1777 every tab names the one period', async ({ page }) => {
  await open(page, '', 'simple-plan');
  const subtitle = page.getByTestId('prio-subtitle');
  const ranked = (await subtitle.innerText()).trim();
  expect(ranked).not.toBe('');
  for (const tab of ['Value / effort', 'Goal buckets', 'Ranked list']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(subtitle).toHaveText(ranked);
  }
});

test('#1773 one row layout: the name takes the width, the details under it, the ⋯ at its line end', async ({
  page,
}) => {
  await open(page);
  const rows = page.getByTestId('prio-row');
  const n = await rows.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i++) {
    const r = rows.nth(i);
    const row = await box(r);
    const name = await box(r.getByTestId('prio-name'));
    const details = await box(r.getByTestId('prio-details'));
    const menu = await box(r.getByTestId('prio-row-menu'));
    expect(name.width, `row ${i}`).toBeGreaterThan(row.width * 0.6);
    expect(details.y, `row ${i}`).toBeGreaterThanOrEqual(name.y + name.height - 1);
    // The ⋯ sits on the name's line, at the row's right end, on every row.
    expect(menu.y, `row ${i}`).toBeLessThan(details.y);
    expect(row.x + row.width - (menu.x + menu.width), `row ${i}`).toBeLessThan(24);
  }
});

test('#1774 a row reads words and a rounded score; the model numbers are on hover', async ({
  page,
}) => {
  await open(page);
  const numbers = await page.getByTestId('prio-numbers').allInnerTexts();
  expect(numbers.length).toBeGreaterThan(3);
  for (const t of numbers) expect(t).not.toMatch(/value \d|confidence/);
  for (const v of await page.getByTestId('prio-value').allInnerTexts())
    expect(v.trim()).toMatch(/^(High|Medium|Low|No goal) value$/);
  for (const s of await page.getByTestId('prio-score').allInnerTexts())
    expect(s.trim()).toMatch(/^\d+(\.\d)?$/);
  const value = page.getByTestId('prio-value').first();
  await expect(value).toHaveAttribute('title', /^Goal value [\d.]+ · confidence [\d.]+/);
  await expect(page.getByTestId('prio-score').first()).toHaveAttribute(
    'title',
    /score [\d.]+\. Score = goal value/,
  );
});

test('#1775 a title that starts with its code shows the code once', async ({ page }) => {
  // unique-codes: "F-88 Sample data import" is an item whose own code (F-88) comes from its title.
  await open(page, '', UNIQUE_CODES_SCENARIO);
  const row = rowByTitle(page, 'Sample data import');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('prio-own-key')).toHaveText('F-88');
  await expect(
    row.getByRole('button', { name: 'Drag Sample data import (F-88) to reorder' }),
  ).toHaveCount(1);
  await expect(page.getByTestId('prio-title').getByText('F-88 Sample data import')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Value / effort' }).click();
  const side = page.getByRole('region', { name: 'Ranked side list' });
  await expect(
    side.getByTestId('prio-title').getByText('Sample data import', { exact: true }),
  ).toHaveCount(1);
});

test('#1739 the Ranked list and Goal buckets count one quarter', async ({ page }) => {
  await open(page, '', 'simple-plan');
  const makes = await page.locator('[data-testid="prio-row"][data-above="true"]').count();
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  const counts = await page.getByText(/^\d+ features? in the plan$/).allInnerTexts();
  const inPlan = counts.reduce((n, t) => n + Number(t.split(' ')[0]), 0);
  expect(makes).toBe(inPlan);
});

test('#1776 Value / effort: no mark covers another, and the side list says why its numbers skip', async ({
  page,
}) => {
  await open(page, '?tab=value-effort');
  await expect(page.getByTestId('vxe-plot')).toBeVisible();
  const marks = [
    ...(await page.getByTestId('vxe-point').all()),
    ...(await page.getByTestId('vxe-crowd').all()),
  ];
  expect(marks.length).toBeGreaterThan(3);
  const boxes = await Promise.all(marks.map(box));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const overlap = w > 0 && h > 0 ? w * h : 0;
      expect(overlap, `marks ${i} and ${j}`).toBeLessThan(
        0.25 * Math.min(a.width * a.height, b.width * b.height),
      );
    }
  const side = page.getByRole('region', { name: 'Ranked side list' });
  const shown = (await side.getByTestId('side-rank').allInnerTexts()).map(Number);
  expect([...shown].sort((a, b) => a - b)).toEqual(shown.map((_, i) => i + 1));
  await side.getByTestId('side-ranks-help').click();
  await expect(page.getByRole('tooltip')).toContainText(
    'shown on hover over its number in the Ranked list',
  );
});

test('#1738 a move on Goal buckets names the place the Ranked list shows, with a Done feature left out', async ({
  page,
}) => {
  await open(page, '', 'goal-buckets-undated');
  // The first feature is Done: every API rank after it is one more than its place in the list.
  const first = page.getByTestId('prio-row').first();
  const done = (await first.getByTestId('prio-title').innerText()).trim();
  await first.getByTestId('prio-title').click();
  const panel = page.getByTestId('floating-card');
  await panel.getByRole('button', { name: 'Change the status' }).click();
  await panel.getByTestId('card-status-edit').getByLabel('Status').selectOption('done');
  await expect(panel.getByTestId('card-status')).toHaveText('Done');
  await page.keyboard.press('Escape');
  await expect(rowByTitle(page, done)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  const bucket = page
    .getByTestId('goal-bucket')
    .filter({ has: page.getByRole('heading', { name: 'Reliability', exact: true }) });
  const moved = bucket.getByTestId('plan-feature').first();
  const name = (await moved.getByTestId('plan-feature-name').innerText()).trim();
  await moved.getByTestId('plan-feature-open').focus();
  await page.keyboard.press('Alt+ArrowDown');
  const note = page.getByTestId('bucket-note');
  await expect(note).toContainText(`Moved ${name} to rank `);
  const place = Number((await note.innerText()).match(/to rank (\d+)/)![1]);
  await page.getByRole('tab', { name: 'Ranked list' }).click();
  await expect(rowByTitle(page, name).getByTestId('prio-rank')).toHaveText(String(place));
});

// prio-2 (#1895): the All chip counts the ranked features the list holds (the line's "N of M" too); a feature's
// same-name lines sit on its row and items with no ranked feature in their own list, never added to All.
for (const [what, scenario] of [
  ['a same-name line', PRIORITIES_TWINS_SCENARIO],
  ['an item not ranked yet', GROUND_TRUTH_FLAGS_SCENARIO],
] as const)
  test(`#1895 the All chip equals the ranked rows listed, with ${what} on the page`, async ({
    page,
  }) => {
    await open(page, '', scenario);
    const rows = await page.getByTestId('prio-row').count();
    const twins = await page.getByTestId('prio-twin').count();
    const unranked = await page.getByTestId('prio-unranked-row').count();
    expect(twins + unranked).toBeGreaterThan(0);
    await expect(page.getByTestId('cs-legend').getByRole('button', { name: /^All / })).toHaveText(
      `All ${rows}`,
    );
    await expect(page.getByTestId('line-caption').first()).toContainText(`of ${rows} miss`);
    await expect(page.getByTestId('prio-all-help')).toHaveCount(0);
  });
