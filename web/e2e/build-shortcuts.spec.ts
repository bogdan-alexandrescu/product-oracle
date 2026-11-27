import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * #1795, the owner's picks (Nov 24): KS1 B 'Letters after g' (the ? sheet on the right with a
 * search box, this page first, other pages folded; g then a letter goes to a page), KS2 A (the
 * focused row's blue bar and light blue fill), KS3 A 'Esc steps out first' (keys type in a field;
 * Esc leaves the field, a second Esc closes the panel).
 * protects=the app's keys through the UI, as owner, commenter and viewer, Simple and Detailed;
 * fails_when=a key does nothing, acts while typing, or the sheet lists the wrong words for a role;
 * no_claim=the phone (no keys there).
 */

const rows = (page: Page) => page.getByTestId('prio-row');
const sheet = (page: Page) => page.getByTestId('keys-sheet');

async function priorities(page: Page, email?: string) {
  await login(page, email);
  await page.goto('/simple/priorities');
  await expect(rows(page).first()).toBeVisible();
  // Keys act on the page, not on a field.
  await page.locator('body').click({ position: { x: 600, y: 5 } });
}

test.describe('KS1 B: the ? sheet and g then a letter', () => {
  test('? opens the sheet: this page first, Go to, Everywhere, other pages folded; search finds a key', async ({
    page,
  }) => {
    await priorities(page);
    await page.keyboard.press('?');
    await expect(sheet(page)).toBeVisible();
    const groups = sheet(page).getByTestId('keys-group');
    await expect(groups.first()).toContainText('This page · Priorities');
    await expect(groups.first()).toContainText('Next row');
    await expect(sheet(page).getByRole('heading', { name: 'Go to' })).toBeVisible();
    await expect(groups.filter({ hasText: 'Go to' })).toContainText('Roadmap');
    const folded = sheet(page).getByRole('button', { name: /^Roadmap/ });
    await expect(folded).toHaveAttribute('aria-expanded', 'false');
    await folded.click();
    await expect(sheet(page)).toContainText('Next item on the timeline');

    await sheet(page).getByRole('searchbox', { name: 'Find a key' }).fill('goal map');
    await expect(sheet(page).getByTestId('keys-row')).toHaveCount(1);
    await expect(sheet(page).getByTestId('keys-row')).toContainText('Goal map');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();

    // The rail's Keys line opens the same sheet.
    await page.getByTestId('keys-entry').click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Close' }).click();
    await expect(sheet(page)).toBeHidden();
  });

  test('g then r goes to the Roadmap; g then p back to Priorities', async ({ page }) => {
    await priorities(page);
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/simple\/roadmap/);
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/\/simple\/priorities/);
  });

  test('a viewer sees move and add struck out as view only', async ({ page }) => {
    await priorities(page, 'viewer@example.com');
    await page.keyboard.press('?');
    const move = sheet(page).getByTestId('keys-row').filter({ hasText: 'Move the row down' });
    await expect(move).toContainText('View only');
    await expect(move.locator('.line-through')).toHaveText('Move the row down');
  });

  test("a commenter's move reads Suggest a move and add reads Suggest an item", async ({
    page,
  }) => {
    await priorities(page, 'commenter@example.com');
    await page.keyboard.press('?');
    await expect(sheet(page)).toContainText('Suggest a move down');
    await expect(sheet(page)).toContainText('Suggest an item');
    await expect(sheet(page)).not.toContainText('Move the row down');
  });

  test("Detailed's rail has the Keys line above Settings, and ? opens the sheet there", async ({
    page,
  }) => {
    await login(page);
    await page.goto('/priorities');
    const keys = page.getByTestId('app-nav').getByTestId('keys-entry');
    await expect(keys).toBeVisible();
    const k = await keys.boundingBox();
    const s = await page.getByTestId('app-nav').getByTestId('nav-settings').boundingBox();
    expect(k!.y).toBeLessThan(s!.y);
    await keys.click();
    await expect(sheet(page)).toContainText('Switch to Simple');
  });
});

test.describe('KS1 B: timeline rows, c adds, / finds', () => {
  test('on the Roadmap timeline j focuses a row, Enter opens it, c goes to the add box', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/simple/roadmap');
    const tl = page.getByTestId('timeline-row');
    await expect(tl.first()).toBeVisible();
    await page.locator('body').click({ position: { x: 600, y: 5 } });
    await page.keyboard.press('j');
    await expect(tl.first()).toHaveAttribute('data-kfocus', '');
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('item-panel');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await page.locator('body').click({ position: { x: 600, y: 5 } });
    await page.keyboard.press('c');
    await expect(page.locator('#quick-add-title')).toBeFocused();
  });

  test("a timeline row's name says Open Enter", async ({ page }) => {
    await login(page);
    await page.goto('/simple/roadmap');
    await page.getByTestId('timeline-row-label').first().hover();
    const tip = page.getByTestId('key-tip');
    await expect(tip).toContainText('Open');
    await expect(tip).toContainText('Enter');
  });

  test('/ puts the cursor in the search box', async ({ page }) => {
    await login(page);
    await page.goto('/requests');
    const box = page.getByRole('searchbox', { name: 'Search requests' });
    await expect(box).toBeVisible();
    await page.locator('body').click({ position: { x: 600, y: 5 } });
    await page.keyboard.press('/');
    await expect(box).toBeFocused();
  });
});

test.describe('KS2 A: one focused row, a blue bar and a light blue fill', () => {
  test('j and k move the focus; Enter opens the feature panel; Esc closes it', async ({ page }) => {
    await priorities(page);
    await page.keyboard.press('j');
    await expect(rows(page).nth(0)).toHaveAttribute('data-kfocus', '');
    await page.keyboard.press('j');
    await expect(rows(page).nth(1)).toHaveAttribute('data-kfocus', '');
    await expect(rows(page).nth(0)).not.toHaveAttribute('data-kfocus');
    await expect(page.locator('[data-kfocus]')).toHaveCount(1);
    const shadow = await rows(page)
      .nth(1)
      .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).toContain('inset');
    await page.keyboard.press('k');
    await expect(rows(page).nth(0)).toHaveAttribute('data-kfocus', '');

    const name = (await rows(page).nth(0).getByTestId('prio-title').innerText()).trim();
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('item-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(name);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});

test.describe('KS3 A: Esc steps out of the field first', () => {
  test('a letter types in the field; Esc leaves the field and keeps the panel; a second Esc closes it', async ({
    page,
  }) => {
    await priorities(page);
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('item-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Change the notes' }).click();
    const notes = panel.getByRole('textbox', { name: 'Notes' });
    await notes.fill('');
    await notes.focus();
    await page.keyboard.type('jk?g');
    await expect(notes).toHaveValue('jk?g');
    await expect(sheet(page)).toBeHidden();
    await expect(rows(page).nth(0)).toHaveAttribute('data-kfocus', '');

    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await expect(notes).not.toBeFocused();
    await expect(notes).toHaveValue('jk?g');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});

test.describe('KS2 A: keys in the tooltips a person already gets', () => {
  test("the rail's Roadmap tip says g then r; a row's name says Open Enter", async ({ page }) => {
    await priorities(page);
    await page.getByTestId('simple-nav-roadmap').hover();
    const tip = page.getByTestId('key-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('g');
    await expect(tip).toContainText('then');
    await expect(tip).toContainText('r');
    await rows(page).first().getByTestId('prio-title').hover();
    await expect(tip).toContainText('Open');
    await expect(tip).toContainText('Enter');
  });

  test('Shift J moves the focused row down, as its grip does', async ({ page }) => {
    await priorities(page);
    const first = (await rows(page).nth(0).getByTestId('prio-title').innerText()).trim();
    await page.keyboard.press('j');
    await page.keyboard.press('Shift+J');
    // The grip's own question, as a drag asks it; in the dialog a letter goes into its field and
    // nothing behind it moves.
    const dialog = page.getByRole('dialog').filter({ hasText: `Move ${first}` });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('jk');
    await expect(dialog.getByRole('textbox')).toHaveValue('jk');
    await expect(rows(page).nth(0)).toHaveAttribute('data-kfocus', '');
    await expect(sheet(page)).toBeHidden();
    await dialog.getByRole('textbox').fill('A customer asked for it first');
    await dialog.getByRole('button', { name: 'Move' }).click();
    await expect(rows(page).nth(1).getByTestId('prio-title')).toHaveText(first);
  });
});

test.describe('KS3 A on a phone: no keys; previous and next in the feature panel', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the panel steps to the next feature and back, in row order', async ({ page }) => {
    await login(page);
    await page.goto('/simple/priorities');
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByTestId('keys-entry')).toBeHidden();
    const names = rows(page).getByTestId('prio-title');
    const one = (await names.nth(0).innerText()).trim();
    const two = (await names.nth(1).innerText()).trim();
    await names.nth(0).click();
    const panel = page.getByTestId('item-panel');
    await expect(panel).toHaveAttribute('aria-label', one);
    await page.getByRole('button', { name: 'Next feature' }).click();
    await expect(panel).toHaveAttribute('aria-label', two);
    await page.getByRole('button', { name: 'Previous feature' }).click();
    await expect(panel).toHaveAttribute('aria-label', one);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide).toBeLessThanOrEqual(390);
  });
});

test.describe('Ctrl or ⌘ K comes first in the key layer', () => {
  test('Ctrl+K opens the palette even when another handler on the page has already prevented it', async ({
    page,
  }) => {
    await priorities(page);
    // Another handler (an embedded editor, an extension) takes Ctrl+K's default before ours.
    await page.evaluate(() =>
      document.addEventListener(
        'keydown',
        (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') e.preventDefault();
        },
        true,
      ),
    );
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('dialog', { name: 'Find' })).toBeVisible();
  });
});
