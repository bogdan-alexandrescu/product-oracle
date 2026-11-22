import { MOCK_ZONE_STATE_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

// #1677: when the Company time zone cannot be read, a date says the default zone is used
// (a tip beside it), never silently; read as fetched, the date shows alone. Driven on the
// mock layer as a person would: the PRDs list, then a PRD's Inspector.

async function openInspector(page: Page) {
  await login(page);
  await page.goto('/documents');
  const row = page.getByTestId('document-row').filter({ hasText: 'Referral link PRD' });
  await row
    .locator('td')
    .last()
    .click({ position: { x: 4, y: 4 } });
  const inspector = page.getByTestId('document-inspector');
  await expect(inspector).toContainText('Referral link PRD');
  return inspector;
}

test('an unreadable Company time zone is said beside the date', async ({ page }) => {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_ZONE_STATE_KEY,
    'unavailable',
  ] as const);
  const inspector = await openInspector(page);
  await expect(inspector.getByTestId('inspector-updated')).toHaveText(
    /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/,
  );
  const tip = inspector.getByTestId('zone-unavailable').first();
  await expect(tip).toBeVisible();
  await tip.hover();
  await expect(
    page.getByText('Company time zone not available · Pacific is used').first(),
  ).toBeVisible();
});

test('a fetched Company time zone shows the date alone', async ({ page }) => {
  const inspector = await openInspector(page);
  await expect(inspector.getByTestId('inspector-updated')).toBeVisible();
  await expect(inspector.getByTestId('zone-unavailable')).toHaveCount(0);
});
