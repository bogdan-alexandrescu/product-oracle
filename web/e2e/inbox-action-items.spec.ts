import { login, signOut } from './helpers';
import { expect, test, type Page } from './test';

/**
 * #1817: a meeting's action item reaches its owner's Inbox and can be marked done, driven
 * through the UI on the mock's invented data (./lib/api/mock/action-items.ts).
 *
 * Card action-item-inbox: protects = the minutes editor links an action item to one of the
 * agenda's features; once sent, its owner's Inbox lists it under Needs you with its due date
 * and linked item, and Home lists it too; its owner (an approver) marks it Done, it leaves,
 * and the banner's one Undo brings it back; fails_when = the link is lost, the row never
 * reaches its owner, or Done or Undo does nothing; no_claim = the API's rights
 * (api/tests/test_simple_meeting_action_items.py).
 */

async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

test('an action item reaches its owner, who marks it done once', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto('/simple/meetings');
  await page.getByRole('button', { name: 'Start review' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Start a review' });
  await sheet.getByLabel('PRD').selectOption({ label: 'Guided setup' });
  await sheet.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review: Guided setup' })).toBeVisible();
  await page.getByRole('button', { name: 'End meeting' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End meeting' }).click();
  const minutes = page.getByRole('region', { name: 'Minutes' });
  await minutes.getByRole('button', { name: 'Add action item' }).click();
  await minutes.getByLabel('Action item 1', { exact: true }).fill('Write the checklist copy');
  await minutes.getByLabel('Owner of action item 1').selectOption({ label: 'Priya Raman' });
  await minutes.getByLabel('Due date of action item 1').fill('2026-12-02');
  const link = minutes.getByLabel('Linked item of action item 1');
  const option = link.locator('option', { hasText: 'Setup checklist' });
  await link.selectOption((await option.getAttribute('value')) ?? '');
  await minutes.getByRole('button', { name: 'Save minutes' }).click();
  await expect(minutes.getByRole('button', { name: 'Save minutes' })).toBeDisabled();
  await page
    .getByRole('region', { name: 'Delivery' })
    .getByRole('button', { name: 'Send' })
    .click();
  await expect(page.getByRole('status', { name: 'Sent' })).toBeVisible();

  await page.goto('/home');
  await switchTo(page, 'approver@example.com');
  await page.goto('/simple/inbox');
  const row = page.getByRole('row').filter({ hasText: 'Write the checklist copy' });
  await expect(row).toContainText('Action item');
  await expect(row.getByTestId('action-item-context')).toContainText('Due Dec 2');
  await expect(row.getByTestId('action-item-context')).toContainText('Setup checklist');
  await row.getByRole('button', { name: 'Done: Write the checklist copy' }).click();
  const banner = page.getByTestId('inbox-acted');
  await expect(banner).toContainText('Done: Write the checklist copy');
  await expect(row).toHaveCount(0);
  await banner.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Write the checklist copy' })).toHaveCount(
    1,
  );

  await page.goto('/simple');
  await expect(page.getByText('Action item · Write the checklist copy')).toBeVisible();
});
