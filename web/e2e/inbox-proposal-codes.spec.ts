import { INBOX_REPLACED_PROPOSAL_SCENARIO } from '../lib/api/mock/inbox-proposal-scenario';
import { ROADMAP_REVIEW_RUN } from '../lib/api/mock/runs';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login, seedRun } from './helpers';
import { expect, test } from './test';

/**
 * inbox-codes (#1786, reopened Nov 25): "Inbox items still show a feature without its code", on a
 * proposal row. On "inbox-replaced-proposal" (invented data) a commenter's owner change waits on
 * the Owner for Trusted seller badge, an item of a replaced roadmap (no roadmap Simple reads holds
 * it) that came from its PRD's section F-45. Its row in Simple > Inbox and in Detailed > Inbox
 * names it "F-45 Trusted seller badge", the code before the name, as every page does, in its item
 * cell and in the request's words under it; so does the Owner's action item on the badge.
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
    // The request's words under it name the badge the same way.
    await expect(row.getByTestId('meeting-proposal-context')).toContainText(
      'F-45 Trusted seller badge',
    );
    // An action item on the badge names it the same way.
    await expect(
      page
        .locator('[role=tabpanel] tr[data-row]')
        .filter({ hasText: 'Check the badge rules' })
        .getByTestId('action-item-context'),
    ).toContainText('F-45 Trusted seller badge');
  });
}

/**
 * Review round: a run's item waiting on the Owner under its checkpoint's row names its feature
 * with its code. The seeded roadmap review's Slack alerts comes from PRD section f-06 here; Budget
 * caps' section is no code, so it stays as its name.
 *
 * protects=#1786; fails_when=the checkpoint child names its feature without its code.
 */
const CODED_REVIEW = {
  run: ROADMAP_REVIEW_RUN.run,
  artifacts: Object.fromEntries(
    Object.entries(ROADMAP_REVIEW_RUN.artifacts).map(([k, v]) => [
      k,
      v.replace('prd_section: alerts-slack,', 'prd_section: f-06,'),
    ]),
  ),
};
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;

for (const path of ['/simple/inbox', '/inbox']) {
  test(`a run's item under its checkpoint on ${path} names its feature with its code`, async ({
    page,
  }) => {
    await login(page);
    await seedRun(page, CODED_REVIEW);
    await page.goto(path);
    const child = (item: string) =>
      page
        .locator(`tr[data-key="${CP}-${item}"]`)
        .filter({ visible: true })
        .getByTestId('child-title');
    await expect(child('slack-alerts')).toHaveText('F-06 Slack alerts');
    await expect(child('slack-alerts').locator('.simple-code')).toHaveText('F-06');
    await expect(child('budget-caps')).toHaveText('Budget caps');
  });
}
