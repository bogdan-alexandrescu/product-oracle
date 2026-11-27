import { MOCK_ROLE_KEY } from '../lib/api/mock/server';

import { login, openRoadmapItem } from './helpers';
import { expect, test, type Page } from './test';

/*
 * panel-click-edit (#1905), driven through the feature panel against the mock (invented data):
 * each field's value is the control that opens its editor; no "Change" link on every row.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const panel = (page: Page) => page.getByTestId('floating-card');
const fields = (page: Page) => panel(page).getByTestId('panel-fields');

async function open(page: Page, role?: 'viewer') {
  await page.setViewportSize({ width: 1512, height: 756 });
  if (role)
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
      MOCK_ROLE_KEY,
      role,
    ] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-digest');
  await expect(fields(page)).toBeVisible();
}

test('the value opens its editor by click and by Enter; Esc gives focus back', async ({ page }) => {
  // protects=no field shows a visible "Change"; the owner's value is a button named "Change the
  // owner" that shows a pencil on hover, opens the editor on click and on Enter, and Esc closes
  // the editor (not the panel) with focus back on the value; fails_when=a Change link shows, the
  // value does not open the editor, or focus is lost after Esc; no_claim=what a save changes.
  await open(page);
  await expect(fields(page).getByText('Change', { exact: true })).toHaveCount(0);
  const owner = fields(page).getByTestId('card-owner');
  const value = owner.getByRole('button', { name: 'Change the owner' });
  await expect(value).toBeVisible();
  await expect(value).toHaveCSS('cursor', 'pointer');
  await expect(value.locator('svg')).toBeHidden();
  await value.hover();
  await expect(value.locator('svg')).toBeVisible();

  await value.click();
  const editor = fields(page).getByTestId('card-owner-edit');
  await expect(editor.getByLabel('Owner')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(value).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(editor.getByLabel('Owner')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(value).toBeFocused();

  // A text field's editor (no Esc of its own) closes the same way.
  const outcome = fields(page).getByRole('button', { name: 'Change the outcome' });
  await outcome.focus();
  await page.keyboard.press('Space');
  await expect(fields(page).getByTestId('card-outcome-edit').getByLabel('Outcome')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fields(page).getByTestId('card-outcome-edit')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(outcome).toBeFocused();
});

test('a viewer reads each value as plain text', async ({ page }) => {
  // protects=a viewer's panel has no value button and no pointer on a value; fails_when=a viewer
  // is offered an editor; no_claim=the commenter's proposals (every-field-kr-goal-code.spec.ts).
  await open(page, 'viewer');
  await expect(fields(page).getByRole('button', { name: /^Change the / })).toHaveCount(0);
  await expect(fields(page).getByTestId('card-owner')).not.toHaveCSS('cursor', 'pointer');
  await expect(fields(page).getByText('Change', { exact: true })).toHaveCount(0);
});
