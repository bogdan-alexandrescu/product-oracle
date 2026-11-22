import { BEFORE_DRAFTING } from '../lib/api/mock/intake';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * #1678 (follow-up to #1590): the remaining how-to texts on the Detailed pages moved off the
 * page into the (i) beside a short status that stays.
 * protects = each moved text is no longer visible on its page, its short status is, and the
 * text stays readable: clicking its (i) shows it in the tip.
 * fails_when = a moved text is back on the page as plain prose, or its tip is gone or empty.
 */

const VIEWER = 'viewer@example.com';

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** The text is not on the page as visible prose; the (i) named by testId shows it. */
async function behindTip(page: Page, testId: string, text: string) {
  await expect(page.getByText(text).filter({ visible: true })).toHaveCount(0);
  await page.getByTestId(testId).filter({ visible: true }).first().click();
  await expect(page.getByRole('tooltip').filter({ hasText: text, visible: true })).toBeVisible();
  await page.keyboard.press('Escape');
}

test('My account: how Slack gets connected sits behind a tip, for an owner and a viewer', async ({
  page,
}) => {
  await login(page);
  await page.goto('/account');
  const note = page.getByTestId('slack-pings-off');
  await expect(note).toContainText('Slack is not connected yet');
  await expect(note.getByRole('link', { name: 'Settings › Notifications' })).toBeVisible();
  await behindTip(page, 'slack-pings-off-tip', 'Your choices apply once it is.');
});

test('My account as a viewer: who connects Slack sits behind a tip', async ({ page }) => {
  await login(page, VIEWER);
  await page.goto('/account');
  await expect(page.getByTestId('slack-pings-off')).toContainText('Slack is not connected yet');
  await behindTip(page, 'slack-pings-off-tip', 'An owner connects it in Settings › Notifications.');
});

test('Company settings: how to choose another pricing owner sits behind a tip', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings/company');
  await expect(page.getByTestId('pricing-owner-save-reason')).toHaveText(
    'Avery Stone is the only owner',
  );
  await behindTip(
    page,
    'pricing-owner-save-reason-tip',
    'Make another member an owner to choose someone else.',
  );
});

test('Company settings: with no one chosen, who decides prices stays; until when sits behind a tip', async ({
  page,
}) => {
  await scenario(page, 'pricing');
  await login(page);
  await page.goto('/settings/company');
  await expect(page.getByTestId('pricing-owner-save-reason')).toHaveText(
    'Not chosen yet: Avery Stone decides',
  );
  await behindTip(page, 'pricing-owner-save-reason-tip', 'until you pick someone else');
});

test('Publish: that sections are not checks sits behind the Section review tip', async ({
  page,
}) => {
  await login(page);
  await page.goto('/documents/referral-link/publish');
  const review = page.getByRole('region', { name: 'Section review' });
  await expect(review.getByRole('heading', { name: 'Section review' })).toBeVisible();
  await behindTip(
    page,
    'section-review-tip',
    'Sections, not checks: publishing does not wait for them',
  );
});

test("Public version of a PRD: why it has none sits behind the heading's tip", async ({ page }) => {
  await scenario(page, 'sharing');
  await login(page);
  await page.goto('/documents/referral-link/public');
  await expect(page.getByTestId('public-check-not-roadmap')).toContainText(
    'Only a roadmap has a public version',
  );
  await behindTip(page, 'public-version-tip', 'Referral link PRD is a PRD, so it has none.');
});

test('A viewer turned away from a Settings tab: who to ask sits behind the tip', async ({
  page,
}) => {
  await login(page, VIEWER);
  for (const path of ['/settings/analytics', '/settings/trash']) {
    await page.goto(path);
    await expect(page.getByTestId('not-for-role')).toContainText('Not available for your role');
    await behindTip(page, 'not-for-role-tip', 'Ask an owner (Avery Stone) if you need it.');
  }
});

test('Interview: what to do with an unopened link sits behind a tip', async ({ page }) => {
  await login(page);
  await page.goto('/requests/interviews/66952c66-1c80-4e84-84a4-838e1243af88');
  await expect(page.getByTestId('interview-transcript-empty')).toContainText(
    "Ana Lima hasn't opened the link yet.",
  );
  await behindTip(page, 'interview-transcript-tip', "If you didn't send it, make a new link.");
});

test('Brief: what lifts the draft gate sits behind a tip', async ({ page }) => {
  await scenario(page, 'before-drafting');
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByTestId('draft-reason')).toHaveText(
    '4 critical questions open, 1 holds the draft',
  );
  await behindTip(page, 'draft-reason-tip', 'Answer it or record a decision.');
});

test('Digest: the cost stays as one line; what Oracle writes sits behind a tip', async ({
  page,
}) => {
  await scenario(page, 'market');
  await login(page);
  await page.goto('/company/rituals/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b');
  await expect(page.getByTestId('summary-what')).toContainText('One Oracle run, about $7.00');
  await behindTip(
    page,
    'summary-what-tip',
    "Oracle writes this week's digest from the findings below.",
  );
});

test('A viewer: what they may do sits behind tips on composition, New PRD, a run and sources', async ({
  page,
}) => {
  await login(page, VIEWER);

  await page.goto('/documents/annual-billing/composition');
  await expect(page.getByTestId('read-only')).toContainText('Read only');
  await behindTip(
    page,
    'read-only-tip',
    'You can look at this composition and preview a recommendation.',
  );

  await page.goto('/documents/new?kind=prd');
  await expect(page.getByRole('heading', { name: "You can't start a PRD" })).toBeVisible();
  await behindTip(
    page,
    'new-prd-not-allowed-tip',
    'Only commenters, approvers and owners can start a PRD.',
  );

  await page.goto('/runs');
  await page
    .getByTestId('run-row')
    .filter({ hasText: 'Awaiting cost approval' })
    .getByRole('link')
    .first()
    .click();
  await expect(page.getByTestId('run-approval-who').filter({ visible: true })).toContainText(
    'Waiting for an owner to approve $53.00.',
  );
  await behindTip(page, 'run-approval-tip', 'ask an owner of your company to approve it');

  await page.goto('/sources');
  await expect(page.getByTestId('sync-viewer-note').filter({ visible: true })).toContainText(
    'Read only',
  );
  await behindTip(page, 'sync-viewer-tip', 'You can read coverage, but not sync or edit sources.');

  await page.goto('/settings/sources');
  const row = page.getByRole('listitem', { name: 'Legacy all-hands chat' });
  await expect(row.getByTestId('last-error')).toHaveText('Over 100 channels');
  await behindTip(
    page,
    'last-error-tip',
    'Your role cannot edit sources; an approver or owner can.',
  );
});

test('Impact: that an earlier change marked an output stale sits behind the tip', async ({
  page,
}) => {
  await login(page);
  await page.goto('/documents/annual-billing/v/2/impact');
  await expect(
    page.getByText('Preview: v2 marks nothing stale. 1 output is already stale.'),
  ).toBeVisible();
  await behindTip(page, 'impact-intro-tip', 'It was marked stale by an earlier change.');
});
