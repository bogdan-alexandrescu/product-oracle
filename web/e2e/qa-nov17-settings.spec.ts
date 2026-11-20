import { expect, test, type Locator } from './test';

import { fakeGoogle } from './google-fake';
import { login } from './helpers';

/*
 * QA pass of Nov 17 on Settings (detailed runs 1 and 7, and the Members missing feature),
 * driven through the UI on the mock's default scenario.
 */

const PHONE = { width: 390, height: 844 };

/** The text fits its box: nothing is cut with "…". */
async function whole(l: Locator) {
  await expect(l).toBeVisible();
  expect(await l.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
}

test("qa-nov17 runs 1: a closed Google sign-in says so, never 'Cannot reach the API.'", async ({
  page,
}) => {
  await fakeGoogle(page, [], { signInClosed: true });
  await login(page);
  await page.goto('/settings/sources');
  const form = page.getByRole('form', { name: 'Add a source' });
  await form.getByLabel('Kind').selectOption('google_docs');
  await form.getByRole('button', { name: 'Choose from Drive' }).click();
  await expect(form).toContainText('Google sign-in was closed');
  await expect(form).not.toContainText('Cannot reach the API.');
});

test("qa-nov17 runs 7: on a phone, a Google account's address wraps whole", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto('/settings/connections');
  await whole(page.locator('[data-testid^="connection-"] span[title="old-drive@example.com"]'));
});

test("qa-nov17 runs 7: on a phone, a source's picked files wrap whole", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto('/settings/sources');
  await whole(page.getByRole('listitem', { name: 'Product docs' }).getByTestId('source-picks'));
});

test('qa-nov17 members: a role change says so, with Undo', async ({ page }) => {
  await login(page);
  await page.goto('/settings/members');
  const role = page.getByLabel('Role for commenter@example.com');
  await role.selectOption('approver');
  const toast = page.getByTestId('toasts');
  await expect(toast).toContainText('Theo Brandt is now an Approver');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(role).toHaveValue('commenter');
  await expect(toast).toContainText('Theo Brandt is a Commenter again');
});
