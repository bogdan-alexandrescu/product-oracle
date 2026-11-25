import { login } from './helpers';
import { expect, test } from './test';

/**
 * #1787: the PRDs' list has one name on both sides, the one Simple's rail uses (One-pagers):
 * Detailed's rail opens it under that name, its page's H1 says it, a PRD's crumb goes back to
 * it, and Simple's rail says the same.
 */

test('the PRD list is One-pagers in Detailed and in Simple', async ({ page }) => {
  await login(page);
  await page.goto('/home');
  const rail = page.getByTestId('nav-prds');
  await expect(rail).toHaveAccessibleName('One-pagers');
  await rail.click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'One-pagers', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('PRDs', { exact: true })).toHaveCount(0);

  await page.goto('/documents/referral-link/publish');
  const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumb.getByRole('link', { name: 'One-pagers' })).toHaveAttribute(
    'href',
    '/documents',
  );

  await page.goto('/simple');
  await expect(page.getByTestId('simple-nav-one-pagers')).toHaveAccessibleName('One-pagers');
});
