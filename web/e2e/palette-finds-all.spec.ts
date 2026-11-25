import { ADMIN } from './helpers';
import { palette, paletteBox, pressFind, rows, signIn } from './palette-helpers';
import { expect, test } from './test';

/*
 * build-palette (#1794), re-review round 2: the palette finds what the Roadmap and the Ground
 * Truth show, whichever page holds it: a track's milestone with no goal milestone of its code
 * (Beta), a roadmap item with no code yet (In-app tour), and a confirmed feature on no roadmap
 * (F-12 Referral link). Mock API, invented data.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('A track milestone is found by its code and Enter opens its card on the Roadmap', async ({
  page,
}) => {
  // protects: a roadmap code only a track milestone holds ("Beta") is a palette row
  // fails_when: typing its code gives Nothing matches, or Enter does not open its card
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('Beta');
  const row = rows(page).filter({ hasText: 'Milestone · Roadmap' }).filter({ hasText: 'Beta' });
  await expect(row).toHaveCount(1);
  const code = (await row.textContent())!.match(/M\d+/)![0];
  await paletteBox(page).fill(code);
  await expect(rows(page).filter({ hasText: 'Beta' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page.getByTestId('timeline-milestone-card')).toContainText('Beta');
  await expect(page).toHaveURL(/\/simple\/roadmap$/);
});

test('A roadmap item with no code is found by its name and opens its panel', async ({ page }) => {
  // protects: an item drawn with no code yet is found by name, its panel opened, no "null" shown
  // fails_when: its name gives Nothing matches and Enter offers to add it again
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('In-app tour');
  const row = rows(page).filter({ hasText: 'In-app tour' });
  await expect(row.first()).toContainText('Feature ·');
  await expect(row.first()).not.toContainText('null');
  await page.keyboard.press('Tab');
  await expect(rows(page).filter({ hasText: 'Ask Oracle about In-app tour' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await paletteBox(page).fill('In-app tour');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page.getByTestId('item-panel').first()).toContainText('In-app tour');
});

test('A confirmed feature on no roadmap is found by its code and opens on the Ground Truth', async ({
  page,
}) => {
  // protects: F-12 Referral link, on no roadmap, is a Feature row; Enter opens it on the Ground Truth
  // fails_when: "F-12" gives Nothing matches and Enter offers to add "F-12" as an item
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('F-12');
  const row = rows(page).filter({ hasText: 'Referral link' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Feature · Ground Truth');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/ground-truth\?entity=/);
});
