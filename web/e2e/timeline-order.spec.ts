import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * timeline-order (#1553): features prioritized in place on the Roadmap timeline, in the one feature
 * order the Goal buckets follow (Priorities' rank), saved at once (invented goals and features:
 * "goal-buckets-undated").
 *
 * Cards (protects / fails_when / no_claim):
 * - drag: protects=dragging a row by its name onto the row above it in its track moves it there at
 *   once, kept after a reload, and Goal buckets reads the two in the same order; fails_when=it
 *   stays, waits for a Save, comes back, or Goal buckets disagrees.
 * - keys: protects=Alt+ArrowUp on a focused row's name moves it one place, kept after a reload.
 * - proposer: protects=who may only propose files the move: a pending mark, the order kept.
 * - viewer: protects=no row can be dragged and Alt+Arrow moves nothing.
 * no_claim=the Gantt's and Now / Next / Later's order (they follow the same field).
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    'goal-buckets-undated',
  ] as const);
  await login(page, email);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId('format-timeline').click();
  await expect(page.getByTestId('timeline-row').first()).toBeVisible();
}

const rows = (page: Page, lane: string) =>
  page.locator(`[data-testid=timeline-row][data-lane="${lane}"]:not([data-depth])`);
const order = (page: Page, lane: string) =>
  rows(page, lane).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item!));
const name = (page: Page, lane: string, key: string) =>
  rows(page, lane)
    .and(page.locator(`[data-item="${key}"]`))
    .getByTestId('timeline-row-label');

/** The track with the most rows of its own (no parts; its first two depend on nothing), its keys in order. */
async function twoRows(page: Page): Promise<{ lane: string; keys: string[] }> {
  const lanes = await page
    .locator('[data-testid=timeline-row]:not([data-depth])')
    .evaluateAll((els) => {
      const by: Record<string, string[]> = {};
      for (const e of els as HTMLElement[]) (by[e.dataset.lane!] ??= []).push(e.dataset.item!);
      return Object.entries(by).sort((a, b) => b[1].length - a[1].length);
    });
  expect(lanes[0]?.[1].length).toBeGreaterThan(1);
  return { lane: lanes[0][0], keys: lanes[0][1] };
}

const swap = <T>(xs: T[], i: number) => [...xs.slice(0, i), xs[i + 1], xs[i], ...xs.slice(i + 2)];

/** Goal buckets' features, bucket by bucket, in order. */
async function buckets(page: Page): Promise<string[][]> {
  await page.goto('/simple/priorities?tab=buckets');
  await expect(page.getByTestId('plan-feature').first()).toBeVisible();
  return page
    .getByTestId('goal-bucket')
    .evaluateAll((els) =>
      els.map((b) =>
        [...b.querySelectorAll<HTMLElement>('[data-testid=plan-feature]')].map(
          (e) => e.dataset.code!,
        ),
      ),
    );
}

test.describe('Roadmap timeline: prioritize rows in their track', () => {
  test('drag a row by its name above its neighbour: at once, kept after a reload, the same in Goal buckets', async ({
    page,
  }) => {
    await open(page);
    const held = await buckets(page);
    await page.goto('/simple/roadmap');
    await page.getByTestId('format-timeline').click();
    await expect(page.getByTestId('timeline-row').first()).toBeVisible();
    const { lane, keys: before } = await twoRows(page);
    // A goal bucket names a feature by its code.
    const codes = Object.fromEntries(
      await rows(page, lane).evaluateAll((els) =>
        els.map((e) => [
          (e as HTMLElement).dataset.item!,
          e.querySelector('[data-testid=timeline-row-name]')!.textContent!.split(' ')[0],
        ]),
      ),
    );
    // (The plan's own features wait on none of their track's: no dependency holds the move.)
    const bucketOf = (k: string) =>
      k.startsWith('plan-f-') ? held.findIndex((b) => b.includes(codes[k])) : -1;
    // The lower of the first two rows one bucket holds, dragged onto the upper: it takes its place.
    const k = before.findIndex(
      (x, n) => bucketOf(x) >= 0 && before.slice(0, n).some((y) => bucketOf(y) === bucketOf(x)),
    );
    expect(k).toBeGreaterThan(0);
    const j = before.findIndex((y) => bucketOf(y) === bucketOf(before[k]));
    await expect(name(page, lane, before[k])).toHaveAttribute('draggable', 'true');
    await name(page, lane, before[k]).dragTo(name(page, lane, before[j]));
    const after = [...before.slice(0, j), before[k], ...before.slice(j, k), ...before.slice(k + 1)];
    await expect.poll(() => order(page, lane)).toEqual(after);
    await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('timeline-row').first()).toBeVisible();
    await expect.poll(() => order(page, lane)).toEqual(after);
    // One order: their goal bucket reads the two as the timeline does now (it read them the other way).
    const [moved, past] = [codes[before[k]], codes[before[j]]];
    const was = held[bucketOf(before[k])];
    expect(was.indexOf(moved)).toBeGreaterThan(was.indexOf(past));
    const now = (await buckets(page))[bucketOf(before[k])];
    expect(now.indexOf(moved)).toBeLessThan(now.indexOf(past));
  });

  test('Alt+ArrowUp on a focused row moves it one place, kept after a reload', async ({ page }) => {
    await open(page);
    const { lane, keys: before } = await twoRows(page);
    await name(page, lane, before[1]).focus();
    await page.keyboard.press('Alt+ArrowUp');
    const after = swap(before, 0);
    await expect.poll(() => order(page, lane)).toEqual(after);
    await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('timeline-row').first()).toBeVisible();
    await expect.poll(() => order(page, lane)).toEqual(after);
  });

  test('someone who may only propose files the move: a pending mark, the order kept', async ({
    page,
  }) => {
    await open(page, 'commenter@example.com');
    const { lane, keys: before } = await twoRows(page);
    await name(page, lane, before[1]).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('status').filter({ hasText: 'Proposed' })).toBeVisible();
    await expect(name(page, lane, before[1]).getByTestId('order-pending')).toBeVisible();
    expect(await order(page, lane)).toEqual(before);
    await page.reload();
    await expect(page.getByTestId('timeline-row').first()).toBeVisible();
    await expect(name(page, lane, before[1]).getByTestId('order-pending')).toBeVisible();
    expect(await order(page, lane)).toEqual(before);
  });

  test('a viewer: no row can be dragged and Alt+Arrow moves nothing', async ({ page }) => {
    await open(page, 'viewer@example.com');
    const { lane, keys: before } = await twoRows(page);
    await expect(page.locator('[data-testid=timeline-row-label][draggable=true]')).toHaveCount(0);
    await name(page, lane, before[1]).focus();
    await page.keyboard.press('Alt+ArrowUp');
    // Nothing is sent: no move toast and no pending mark, the order as it was.
    await expect(page.getByTestId('order-pending')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /Moved|Proposed/ })).toHaveCount(0);
    expect(await order(page, lane)).toEqual(before);
  });
});
