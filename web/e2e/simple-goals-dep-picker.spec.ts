import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * goals-dep-picker: the feature panel's Add a dependency finds a feature from another PRD by
 * searching its code and name ("Or a feature from another PRD"), never by a raw key a person
 * cannot know. Opened from a one-pager's plan row and from the Goal map. Mock default scenario
 * (invented data): Setup checklist (Guided setup) picks F-79 Weekly alert digest (Usage alerts).
 *
 * Card: protects=Add a dependency finds a feature from another PRD by its code and name, from a
 * one-pager's plan row and from the Goal map, on desktop and phone, and says so when nothing
 * matches; fails_when=the feature is not found by name, a raw key is needed, the dependency is
 * not added, or an empty search saves something; no_claim=the real search index.
 */

const SIZES = [
  { name: '1440', use: { viewport: { width: 1440, height: 900 } } },
  { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

const panel = (page: Page) => page.getByTestId('floating-card');

/** Add a dependency, search "digest", pick F-79 Weekly alert digest, save: Depends on shows it. */
async function addDigestBySearch(page: Page) {
  const deps = panel(page).getByTestId('card-depends');
  await expect(deps).not.toContainText('Weekly alert digest');
  await tap(panel(page).getByRole('button', { name: 'Add a dependency' }));
  // The old raw key box is gone.
  await expect(panel(page).getByPlaceholder(/feature key/)).toHaveCount(0);
  const search = panel(page).getByLabel('Or a feature from another PRD');
  await search.fill('digest');
  const result = panel(page)
    .getByTestId('card-depends-search')
    .getByRole('button', { name: /^F-79\s*Weekly alert digest$/ });
  await expect(result).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Save' })).toBeDisabled();
  await tap(result);
  await expect(result).toHaveAttribute('aria-pressed', 'true');
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(
    deps
      .getByTestId('card-depends-row')
      .getByRole('button', { name: /^F-79\s*Weekly alert digest$/ }),
  ).toBeVisible();
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);

    test("a one-pager's feature panel adds another PRD's feature found by name", async ({
      page,
    }) => {
      await login(page);
      await page.goto('/simple/prds/guided-setup');
      const open = page
        .getByLabel('Timeline strip')
        .getByTestId('plan-strip-item-open')
        .filter({ hasText: 'Setup checklist' });
      await expect(open).toBeVisible();
      await tap(open);
      await expect(panel(page).getByTestId('card-name')).toContainText('Setup checklist');
      await addDigestBySearch(page);
    });

    test("the Goal map's feature panel adds another PRD's feature found by name", async ({
      page,
    }) => {
      await login(page);
      await page.goto('/simple/goals');
      await expect(page.getByTestId('gm-grid')).toBeVisible();
      const chip = page.getByTestId('gm-chip').filter({ hasText: 'One-tap sign-up link' }).first();
      await tap(chip.getByRole('button').first());
      await expect(page.getByTestId('gm-feature-panel')).toBeVisible();
      await addDigestBySearch(page);
    });

    test('a search that matches nothing says so and saves nothing', async ({ page }) => {
      await login(page);
      await page.goto('/simple/prds/guided-setup');
      const open = page
        .getByLabel('Timeline strip')
        .getByTestId('plan-strip-item-open')
        .filter({ hasText: 'Setup checklist' });
      await tap(open);
      await tap(panel(page).getByRole('button', { name: 'Add a dependency' }));
      await panel(page).getByLabel('Or a feature from another PRD').fill('Nothing like this');
      await expect(panel(page).getByTestId('card-depends-search')).toHaveText('No feature matches');
      await expect(panel(page).getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });
}
