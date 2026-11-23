import { GM_TRACKS_SCENARIO } from '../lib/api/mock/goal-map-tracks';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * prioritize part 2: goals reordered by their header on Priorities > Goal buckets and on the Goal
 * map, saved at once as the one goal order (invented goals: "goal-buckets-undated" and the goal
 * map's tracks scenario).
 *
 * Cards (protects / fails_when / no_claim):
 * - buckets drag: protects=dragging a goal's heading onto the goal before it moves it there at
 *   once, kept after a reload; fails_when=it stays or a Save is needed.
 * - buckets keys: protects=Alt+ArrowUp on a focused heading moves the goal one place.
 * - map keys and drag: protects=the same on the Goal map's goal cards, Alt+ArrowRight / Left.
 * - who: a viewer, and a commenter (goal-order proposals are not built), have no handle.
 * no_claim=Home's Change order (goal-order specs).
 */

test.use({ viewport: { width: 1512, height: 900 } });

async function buckets(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    'goal-buckets-undated',
  ] as const);
  await login(page, email);
  await page.goto('/simple/priorities?tab=buckets');
  await expect(page.getByTestId('goal-bucket').first()).toBeVisible();
  if (!email) await expect(page.getByTestId('goal-handle').first()).toBeVisible();
}
const bucketGoals = (page: Page) =>
  page
    .locator('[data-testid=goal-bucket][data-goal-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-goal-id')));

async function goalMap(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    GM_TRACKS_SCENARIO,
  ] as const);
  await login(page, email);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-grid')).toBeVisible();
  if (!email) await expect(page.getByTestId('goal-handle').first()).toBeVisible();
}
const mapGoals = (page: Page) =>
  page.getByTestId('gm-goal').evaluateAll((els) => els.map((e) => e.getAttribute('data-goal')));

const swap = <T>(xs: T[], i: number) => [...xs.slice(0, i), xs[i + 1], xs[i], ...xs.slice(i + 2)];

test.describe('Goals: prioritize by their header', () => {
  test('Goal buckets: drag a goal heading onto the goal before it; kept after a reload', async ({
    page,
  }) => {
    await buckets(page);
    const before = await bucketGoals(page);
    expect(before.length).toBeGreaterThan(1);
    const second = page.locator(`[data-goal-id="${before[1]}"]`);
    await second
      .getByTestId('goal-handle')
      .dragTo(page.locator(`[data-goal-id="${before[0]}"]`).getByTestId('goal-handle'));
    const after = swap(before, 0);
    await expect.poll(() => bucketGoals(page)).toEqual(after);
    await expect(page.getByTestId('bucket-note')).toContainText('Goal order saved');
    await page.reload();
    await expect(page.getByTestId('goal-handle').first()).toBeVisible();
    await expect.poll(() => bucketGoals(page)).toEqual(after);
  });

  test('Goal buckets: Alt+ArrowUp on a focused goal heading moves it one place', async ({
    page,
  }) => {
    await buckets(page);
    const before = await bucketGoals(page);
    await page.locator(`[data-goal-id="${before[1]}"]`).getByTestId('goal-handle').focus();
    await page.keyboard.press('Alt+ArrowUp');
    const after = swap(before, 0);
    await expect.poll(() => bucketGoals(page)).toEqual(after);
    await expect(page.getByTestId('bucket-note')).toContainText('Goal order saved');
    await page.reload();
    await expect(page.getByTestId('goal-handle').first()).toBeVisible();
    await expect.poll(() => bucketGoals(page)).toEqual(after);
  });

  test('Goal map: Alt+ArrowRight and a drag move goals; kept after a reload', async ({ page }) => {
    await goalMap(page);
    const before = await mapGoals(page);
    expect(before.length).toBeGreaterThan(1);
    const handle = (id: string | null) =>
      page.locator(`[data-testid=gm-goal][data-goal="${id}"]`).getByTestId('goal-handle');
    await handle(before[0]).focus();
    await page.keyboard.press('Alt+ArrowRight');
    const once = swap(before, 0);
    await expect.poll(() => mapGoals(page)).toEqual(once);
    const saved = page.getByRole('status').filter({ hasText: 'Goal order saved' });
    await expect(saved).toBeVisible();
    // Each save draws a new toast: the first one gone and a toast shown again is the second saved.
    const first = await saved.elementHandle();
    await handle(once[1]).dragTo(handle(once[0]));
    await expect.poll(() => mapGoals(page)).toEqual(before);
    await first.waitForElementState('hidden');
    await expect(saved).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('gm-grid')).toBeVisible();
    await expect.poll(() => mapGoals(page)).toEqual(before);
    await handle(before[0]).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => mapGoals(page)).toEqual(once);
  });

  // Every page follows: moved on the Goal map, Goal buckets reads the two goals in the same order.
  test('Goal buckets reads the goal order the Goal map sets', async ({ page }) => {
    await goalMap(page);
    const before = await mapGoals(page);
    const handle = (id: string | null) =>
      page.locator(`[data-testid=gm-goal][data-goal="${id}"]`).getByTestId('goal-handle');
    const two = (gs: (string | null)[]) => gs.filter((g) => g === before[0] || g === before[1]);
    const inBuckets = async () => {
      await page.goto('/simple/priorities?tab=buckets');
      await expect(page.getByTestId('goal-bucket').first()).toBeVisible();
      return two(await bucketGoals(page));
    };
    expect(await inBuckets()).toEqual([before[0], before[1]]);
    await page.goto('/simple/goals');
    await expect(page.getByTestId('gm-grid')).toBeVisible();
    await handle(before[0]).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => mapGoals(page)).toEqual(swap(before, 0));
    await expect(page.getByRole('status').filter({ hasText: 'Goal order saved' })).toBeVisible();
    expect(await inBuckets()).toEqual([before[1], before[0]]);
  });

  // Goal-order proposals are not built: a commenter gets no goal handle (handoff.md).
  test('a commenter has no goal handle on either page', async ({ page }) => {
    await buckets(page, 'commenter@example.com');
    await expect(page.getByTestId('goal-handle')).toHaveCount(0);
    await page.goto('/simple/goals');
    await expect(page.getByTestId('gm-grid')).toBeVisible();
    await expect(page.getByTestId('goal-handle')).toHaveCount(0);
  });

  test('a viewer has no goal handle on either page', async ({ page }) => {
    await buckets(page, 'viewer@example.com');
    await expect(page.getByTestId('goal-handle')).toHaveCount(0);
    await page.goto('/simple/goals');
    await expect(page.getByTestId('gm-grid')).toBeVisible();
    await expect(page.getByTestId('goal-handle')).toHaveCount(0);
  });
});
