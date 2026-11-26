import { login, openRoadmapItem } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * qa-nov17, Simple Roadmap data (mock default scenario, invented data; owner; 1440):
 * 1. Dates a person sets close Oracle's old date suggestion at once: its panel block, its row
 *    in Needs a decision and the count; an Accept of the old one says why in plain words.
 * 2. A dependency that moves a feature's estimate leaves one estimate in its panel.
 * 2b. Its Dates (i) then reads Oracle's estimate after what it depends on, never dates accepted into a draft.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId('floating-card');
const tray = (page: Page) => page.getByTestId('decision-tray');

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

async function openRoadmap(page: Page) {
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

async function openItem(page: Page, key: string) {
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

async function closePanel(page: Page) {
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
}

async function setDates(page: Page, start: string, end: string) {
  await tap(panel(page).getByRole('button', { name: 'Change the dates' }));
  await panel(page).getByLabel('Start', { exact: true }).fill(start);
  await panel(page).getByLabel('End', { exact: true }).fill(end);
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-dates-kind')).toHaveText('Set by a person');
}

async function openTray(page: Page) {
  await tap(page.getByTestId('needs-decision'));
  await expect(tray(page)).toBeVisible();
}

const datesCount = async (page: Page) =>
  Number(
    await tray(page)
      .getByTestId('tray-counter')
      .filter({ hasText: 'Dates to confirm' })
      .locator('b')
      .innerText(),
  );
const dateRow = (page: Page, title: string) =>
  tray(page).getByTestId('tray-date').filter({ hasText: title });

test("1: dates set here close Oracle's old date suggestion: panel, Needs a decision row and count at once", async ({
  page,
}) => {
  await login(page);
  await openRoadmap(page);
  await openTray(page);
  await expect(dateRow(page, 'Alert routing by team')).toHaveCount(1);
  const before = await datesCount(page);
  await page.keyboard.press('Escape');
  await expect(tray(page)).toHaveCount(0);

  await openItem(page, 'alert-sso');
  await expect(panel(page).getByTestId('card-suggestion')).toBeVisible();
  await setDates(page, '2027-01-11', '2027-02-12');
  await expect(panel(page).getByTestId('card-dates')).toContainText('Jan 11');
  await expect(panel(page).getByTestId('card-suggestion')).toHaveCount(0);
  await closePanel(page);
  // Its dotted outline on the chart goes too.
  await expect(
    page.locator('[data-testid="suggestion-outline"][data-item="alert-sso"]'),
  ).toHaveCount(0);

  await openTray(page);
  await expect(dateRow(page, 'Alert routing by team')).toHaveCount(0);
  await expect.poll(() => datesCount(page).catch(() => 0)).toBe(before - 1);

  // After a reload it stays closed.
  await page.reload();
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openItem(page, 'alert-sso');
  await expect(panel(page).getByTestId('card-dates-kind')).toHaveText('Set by a person');
  await expect(panel(page).getByTestId('card-suggestion')).toHaveCount(0);
});

test('1: Accept of a date suggestion whose item got dates since says so in plain words', async ({
  context,
  page,
}) => {
  await login(page);
  await openRoadmap(page);
  await openTray(page);
  const row = dateRow(page, 'Alert routing by team');
  await expect(row).toHaveCount(1);

  // A second tab (the same person) sets the feature's dates first.
  const other = await context.newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await openRoadmap(other);
  await openItem(other, 'alert-sso');
  await setDates(other, '2027-01-11', '2027-02-12');
  await other.close();

  // This tab still lists Oracle's old dates: Accept is refused in plain words, no raw code.
  await tap(row.getByRole('button', { name: 'Accept' }));
  const toasts = page.getByTestId('toasts');
  await expect(toasts).toContainText('Dates were changed since Oracle suggested these');
  await expect(toasts).not.toContainText('outdated');
  await expect(dateRow(page, 'Alert routing by team')).toHaveCount(0);
});

test("2: a dependency that moves a feature's estimate leaves one estimate in its panel", async ({
  page,
}) => {
  await login(page);
  await openRoadmap(page);
  // The feature it will wait on ends well after Oracle's suggested dates.
  await openItem(page, 'alert-digest');
  await setDates(page, '2027-11-01', '2027-12-31');
  await closePanel(page);

  await openItem(page, 'alert-sso');
  await expect(panel(page).getByTestId('card-suggestion')).toBeVisible();
  await tap(panel(page).getByRole('button', { name: 'Add a dependency' }));
  const pick = panel(page).getByLabel('Feature it depends on');
  const value = await pick
    .locator('option', { hasText: 'Weekly alert digest' })
    .first()
    .getAttribute('value');
  await pick.selectOption(value!);
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-depends')).toContainText('Weekly alert digest');

  // After a reload, its dates read Oracle's estimate after the dependency, with no second, older estimate under them.
  await page.reload();
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openItem(page, 'alert-sso');
  await expect(panel(page).getByTestId('card-dates')).toContainText('Jan 1');
  await expect(panel(page).getByTestId('card-suggestion')).toHaveCount(0);
  await expect(panel(page)).not.toContainText('Oracle suggests');
  await closePanel(page);
  await openTray(page);
  await expect(dateRow(page, 'Alert routing by team')).toHaveCount(0);
});

test('2b: a dependency that outdates a suggestion leaves no word of dates accepted into a draft', async ({
  page,
}) => {
  // protects: an item with no picked quarter and an open suggestion comes to depend on a feature
  // that ends later; its Dates (i) reads Oracle's estimate after what it depends on; fails_when:
  // it says the dates were accepted from Oracle's suggestion in a draft (nothing was accepted)
  await login(page);
  await openRoadmap(page);
  await openItem(page, 'alert-digest');
  await setDates(page, '2027-11-01', '2027-12-31');
  await closePanel(page);

  await openItem(page, 'alert-sso');
  const why = panel(page).getByTestId('card-dates-why');
  await expect(why).toHaveAccessibleDescription(/Oracle suggested these dates/);
  await tap(panel(page).getByRole('button', { name: 'Add a dependency' }));
  const pick = panel(page).getByLabel('Feature it depends on');
  const value = await pick
    .locator('option', { hasText: 'Weekly alert digest' })
    .first()
    .getAttribute('value');
  await pick.selectOption(value!);
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-depends')).toContainText('Weekly alert digest');
  await expect(panel(page).getByTestId('card-suggestion')).toHaveCount(0);
  await expect(why).not.toHaveAccessibleDescription(/accepted/);
  await expect(why).toHaveAccessibleDescription(
    /Oracle estimated these dates from the .* window and what the feature depends on/,
  );

  await page.reload();
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openItem(page, 'alert-sso');
  await expect(panel(page).getByTestId('card-dates')).toContainText('Jan 1');
  await expect(why).not.toHaveAccessibleDescription(/accepted/);
});

test('11: Needs a decision keeps its count in sight and says what it counts behind an (i)', async ({
  page,
}) => {
  await login(page);
  await openRoadmap(page);
  await openTray(page);
  const scope = tray(page).getByTestId('tray-scope');
  await expect(scope).toContainText(/^\d+( here, \d+ in all)? to decide/);
  // Its words show only from the (i) (their text is in the page, hidden, until then).
  await expect.poll(() => scope.innerText()).not.toContain('working draft');
  await expect.poll(() => scope.innerText()).not.toContain('broken links, dates to confirm');
  await tap(scope.getByRole('button', { name: 'About what is counted' }));
  await expect(scope.getByRole('tooltip')).toBeVisible();
  await expect(scope.getByRole('tooltip')).toHaveText(
    "In your roadmaps' working drafts: broken links, dates to confirm, proposals, items pulled in and suggested features.",
  );
});

test("11: the panel's Oracle suggests block says how Oracle reached its dates behind an (i)", async ({
  page,
}) => {
  await login(page);
  await openRoadmap(page);
  await openItem(page, 'alert-sso');
  const block = panel(page).getByTestId('card-suggestion');
  await expect(block).toContainText('Oracle suggests');
  await expect.poll(() => block.innerText()).not.toContain(' days');
  await expect.poll(() => block.innerText()).not.toContain('It starts');
  await tap(block.getByRole('button', { name: "About Oracle's dates" }));
  await expect(block.getByRole('tooltip')).toBeVisible();
  await expect(block.getByRole('tooltip')).toContainText(/It starts .* runs \d+ days/);
});

test('10: every broken-link row reads the feature with its code, then a short reason, other features by code too', async ({
  page,
}) => {
  await login(page);
  await openRoadmap(page);
  const rows = page
    .getByTestId('conflicts')
    .locator('[data-testid="conflict"][data-item="alert-digest"]');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    // The feature first, by its code and name, as a button that opens it; then the reason in words.
    const text = await row.innerText();
    expect(text).toMatch(/^F-\d+ Weekly alert digest/);
    expect(text).not.toContain('‘Weekly alert digest’');
  }
  // Each row says what is broken in a few words in sight, the end past its milestone as the link is;
  // the whole reason, other features by code, behind its (i).
  await expect(
    rows.getByTestId('conflict-short').filter({ hasText: 'starts before what it depends on ends' }),
  ).toBeVisible();
  await expect(
    rows.getByTestId('conflict-short').filter({ hasText: 'ends after its milestone' }),
  ).toBeVisible();
  const link = rows.filter({ hasText: 'starts before' });
  await tap(link.getByRole('button', { name: 'About what is broken' }));
  await expect(link.getByRole('tooltip')).toContainText(/which it depends on, ends/);
});

test('10: the Trash dialog and its note name the feature with its code', async ({ page }) => {
  await login(page);
  await openRoadmap(page);
  await openItem(page, 'alert-digest');
  await tap(panel(page).getByRole('button', { name: 'More actions' }));
  await tap(panel(page).getByRole('menuitem', { name: 'Move to Trash' }));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('toasts')).toContainText(
    /Moved F-\d+ Weekly alert digest to Trash\./,
  );
});
