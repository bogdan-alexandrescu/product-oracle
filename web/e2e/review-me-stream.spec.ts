import { expect, test } from './test';

import { login, pickZone } from './helpers';

/**
 * trainag-mock-fixes-3 review: a new GET /v1/me answer lands at once. Under Next, me.tsx
 * waited for the first page's streamed boundaries; every page is drawn in the browser now
 * (#1581), so that wait and Next's React check are gone, and this is what stays.
 */

// protects: a new GET /v1/me answer lands at once: the new Company time zone shows on the
// next page right away.
// fails_when: an answer waits (up to 5 s under Next's boundary wait) before it is drawn.
// no_claim: the first page's own load (qa3-docs-new).
test('after the first page, a new time zone shows at once on the next page', async ({ page }) => {
  await login(page);
  await page.goto('/settings/company');
  await pickZone(page, 'Pacific/Auckland');
  await page.getByTestId('timezone-panel').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('timezone-panel').getByRole('status')).toHaveText('Saved');
  await page
    .getByTestId('settings-nav')
    .getByRole('link', { name: 'Sources', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/sources$/);
  const form = page.getByRole('form', { name: 'Add a source' });
  await form.getByLabel('Kind').selectOption('fireflies');
  await expect(form.getByTestId('fireflies-timezone')).toContainText('Auckland', { timeout: 2500 });
});
