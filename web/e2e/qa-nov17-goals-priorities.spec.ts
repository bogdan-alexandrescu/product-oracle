import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * Simple Goal map and Priorities, the QA of Nov 17, on the default mock scenario (invented data), driven through
 * the UI as the owner.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openPriorities(page: Page, tab = '') {
  await login(page);
  await page.goto(`/simple/priorities${tab ? `?tab=${tab}` : ''}`);
}

const rankedRow = (page: Page, name: string) =>
  page
    .getByTestId('prio-row')
    .filter({ has: page.getByTestId('prio-title').filter({ hasText: name }) });

test.describe('Priorities, desktop', () => {
  test.use({ viewport: DESKTOP });

  test("G3: a ranked row's old proof reads the day it was checked, never 'proof old'", async ({
    page,
  }) => {
    // protects: the Ranked list's pill on a feature with an old proof says "Exists · checked <month day>"
    // fails_when: the pill reads "Exists · proof old"
    await openPriorities(page);
    const pill = rankedRow(page, 'Alert routing by team')
      .first()
      .getByTestId('prio-name')
      .getByTestId('cs-mark')
      .first();
    await expect(pill).toHaveText(/^Exists · checked [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  });

  test('G8: the Beta milestone reads by its code and name on the Ranked list and its Line picker', async ({
    page,
  }) => {
    // protects: one milestone has one name: "M<n> Beta" on a ranked row's chip and in the Line picker, as the roadmap reads it
    // fails_when: the chip reads "Milestone Beta" or the picker "Milestone: Beta · …" with no code
    await openPriorities(page);
    await expect(page.getByTestId('prio-milestone').filter({ hasText: 'Beta' }).first()).toHaveText(
      /^M\d+ Beta$/,
    );
    await expect(
      page
        .locator('#prio-line option')
        .filter({ hasText: /Beta · / })
        .first(),
    ).toHaveText(/^Milestone: M\d+ Beta · [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  test("G4: a Value / effort mark names its feature on hover; the side list's names are not cut", async ({
    page,
  }) => {
    // protects: a mark showing only its code ("F-06") carries the code with the name as its tooltip, and the side list's
    // names wrap rather than end in "…"
    // fails_when: the mark has no title naming the feature, or a side-list name is cut
    await openPriorities(page, 'value-effort');
    const mark = page
      .getByTestId('vxe-point')
      .filter({ has: page.getByTestId('vxe-name').filter({ hasText: 'Weekly alert digest' }) })
      .first();
    await expect(mark).toHaveAttribute('title', 'F-79 Weekly alert digest');
    const names = page.getByTestId('side-row').getByTestId('prio-title');
    await expect(names.first()).toBeVisible();
    for (const n of await names.all()) {
      const cut = await n.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      );
      expect(cut, `${await n.textContent()} is cut`).toBe(false);
    }
  });
});

test.describe('Goal buckets, desktop', () => {
  test.use({ viewport: DESKTOP });

  test("G6: Archive goal lists the bucket's draft and says where they go without 'The other'", async ({
    page,
  }) => {
    // protects: Archive goal on Faster activation lists every feature the bucket shows (its draft Team invite nudges too),
    // and with none going to another goal the choice reads "They go:"
    // fails_when: the draft is left out, or the dialog says "The other N:" after nothing
    await openPriorities(page, 'buckets');
    await page.getByRole('button', { name: 'More for Faster activation' }).first().click();
    await page.getByRole('menuitem', { name: 'Archive goal' }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive Faster activation' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByTestId('goal-feature').filter({ hasText: 'Team invite nudges' }),
    ).toHaveCount(1);
    const n = await dialog.getByTestId('goal-feature').count();
    await expect(dialog).toContainText(`It holds ${n} features`);
    await expect(dialog.getByText(/^The other \d+:$/)).toHaveCount(0);
    await expect(dialog.getByText('They go:', { exact: true })).toBeVisible();
  });
});

test.describe('Goal map, desktop', () => {
  test.use({ viewport: DESKTOP });

  test('G1: Rename on a goal with no date opens its edit form in Goal buckets, its name in focus', async ({
    page,
  }) => {
    // protects: a goal's ⋯ > Rename on the Goal map, for a goal with no date, opens that goal's ✎ form on Goal buckets
    // so the date is asked in the same step, and the rename saves
    // fails_when: Rename edits the name in place and the save is refused ("A goal needs a measure, a target and a date")
    await login(page);
    await page.goto('/simple/goals');
    await expect(page.getByTestId('gm-grid')).toBeVisible();
    await page.locator('[data-testid^="gm-menu-g-"]').first().click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    // The ?edit= link opens the form once and then leaves the URL at once (flakes-dates), so the
    // page is checked by its path and the open form, never by a link that is already gone.
    await expect(page).toHaveURL(/\/simple\/priorities\?tab=buckets/);
    await expect(page.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
    const name = page.getByRole('textbox', { name: 'Goal', exact: true });
    await expect(name).toBeFocused();
    await name.fill('Sign-ups per rep each day');
    // The date is asked here (and a measure or target, when the goal lacks one).
    const measure = page.getByLabel('Measure: the number that shows it');
    if (!(await measure.inputValue())) await measure.fill('sign-ups per rep per day');
    const target = page.getByLabel('Target', { exact: true });
    if (!(await target.inputValue())) await target.fill('40');
    const by = page.getByLabel('By', { exact: true });
    if (!(await by.inputValue())) await by.fill('Dec 31');
    await page.getByRole('button', { name: 'Save goal' }).click();
    await expect(page.getByRole('heading', { name: 'Edit goal' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign-ups per rep each day' })).toBeVisible();
  });

  test("G2: a feature's panel from the Goal map places it in one of its goal's milestones", async ({
    page,
  }) => {
    // protects: Milestone > Change in the panel opened from a Goal map chip saves a milestone the picker offers
    // fails_when: the save is refused with "That milestone is not on this item's roadmap."
    await login(page);
    await page.goto('/simple/goals');
    await expect(page.getByTestId('gm-grid')).toBeVisible();
    await page
      .getByTestId('gm-chip')
      .filter({ hasText: 'Rep call script hints' })
      .first()
      .getByRole('button')
      .first()
      .click();
    const panel = page.getByTestId('floating-card');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Change the milestone' }).click();
    const picker = panel.getByLabel('Milestone', { exact: true });
    const option = picker
      .locator('option')
      .filter({ hasText: /^M1 25 sign-ups per rep/ })
      .first();
    await picker.selectOption((await option.getAttribute('value'))!);
    await expect(page.getByText("That milestone is not on this item's roadmap.")).toHaveCount(0);
    await expect(panel.getByTestId('card-milestone')).toContainText('25 sign-ups per rep');
  });

  test("G5: a chip's milestone line wraps rather than ending in '…'", async ({ page }) => {
    // protects: on the Goal map, each feature chip's milestone words are readable in full (up to two lines)
    // fails_when: a chip's milestone line is cut on one line
    await login(page);
    await page.goto('/simple/goals');
    const lines = page.getByTestId('gm-chip-ms');
    await expect(lines.first()).toBeVisible();
    for (const l of await lines.all()) {
      const cut = await l.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      );
      expect(cut, `${await l.textContent()} is cut`).toBe(false);
    }
  });
});

test.describe('Priorities, phone', () => {
  test.use({ viewport: PHONE });

  test("G7: a Goal buckets row keeps its ✎ and ⋯ on the name's line", async ({ page }) => {
    // protects: at 390 a bucket row's edit and more buttons sit beside the feature's name
    // fails_when: ✎ and ⋯ wrap to a line under the name
    await openPriorities(page, 'buckets');
    const row = page
      .getByTestId('plan-feature')
      .filter({
        has: page.getByTestId('plan-feature-name').filter({ hasText: 'Weekly alert digest' }),
      })
      .first();
    const name = (await row.getByTestId('plan-feature-name').boundingBox())!;
    const more = (await row.getByRole('button', { name: /^More for / }).boundingBox())!;
    const mid = more.y + more.height / 2;
    expect(mid).toBeGreaterThanOrEqual(name.y - 4);
    expect(mid).toBeLessThanOrEqual(name.y + name.height + 4);
  });

  test("G9: a ranked row's title keeps its width; the pill drops under it", async ({ page }) => {
    // protects: at 390 a ranked row's name wraps as words do, never one word per line beside its pill and ⋯
    // fails_when: a title of three or more words takes more than two lines
    await openPriorities(page);
    const rows = page
      .getByTestId('prio-row')
      .filter({ has: page.getByTestId('prio-name').getByTestId('cs-mark') });
    await expect(rows.first()).toBeVisible();
    let checked = 0;
    for (const r of await rows.all()) {
      const title = r.getByTestId('prio-title');
      const words = ((await title.textContent()) ?? '').trim().split(/\s+/).length;
      if (words < 3) continue;
      const [height, line] = await title.evaluate((el) => {
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight);
        return [
          el.getBoundingClientRect().height,
          Number.isNaN(lh) ? parseFloat(cs.fontSize) * 1.4 : lh,
        ];
      });
      expect(height, `${await title.textContent()} wraps a word per line`).toBeLessThanOrEqual(
        line * 2 + 2,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
