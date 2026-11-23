import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/**
 * roadmap-add (#1553): an item added on Simple > Roadmap lands on the track the person picked,
 * with its code at once; the feature panel moves it to another track or goal in one step; its
 * Move to Trash is one action with Undo. Driven through the UI against the mock (add_item,
 * set_track, set_goal, DELETE .../roadmap/items/{id}). Invented data: the Alerts roadmap's first
 * track is Usage alerts track, so an item that should sit on Guided setup track and shows there
 * was not filed on the default.
 *
 * Cards (protects / fails_when / no_claim):
 * - add into a picked track: protects=with more than one track and none picked, the add bar
 *   asks for one and adds nothing; picked, the item sits on that track with the next free code
 *   (F-n, no other row has it) and its panel open; fails_when=it lands on the roadmap's first
 *   track, has no code, or is added with no track picked; no_claim=Oracle's drafting.
 * - change track and goal: protects=choosing a value in the panel's Track or Goal saves it at
 *   once (no Save button) and the row moves to that track's or goal's band, also a goal no
 *   item serves yet; fails_when=a Save step is needed, the row stays, or only goals with items
 *   are offered; no_claim=the API's refusal (pytest).
 * - delete and undo: protects=Move to Trash from the panel's menu asks nothing, the row leaves
 *   at once, and the note's Undo brings it back; fails_when=a dialog asks or the row stays;
 *   no_claim=Settings > Trash.
 */

const ROADMAP = '/simple/roadmap';
const bar = (page: Page, key: string): Locator =>
  page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const toastWith = (page: Page, text: string | RegExp): Locator =>
  page.getByRole('status').filter({ hasText: text });
const panel = (page: Page) => page.getByTestId('floating-card');

/** The Gantt group (its header's name) an item's row sits under, by the item's name. */
const groupOf = (page: Page, title: string) =>
  page
    .getByTestId('chart-label')
    .filter({
      has: page
        .getByTestId('label-title')
        .getByText(new RegExp(`^(?:[A-Z][A-Z0-9]*-\\S+ )?${title}$`)),
    })
    .evaluate((el) => {
      let e = el.parentElement!.previousElementSibling;
      while (e && e.getAttribute('data-testid') !== 'chart-group') e = e.previousElementSibling;
      return e?.getAttribute('data-add-label') ?? '';
    });

async function openGantt(page: Page) {
  await login(page);
  await page.goto(ROADMAP);
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId('format-gantt').click();
  await expect(page.getByTestId('group-track')).toHaveAttribute('aria-pressed', 'true');
}

/** Types a title, picks the Alerts roadmap and `track`, and presses Enter. */
async function addOn(page: Page, title: string, track: string) {
  await page.getByLabel('Add an item').fill(title);
  await page.getByTestId('quick-add-roadmap').selectOption({ label: 'Alerts roadmap' });
  await page.getByTestId('quick-add-track').selectOption({ label: track });
  await page.getByLabel('Add an item').press('Enter');
  await expect(toastWith(page, `Added ${title} as a draft`)).toBeVisible();
}

test.describe('roadmap-add', () => {
  test.use({ viewport: { width: 1366, height: 820 } });

  test('an item added into a picked track sits there, with its code', async ({ page }) => {
    await openGantt(page);
    // No track picked: the bar asks for one and adds nothing.
    await page.getByLabel('Add an item').fill('Ledger export');
    await page.getByTestId('quick-add-roadmap').selectOption({ label: 'Alerts roadmap' });
    await page.getByLabel('Add an item').press('Enter');
    await expect(page.getByTestId('quick-add-error')).toHaveText('Pick the track it goes on');
    await expect(page.getByTestId('quick-add-track')).toBeFocused();
    await expect(bar(page, 'ledger-export')).toHaveCount(0);

    await page.getByTestId('quick-add-track').selectOption({ label: 'Guided setup track' });
    await page.getByLabel('Add an item').press('Enter');
    await expect(toastWith(page, 'Added Ledger export as a draft')).toBeVisible();
    await expect(bar(page, 'ledger-export')).toBeVisible();
    await expect.poll(() => groupOf(page, 'Ledger export')).toBe('Guided setup track');
    // Its code at once, on the row and in its panel, and no other row has it.
    await expect(panel(page)).toBeVisible();
    const code = (await panel(page).getByTestId('card-code').innerText()).trim();
    expect(code).toMatch(/^F-\d+$/);
    await expect(panel(page).getByTestId('card-track')).toHaveText('Guided setup track');
    const label = page.getByTestId('label-title').filter({ hasText: /Ledger export$/ });
    await expect(label).toHaveText(`${code} Ledger export`);
    await expect(
      page.getByTestId('label-title').filter({ hasText: new RegExp(`^${code} `) }),
    ).toHaveCount(1);
  });

  test("the panel's Track and Goal move the row in one step", async ({ page }) => {
    await openGantt(page);
    await addOn(page, 'Ledger export', 'Guided setup track');
    await expect.poll(() => groupOf(page, 'Ledger export')).toBe('Guided setup track');

    await panel(page).getByRole('button', { name: 'Change the track' }).click();
    await expect(panel(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
    await panel(page).getByLabel('Track').selectOption({ label: 'Usage alerts track' });
    await expect(panel(page).getByTestId('card-track')).toHaveText('Usage alerts track');
    await expect.poll(() => groupOf(page, 'Ledger export')).toBe('Usage alerts track');
    await expect(toastWith(page, /Track changed/)).toBeVisible();

    await page.getByTestId('group-goal').click();
    await panel(page).getByRole('button', { name: 'Change the goal' }).click();
    const goal = panel(page).getByLabel('Goal');
    const option = await goal
      .locator('option', { hasText: 'Faster activation' })
      .first()
      .getAttribute('value');
    await goal.selectOption(option ?? '');
    await expect(panel(page).getByTestId('card-goal')).toHaveText('Faster activation');
    await expect.poll(() => groupOf(page, 'Ledger export')).toBe('Faster activation');

    // Any goal, also one no item serves yet (Growth): the row moves to its band.
    const newBand = page.locator('[data-testid="chart-group"][data-add-label="Growth"]');
    await expect(newBand).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Change the goal' }).click();
    const unserved = await panel(page)
      .getByLabel('Goal')
      .locator('option', { hasText: /^Growth$/ })
      .first()
      .getAttribute('value');
    await panel(page)
      .getByLabel('Goal')
      .selectOption(unserved ?? '');
    await expect(panel(page).getByTestId('card-goal')).toHaveText('Growth');
    await expect.poll(() => groupOf(page, 'Ledger export')).toBe('Growth');
  });

  test("the panel's Move to Trash is one step, with Undo", async ({ page }) => {
    await openGantt(page);
    await addOn(page, 'Ledger export', 'Guided setup track');
    await expect(bar(page, 'ledger-export')).toBeVisible();
    await panel(page).getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(bar(page, 'ledger-export')).toHaveCount(0);
    const note = toastWith(page, /Moved .*Ledger export to Trash/);
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Undo' }).click();
    await expect(bar(page, 'ledger-export')).toBeVisible();
  });
});
