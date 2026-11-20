import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login, signOut } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * roadmap-dates (QA Nov 14 follow-ups), driven as a person does against the mock's invented data
 * (mock clock: Oct 22, 2026). An undated roadmap item's estimate is Oracle's date suggestion when
 * it has one, on every format and in the panel; a Quick Add to a picked quarter is estimated
 * inside that quarter and sits in its column while Oracle drafts, not under Later; when what it
 * depends on pushes the estimate out of that quarter, the Dates (i) says so.
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const panel = (page: Page): Locator => page.getByTestId('floating-card');
const quarter = (page: Page, label: string): Locator =>
  page
    .getByTestId('timeline-quarter')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^${label}`) }) });
const row = (scope: Locator, key: string): Locator =>
  scope.locator(`[data-testid="timeline-row"][data-item="${key}"]`);

async function openRoadmap(page: Page) {
  await page
    .context()
    .addInitScript((key) => localStorage.setItem(key, 'default'), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible({ timeout: 15_000 });
}

/** A phone's Add: the sheet with the title and where. */
async function sheetAdd(page: Page, title: string, where: string) {
  await page.getByTestId('quick-add-open').click();
  const sheet = page.getByRole('dialog', { name: 'Add an item' });
  await sheet.getByLabel('Title').fill(title);
  await sheet.getByLabel('Roadmap').selectOption({ label: 'Alerts roadmap' });
  await sheet.getByLabel('Where').selectOption({ label: where });
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet).toBeHidden();
}

test.describe('phone', () => {
  test.use(PHONE);

  test("a Quick Add to Q4 2026 sits in Q4 2026 while Oracle drafts, then reads Oracle's suggestion", async ({
    page,
  }) => {
    // protects: the draft is listed under Q4 2026 with an estimate inside it while drafting, then
    // its row and its panel read the same suggested span; fails_when: it lands under a 2027 quarter
    // (Later's window) or the row and the panel disagree
    test.setTimeout(90_000);
    await openRoadmap(page);
    await sheetAdd(page, 'Saved search filters', 'Q4 2026');
    await expect(panel(page).getByTestId('item-drafting')).toHaveText('Oracle is drafting…');
    await panel(page).getByRole('button', { name: 'Close' }).click();
    const r = row(quarter(page, 'Q4 2026'), 'saved-search-filters');
    await expect(r).toContainText('No dates yet · estimated Oct 1 – Dec 31');
    await expect(row(page.locator('body'), 'saved-search-filters')).toHaveCount(1);
    await r.click();
    await expect(panel(page).getByTestId('item-drafting')).toHaveCount(0, { timeout: 15_000 });
    await expect(panel(page).getByTestId('card-dates')).toContainText('Oct 22 – Dec 31');
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(row(quarter(page, 'Q4 2026'), 'saved-search-filters')).toContainText(
      'No dates yet · estimated Oct 22 – Dec 31',
    );
  });

  test('when what it depends on pushes the estimate out of its quarter, the Dates (i) says so', async ({
    page,
  }) => {
    // protects: a Q4 2026 draft that comes to depend on Alert history export (ends Feb 20, 2027)
    // is estimated after it, listed under Q1 2027, and its Dates (i) names Q4 2026 as the
    // quarter it was added to and says the dates fall outside it; fails_when: the (i) gives the
    // window words alone, or the panel keeps the old span while the row moves
    test.setTimeout(90_000);
    await openRoadmap(page);
    await sheetAdd(page, 'Saved search filters', 'Q4 2026');
    await expect(panel(page).getByTestId('item-drafting')).toHaveCount(0, { timeout: 15_000 });
    const why = panel(page).getByTestId('card-dates-why');
    await expect(why).not.toHaveAccessibleDescription(/fall outside/);
    await panel(page).getByRole('button', { name: 'Add a dependency' }).click();
    await panel(page)
      .getByLabel('Feature it depends on')
      .selectOption({ label: 'Alert history export' });
    await panel(page).getByRole('button', { name: 'Save' }).click();
    await expect(
      panel(page).getByTestId('card-depends-row').filter({ hasText: 'Alert history export' }),
    ).toBeVisible();
    await expect(panel(page).getByTestId('card-dates')).toContainText('Feb 21 – May 2, 2027');
    await expect(why).toHaveAccessibleDescription(
      /They fall outside Q4 2026, the quarter it was added to/,
    );
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(row(quarter(page, 'Q1 2027'), 'saved-search-filters')).toContainText(
      'No dates yet · estimated Feb 21 – May 2, 2027',
    );
  });

  test('a Quick Add to Q1 2027 is in Next on Now / Next / Later', async ({ page }) => {
    // protects: the undated draft's column is its picked quarter's; fails_when: it is under Later
    await openRoadmap(page);
    await sheetAdd(page, 'Snooze from the alert', 'Q1 2027');
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await page.getByTestId('format-board').click();
    const card = page.locator(
      '[data-testid="board-column"][data-horizon-column="next"] [data-testid="board-card"][data-item="snooze-from-the-alert"]',
    );
    await expect(card).toContainText('No dates yet · estimated Jan 1 – Mar 31, 2027');
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an undated item's estimate is Oracle's suggestion on the Timeline, the Gantt, the board and the panel", async ({
    page,
  }) => {
    // protects: Health log reads its suggestion's span everywhere; fails_when: a row reads the
    // horizon window (Apr 1, 2027 – Oct 22, 2028) while the panel suggests Apr 1 – Apr 28, 2027
    await openRoadmap(page);
    const words = 'No dates yet · estimated Apr 1 – Apr 28, 2027';
    await page.getByTestId('format-timeline').click();
    await expect(row(page.locator('body'), 'setup-health-log')).toContainText(words);
    await page.getByTestId('format-gantt').click();
    await expect(
      page.locator('[data-testid="bar"][data-item="setup-health-log"]').first(),
    ).toHaveAttribute('aria-label', new RegExp(`Health log: ${words}`));
    await page.getByTestId('format-board').click();
    const card = page.locator('[data-testid="board-card"][data-item="setup-health-log"]');
    await expect(card).toContainText(words);
    await card.click();
    await expect(panel(page).getByTestId('card-dates')).toContainText('Apr 1 – Apr 28, 2027');
    await expect(panel(page)).toContainText('Oracle suggests Apr 1 – Apr 28, 2027');
  });

  test("dates an owner accepted into the working draft stay a viewer's estimate till it publishes", async ({
    page,
  }) => {
    // protects (review of the join): the viewer, who reads the published roadmap, still sees
    // Health log estimated Apr 1 – Apr 28, 2027 once the owner accepted those dates into the draft;
    // fails_when: the viewer's row falls back to Later's window (the mock read open suggestions only)
    await openRoadmap(page);
    const words = 'No dates yet · estimated Apr 1 – Apr 28, 2027';
    await page.getByTestId('format-timeline').click();
    await row(page.locator('body'), 'setup-health-log')
      .getByRole('button', { name: /^F-\d+ Health log$/ })
      .click();
    await expect(panel(page)).toContainText('Oracle suggests Apr 1 – Apr 28, 2027');
    await panel(page).getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(panel(page).getByTestId('card-dates')).toContainText('Apr 1 – Apr 28, 2027');
    await expect(panel(page)).not.toContainText('Oracle suggests');
    // An invented viewer of the mock's company signs in.
    await signOut(page);
    await login(page, 'viewer@example.com');
    await page.goto('/simple/roadmap');
    await expect(page.getByTestId('simple-roadmap')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('format-timeline').click();
    await expect(row(page.locator('body'), 'setup-health-log')).toContainText(words);
    // fails_when: the viewer's panel reads "Later · no dates yet" (the accepted dates are no suggestion)
    await row(page.locator('body'), 'setup-health-log')
      .getByRole('button', { name: /^F-\d+ Health log$/ })
      .click();
    await expect(panel(page).getByTestId('card-dates')).toContainText(
      "Apr 1 – Apr 28, 2027 · Oracle's estimate",
    );
    await expect(panel(page).getByTestId('card-dates')).not.toContainText('no dates yet');
  });
});
