import { GROUND_TRUTH_FLAGS_SCENARIO } from '../lib/api/mock/ground-truth';
import { HOME_MILESTONES_SCENARIO } from '../lib/api/mock/home-milestones';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';
import { MOCK_EMPTY_FEEDBACK_KEY } from '../lib/api/mock/server';

import { ADMIN, login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * The Home UX audit of Nov 23 (issues 1758-1762, 1764, 1765), driven through Simple's Home on
 * the mock's invented data, desktop (1500x620, as the audit) and phone.
 *
 * Card greeting (1758): protects = with only the Inbox's rows waiting, the greeting reads
 * "1 thing in your Inbox needs you."; fails_when = it reads "A thing in your Inbox waits on you.".
 * Card inbox-row (1762): protects = with no row listed above it, the Inbox row reads "1 in your
 * Inbox" (no "more"), is the link to the Inbox, and the card has one button, opening the Inbox;
 * fails_when = "1 more in your Inbox" with an Open button beside All.
 * Card goal-cards (1759, 1760): protects = each goal card's status is one of At risk, On track,
 * Not measured (the Goal map's words, #1892); its progress reads "Now … · target …"; its share reads "Weight N%"; Goal map
 * is underlined as a link; fails_when = Planned / Not counted yet, "From … · target …",
 * "N% of the score", or a Goal map with no underline.
 * Card flags-lead (1761): protects = the Ground Truth flags lead the Summary, in warning colours,
 * and no tile counts 0; fails_when = a "0" tile or the flags line below the tiles.
 * Card plan (1764, 1765): protects = the plan card's title names its range with a dash (never
 * "this quarter"), the rename pencil says what it does on hover, the commitments past the edge
 * read in warning colours, and the row of items in no milestone draws no bar; fails_when = any of
 * those is lost.
 */

const scenario = (page: Page, value: string, extra?: string) =>
  page.addInitScript(
    ([key, v, x]) => {
      localStorage.setItem(key, v);
      if (x) localStorage.setItem(x, '1');
    },
    [MOCK_SCENARIO_KEY, value, extra ?? ''] as const,
  );

for (const phone of [false, true]) {
  test.describe(phone ? 'phone' : 'desktop', () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1500, height: 620 } });

    test('greeting and Inbox row: plain words, one button (1758, 1762)', async ({ page }) => {
      await scenario(page, 'empty', MOCK_EMPTY_FEEDBACK_KEY);
      await login(page);
      await page.goto('/simple');
      await expect(page.getByTestId('simple-page').getByTestId('home-sentence')).toHaveText(
        '1 thing in your Inbox needs you.',
      );
      const card = page.getByTestId('home-also-waiting');
      const row = card.getByTestId('home-inbox-more');
      await expect(row).toHaveText('1 in your Inbox');
      await expect(card.getByRole('link', { name: 'Open', exact: true })).toHaveCount(0);
      await expect(card.getByTestId('home-also-waiting-all')).toHaveAttribute(
        'href',
        /\/simple\/inbox$/,
      );
      await row.getByRole('link', { name: '1 in your Inbox' }).click();
      await expect(page).toHaveURL(/\/simple\/inbox$/);
    });

    test('goal cards: one status vocabulary, one progress pattern, a weight, a link (1759, 1760)', async ({
      page,
    }) => {
      await scenario(page, 'simple-home');
      await login(page);
      await page.goto('/simple');
      const goals = page.getByTestId('home-goal');
      await expect(goals.first()).toBeVisible();
      const n = await goals.count();
      expect(n).toBeGreaterThan(1);
      for (let i = 0; i < n; i++) {
        const g = goals.nth(i);
        await expect(g.getByTestId('home-goal-status')).toHaveText(
          /^(Met|At risk|On track|Not measured)$/,
        );
        if (await g.getByTestId('home-goal-path').count())
          await expect(g.getByTestId('home-goal-path')).toHaveText(/^Now .+ · target .+$/);
        if (await g.getByTestId('home-goal-weight').count())
          await expect(g.getByTestId('home-goal-weight')).toHaveText(/^Weight \d+%$/);
        const map = g.getByTestId('home-goal-map');
        await expect(map).toHaveText('Goal map');
        expect(await map.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain(
          'underline',
        );
      }
      // The whole path (from where) stays in the progress line's tooltip.
      const retention = goals.filter({ hasText: 'Grow retention' });
      await expect(retention.getByTestId('home-goal-path')).toHaveText(
        'Now 100 teams · target 200 teams with weekly alerts on',
      );
      await expect(retention.getByTestId('home-goal-path')).toHaveAttribute(
        'title',
        'From 50 teams · now 100 teams · target 200 teams with weekly alerts on',
      );
    });

    test('the Ground Truth flags lead the Summary and no tile counts 0 (1761)', async ({
      page,
    }) => {
      await scenario(page, GROUND_TRUTH_FLAGS_SCENARIO);
      await login(page);
      await page.goto('/simple');
      const summary = page.getByTestId('home-summary');
      const line = summary.getByTestId('gtf-line');
      await expect(line).toBeVisible();
      await expect(summary.getByTestId('gtf-open')).toHaveText(/^\d+ Ground Truth flags?$/);
      // It leads: nothing in the card sits above it.
      const top = await line.boundingBox();
      for (const tile of await summary.locator('[data-testid^="home-summary-"]').all()) {
        const box = await tile.boundingBox();
        if (box && top) expect(box.y).toBeGreaterThan(top.y);
      }
      // Warning colours: its own background, not the card's.
      const bg = await line.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      for (const n of await summary.locator('.simple-number').allTextContents())
        expect(n.trim()).not.toBe('0');
    });

    test("the plan card's title, icons, risk line and the items in no milestone (1764, 1765)", async ({
      page,
    }) => {
      await scenario(page, HOME_MILESTONES_SCENARIO);
      await login(page, ADMIN.email);
      await page.goto('/simple');
      const card = page.getByTestId('home-plan');
      await expect(card.getByTestId('home-strip-label').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: /this quarter/ })).toHaveCount(0);
      await expect(
        page.getByRole('heading', {
          level: 2,
          name: /^The plan( · [A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+)?$/,
        }),
      ).toBeVisible();
      // The pencil says what it does on hover (#1897: Edit on a milestone with no date).
      const pencils = page.getByTestId('home-strip-rename');
      const k = await pencils.count();
      for (let i = 0; i < k; i++)
        await expect(pencils.nth(i)).toHaveAttribute('title', /^(Rename|Edit) .+/);
      // The row of items in no milestone is a count and a link, never a bar over the range.
      const loose = page
        .getByTestId('home-strip-row')
        .filter({ hasText: /^Not in a milestone · \d+ items?/ });
      await expect(loose).toHaveCount(1);
      await expect(loose).toHaveAttribute('href', /\/simple\/roadmap/);
      await expect(loose.getByTestId('home-strip-span')).toHaveCount(0);
      await expect(
        page.getByTestId('home-strip-row').first().getByTestId('home-strip-span'),
      ).toHaveCount(1);
      // The commitments past the edge are a risk: warning colours.
      const edge = page.getByTestId('home-strip-edge');
      if (await edge.count()) {
        const bg = await edge.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      }
    });
  });
}

// #1761 "collapse zero counts": once every broken link is settled from the Roadmap, Home draws no
// "0 broken links" tile, while the Summary still shows its Ground Truth flags and other tiles.
test('a count that drops to 0 leaves the Summary, the flags stay (1761)', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await scenario(page, GROUND_TRUTH_FLAGS_SCENARIO);
  await login(page);
  await page.goto('/simple');
  const summary = page.getByTestId('home-summary');
  await expect(summary.getByTestId('home-summary-broken-links')).toBeVisible();
  await page.goto('/simple/roadmap');
  const conflicts = page.getByTestId('conflicts');
  await expect(conflicts.getByTestId('conflict').first()).toBeVisible();
  for (let left = await conflicts.getByTestId('conflict').count(); left > 0; left--) {
    await conflicts
      .getByTestId('conflict')
      .first()
      .getByRole('button', { name: 'Accept as risk' })
      .click();
    await conflicts
      .getByRole('textbox', { name: 'Why it is an accepted risk' })
      .fill('An example reason');
    await conflicts.getByRole('button', { name: 'Save the risk' }).click();
    await expect(conflicts.getByTestId('conflict')).toHaveCount(left - 1);
  }
  await expect(conflicts).toHaveCount(0);
  await page.goto('/simple');
  await expect(summary.getByTestId('gtf-line')).toBeVisible();
  await expect(summary.getByTestId('home-summary-decisions')).toBeVisible();
  await expect(summary.getByTestId('home-summary-broken-links')).toHaveCount(0);
  for (const n of await summary.locator('.simple-number').allTextContents())
    expect(n.trim()).not.toBe('0');
});
