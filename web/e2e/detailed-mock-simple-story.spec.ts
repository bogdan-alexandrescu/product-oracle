import { expect, test } from './test';

import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';

/**
 * detailed-mock (QA Nov 14 follow-ups): Detailed Priorities tells Simple's story, the same
 * features by the same codes as Simple's plan (Setup checklist F-01, Referral link F-12, ...).
 * Invented data.
 *
 * Card: protects=Detailed Priorities, Ground Truth, PRD list, PRD bodies and Inbox tell Simple's
 * story: its features by its codes and names, its goals, its PRD titles and body words;
 * fails_when=a Simple feature code or name is missing or the count of Priorities rows changes, a
 * goal is not Activation or Growth, a PRD body reads like the older cart, shipping or workspace
 * story, or any older name shows; no_claim=the layout of these pages or any page not named here.
 */
const SIMPLE_FEATURES: [string, string][] = [
  ['F-01', 'Setup checklist'],
  ['F-02', 'Sample data import'],
  ['F-05', 'Team invites'],
  ['F-06', 'Setup error report'],
  ['F-07', 'Bulk import'],
  ['F-08', 'Usage dashboard'],
  ['F-12', 'Referral link'],
  ['F-13', 'Public signup'],
];

test("detailed priorities: every feature is Simple's, by Simple's code and name", async ({
  page,
}) => {
  await login(page);
  await page.goto('/priorities');
  await expect(page.getByRole('heading', { level: 1, name: 'Priorities' })).toBeVisible();
  const rows = page.locator('tr[data-testid^="priority-row-"]');
  await expect(rows).toHaveCount(SIMPLE_FEATURES.length);
  for (const [code, name] of SIMPLE_FEATURES) {
    await expect(
      page.getByTestId(`priority-row-${code}`).getByTestId('feature-name'),
    ).toContainText(name);
  }
  await expect(page.getByText('Saved addresses at checkout')).toHaveCount(0);
});

/**
 * detailed-story: Detailed's Ground Truth tells the same story, its features by Simple's codes and names and its goals
 * by Simple's plan goals (Activation, Growth); none of the older story's names is left. Invented data.
 */
const GROUND_TRUTH_FEATURES: [string, string][] = [
  ['F-01', 'Setup checklist'],
  ['F-02', 'Sample data import'],
  ['F-05', 'Team invites'],
  ['F-06', 'Setup error report'],
  ['F-12', 'Referral link'],
];

test("detailed ground truth: every coded feature is Simple's and the goals are Simple's plan goals", async ({
  page,
}) => {
  await login(page);
  await page.goto('/ground-truth');
  await expect(page.getByRole('heading', { level: 1, name: 'Ground Truth' })).toBeVisible();
  for (const [code, name] of GROUND_TRUTH_FEATURES) {
    await expect(page.getByTestId(`feature-${code}`).getByRole('button', { name })).toBeVisible();
  }
  await expect(page.getByTestId('goal-g.activation')).toContainText('Activation');
  await expect(page.getByTestId('goal-g.paid-conversion')).toContainText('Growth');
  for (const old of [
    'Raise activation',
    'Grow paid conversion',
    'Guided setup',
    'Saved carts',
    'Dark mode',
  ]) {
    await expect(page.getByText(old)).toHaveCount(0);
  }
});

/**
 * detailed-story (review): Detailed's PRDs, discussions and Oracle's actions tell Simple's story too: the PRDs are
 * named for Simple's features and no older story name is left on the PRD list or the Inbox. Invented data.
 */
const OLD_NAMES = [
  'Checkout redesign',
  'Team workspaces',
  'Saved carts',
  'Saved addresses',
  'Guest checkout',
  'One-page checkout',
];

test("detailed PRDs: the PRD list names Simple's features, none of the older story's", async ({
  page,
}) => {
  await login(page);
  await page.goto('/documents');
  for (const prd of ['Annual billing PRD', 'Team invites PRD', 'Referral link PRD']) {
    await expect(page.getByRole('link', { name: prd }).first()).toBeVisible();
  }
  for (const old of OLD_NAMES) await expect(page.getByText(old)).toHaveCount(0);
});

test("detailed inbox: discussions and Oracle's actions name Simple's features", async ({
  page,
}) => {
  await page.addInitScript((key) => localStorage.setItem(key, 'discussions'), MOCK_SCENARIO_KEY);
  await login(page, 'viewer@example.com');
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-discussions').first()).toContainText(
    'F-12 Referral link: keep links for guests?',
  );
  for (const old of OLD_NAMES) await expect(page.getByText(old)).toHaveCount(0);
});

/**
 * detailed-story (re-review): each renamed PRD and its brief tells its Simple feature's story in its body, not only in its
 * title: what a person reads is about yearly prices, invites and referral links, never the older story's carts, shipping
 * or workspaces. Invented data.
 */
const OLD_STORY = /\b(carts?|shipping|shoppers?|workspaces?|checkout|carrier)\b/i;
const BODIES: [string, string, RegExp][] = [
  ['/documents/annual-billing/v/1', 'Annual billing PRD', /yearly price/],
  ['/documents/annual-billing/v/2', 'Annual billing PRD', /yearly price/],
  ['/documents/team-invites/v/2', 'Team invites PRD', /invite teammates/],
  ['/documents/referral-link/v/1', 'Referral link PRD', /referral links? /],
  ['/documents/referral-link/v/2', 'Referral link PRD', /referral links? /],
  ['/documents/annual-billing-early-yearly-price-spec/v/2', 'Early yearly price', /yearly price/],
];

for (const [url, title, story] of BODIES) {
  test(`detailed PRD body: ${url} tells ${title}'s story, none of the older one`, async ({
    page,
  }) => {
    await login(page);
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(title);
    const body = page.getByTestId('document-sections').filter({ visible: true }).first();
    await expect(body).toContainText(story);
    await expect(body).not.toContainText(OLD_STORY);
  });
}
