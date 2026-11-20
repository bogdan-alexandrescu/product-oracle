import { expect, test } from './test';

import { login } from './helpers';

// #1572: a cost nobody reported is unknown ("—"), never "$0.00" ("free"): a run cancelled
// before SwarmCloud reported any cost shows its spend as unknown against its estimate, and
// a step's cost reads "Cost not reported yet" until one is reported.

test('a run cancelled before any cost was reported shows its spend as unknown, not $0.00', async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Oracle' })
    .getByRole('link', { name: 'Plan', exact: true })
    .click();
  await page
    .getByTestId('plan-tabs')
    .filter({ visible: true })
    .getByRole('link', { name: 'Roadmap documents' })
    .click();
  await page
    .getByTestId('approved-prd')
    .filter({ hasText: 'Usage alerts PRD' })
    .getByRole('button', { name: 'Build roadmap' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Build roadmap' });
  await dialog.getByRole('button', { name: 'Estimate' }).click();
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  const step = page.getByTestId('segment-roadmap_items').getByTestId('segment-progress');
  await expect(step.getByTestId('segment-cost')).toHaveText('Cost not reported yet');
  const cost = page.getByTestId('run-cost').filter({ visible: true }).first();
  await expect(cost).toHaveText(/^Cost not reported yet · \$[\d,.]+ estimated$/);

  await page.getByTestId('run-cancel').filter({ visible: true }).first().click();
  await page
    .getByRole('alertdialog', { name: 'Cancel run' })
    .getByRole('button', { name: 'Cancel run' })
    .click();
  await expect(page.getByTestId('run-delete').filter({ visible: true }).first()).toBeVisible();
  await expect(cost.getByTestId('run-spent')).toHaveText('—');
  await expect(cost).toHaveText(/^— of \$[\d,.]+ estimated$/);
  await expect(cost).not.toContainText('$0.00');
});
