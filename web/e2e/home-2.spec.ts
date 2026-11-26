import { HOME_MILESTONES_SCENARIO } from '../lib/api/mock/home-milestones';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';

import { ADMIN, login, signOut } from './helpers';
import { expect, test, type Page } from './test';

import type { Locator } from '@playwright/test';

/*
 * home-2 (issues 1892, 1896, 1897, 1899, 1900), driven through Simple's Home on the mock's
 * invented data, desktop.
 *
 * 1892: protects = a goal card's status reads the Goal map's one rule (its value against its
 * target, at risk below three quarters of it); fails_when = Home says At risk for a goal measured
 * at 80% because one of its items has a broken link, or On track for one at 40%.
 * 1896: protects = every milestone whose items end after its date warns with the count, each
 * item opening its panel; fails_when = only the commitments past the chart's edge warn.
 * 1897: protects = a milestone with no date says "No date" and has the pencil, which sets its
 * date; fails_when = no date, no pencil.
 * 1899: protects = the Welcome ticks each step already done and is gone once all are;
 * fails_when = three bare numbers on a company that is set up.
 * 1900: protects = Since your last visit lists what others changed, the item named by its code
 * and opening its panel; fails_when = "You ..." rows, or the item's name as plain text.
 */

test.use({ viewport: { width: 1512, height: 756 } });

const scenario = (page: Page, value: string) =>
  page
    .context()
    .addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, value] as const);

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/simple');
  await expect(page.getByTestId('home-sentence')).not.toHaveText('Checking what waits on you…');
}

/** A link inside a line of text reads in the line's own weight and line height. */
async function readsAsItsLine(link: Locator) {
  const [own, line] = await link.evaluate((el) => {
    const pick = (e: Element) => {
      const c = getComputedStyle(e);
      return [c.fontWeight, c.lineHeight, c.fontSize];
    };
    return [pick(el), pick(el.parentElement!)];
  });
  expect(own).toEqual(line);
}

test('1892: a goal card reads the Goal map rule, whatever its items', async ({ page }) => {
  await scenario(page, 'home-goal-status');
  await login(page);
  await page.goto('/simple');
  const goals = page.getByTestId('home-goal');
  const retention = goals.filter({ hasText: 'Grow retention' });
  // 160 of 200: on track, though its digest has a broken link.
  await expect(retention.getByTestId('home-goal-path')).toHaveText(/^Now 160 teams/);
  await expect(retention.getByTestId('home-goal-status')).toHaveText('On track');
  // $20,000 of $50,000: at risk, though none of its items is.
  await expect(
    goals.filter({ hasText: 'Faster activation' }).getByTestId('home-goal-status'),
  ).toHaveText('At risk');
  // The guardrail at 15, past its 10 at most: broken, so never Met (the Goal map's held rule).
  await expect(
    goals.filter({ hasText: 'Keep alerts quiet' }).getByTestId('home-goal-status'),
  ).toHaveText('At risk');
});

test('1896: every milestone whose items end after its date warns, each item opening its panel', async ({
  page,
}) => {
  await scenario(page, 'simple-home');
  await login(page);
  await page.goto('/simple');
  const late = page.getByTestId('home-plan').getByTestId('home-strip-late');
  await expect(late).toHaveCount(1);
  await expect(late).toHaveText(/^M1 · Beta: 1 ends after Nov 30:\s*F-79 Weekly alert digest$/);
  await readsAsItsLine(late.getByTestId('home-strip-late-item'));
  await late.getByRole('button', { name: 'F-79 Weekly alert digest' }).click();
  await expect(page.getByTestId('item-panel')).toBeVisible();
  await expect(page.getByTestId('item-panel')).toContainText('Weekly alert digest');
});

test('1897: a milestone with no date says so and its pencil sets the date', async ({ page }) => {
  await scenario(page, HOME_MILESTONES_SCENARIO);
  await login(page);
  await page.goto('/simple');
  const line = page
    .getByTestId('home-plan')
    .getByTestId('home-strip-line')
    .filter({ hasText: /^M\d+ · Launch \(beta\) · 3 items/ });
  await expect(line.getByTestId('home-strip-no-date')).toHaveText('No date');
  await expect(line.getByTestId('home-strip-diamond')).toHaveCount(0);
  await line.getByRole('button', { name: 'Edit M9 · Launch (beta)' }).click();
  const card = page.getByTestId('ms-card');
  await card.getByLabel('Date').fill('2026-12-18');
  await card.getByTestId('ms-save').click();
  await expect(card).toHaveCount(0);
  // Dated, it takes its code in date order.
  await expect(line.getByTestId('home-strip-no-date')).toHaveCount(0);
  await expect(line.getByTestId('home-strip-row')).toContainText('Dec 18');
  await expect(line.getByTestId('home-strip-diamond')).toHaveCount(1);
});

test('1899: the Welcome ticks each step done and is gone once all are', async ({ page }) => {
  const email = 'new.owner@example.com';
  await login(page);
  await page.goto('/settings/members');
  const form = page.getByRole('form', { name: 'Invite' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Role', { exact: true }).selectOption('owner');
  await form.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(page.getByTestId('invite-outcome')).toHaveText(`Invite sent to ${email}`);
  await signOut(page);
  await signIn(page, email);
  const welcome = page.getByTestId('simple-page').getByTestId('home-welcome');
  await expect(welcome).toBeVisible();
  const steps = welcome.getByTestId('welcome-step');
  // The company has sources and members already: those two are ticked; their own tools are not connected.
  await expect(
    steps.filter({ hasText: 'Connect your tools' }).getByTestId('welcome-step-done'),
  ).toHaveCount(0);
  await expect(
    steps.filter({ hasText: 'Pick your sources' }).getByTestId('welcome-step-done'),
  ).toHaveCount(1);
  await expect(
    steps.filter({ hasText: 'Invite your team' }).getByTestId('welcome-step-done'),
  ).toHaveCount(1);
  await page.goto('/settings/connections');
  const slack = page.getByTestId('connection-card-slack');
  await slack.getByRole('button', { name: 'Paste a token' }).click();
  await slack.getByLabel('Token', { exact: true }).fill('example-slack-1234');
  await slack.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(slack.getByText('Connected with a token')).toBeVisible();
  await page.goto('/simple');
  await expect(page.getByTestId('home-sentence')).not.toHaveText('Checking what waits on you…');
  await expect(
    page.getByTestId('home-goal').or(page.getByTestId('home-plan')).first(),
  ).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

test("1900: since your last visit lists others' changes, the item named and opening its panel", async ({
  page,
}) => {
  await scenario(page, 'simple-home');
  await signIn(page, ADMIN.email);
  // Theo Brandt's proposal on the digest, accepted: his change.
  await page
    .getByTestId('home-proposal')
    .filter({ hasText: 'Weekly alert digest' })
    .filter({ hasText: 'Theo Brandt' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Accepted' })).toBeVisible();
  // A change of my own: no row.
  await page
    .getByTestId('home-plan')
    .getByTestId('home-broken')
    .filter({ hasText: /^Weekly alert digest: [^]*which it depends on/ })
    .getByRole('button', { name: 'Move the dependents', exact: true })
    .click();
  await expect(page.getByText('Dependents moved in your working draft')).toBeVisible();
  const since = page.getByTestId('home-since');
  // Another person's: the item by its code and name, opening its panel.
  const theirs = since
    .getByTestId('home-since-row')
    .filter({ hasText: /^Theo Brandt added the task .+ to F-79 Weekly alert digest/ });
  await expect(theirs).toHaveCount(1);
  for (const text of await since.getByTestId('home-since-row').allInnerTexts())
    expect(text).not.toMatch(/^You\b/);
  await readsAsItsLine(theirs.getByTestId('home-since-item'));
  await theirs.getByRole('button', { name: 'F-79 Weekly alert digest' }).click();
  await expect(page.getByTestId('item-panel')).toBeVisible();
  await expect(page.getByTestId('item-panel')).toContainText('Weekly alert digest');
});
