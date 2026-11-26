import { INBOX_REPLACED_PROPOSAL_SCENARIO } from '../lib/api/mock/inbox-proposal-scenario';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test } from './test';

/**
 * inbox-codes (#1786, reopened Nov 25): "Inbox items still show a feature without its code", on a
 * proposal row. On "inbox-replaced-proposal" (invented data) a commenter's owner change waits on
 * the Owner for Trusted seller badge, an item of a replaced roadmap (no roadmap Simple reads holds
 * it) that came from its PRD's section F-45. Its row in Simple > Inbox and in Detailed > Inbox
 * names it "F-45 Trusted seller badge", the code before the name, as every page does.
 *
 * protects=#1786; fails_when=the proposal row names its feature without its code.
 */

test.use({ viewport: { width: 1500, height: 620 } });

for (const path of ['/simple/inbox', '/inbox']) {
  test(`a proposal row on ${path} names its feature with its code`, async ({ page, context }) => {
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      INBOX_REPLACED_PROPOSAL_SCENARIO,
    ] as const);
    await login(page);
    if (path === '/simple/inbox') {
      await page.goto('/simple');
      await page
        .getByTestId('simple-nav')
        .getByRole('link', { name: 'Inbox', exact: true })
        .click();
    } else await page.goto('/inbox');
    await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
    const row = page
      .locator('[role=tabpanel] tr[data-row]')
      .filter({ has: page.getByTestId('meeting-proposal-context') })
      .filter({ hasText: 'Trusted seller badge' });
    await expect(row).toBeVisible();
    await expect(row.locator('.simple-code').first()).toHaveText('F-45');
    await expect(row).toContainText('F-45 Trusted seller badge');
  });
}
