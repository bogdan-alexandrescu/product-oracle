import { INBOX_REPLACED_PROPOSAL_SCENARIO } from '../lib/api/mock/inbox-proposal-scenario';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login, signOut } from './helpers';
import { expect, test, type Page } from './test';

/**
 * inbox-2 (#1912, #1913, #1893), on the mock's "meeting-agenda-owner" company, where
 * approver@example.com decides the invented Onboarding roadmap. A commenter asks Oracle to rename
 * its Welcome video and proposes it; then, as the approver in a 1512 x 756 window:
 * - #1912: in the Inbox the proposal's Item cell is the row's widest, and no column header shows;
 * - #1913: the row says the teammate asks to rename it, never "Renamed …" as if done;
 * - #1893: Decisions' Waiting for you lists the same proposal, with Accept and Decline.
 * And #1893 as reported, on "inbox-replaced-proposal": the Owner's Inbox counts an owner change on an
 * item of a replaced PRD, which Decisions' Waiting for you left out ("Nothing waits on you").
 */

test.use({ viewport: { width: 1512, height: 756 } });

async function proposeRename(page: Page) {
  await login(page, 'commenter@example.com');
  await page.goto('/simple');
  await page.getByTestId('simple-ask').first().click();
  const ask = page.getByTestId('ask-chat').filter({ visible: true });
  await ask.getByLabel('Message Oracle').fill('rename Welcome video to Welcome tour');
  await ask.getByRole('button', { name: 'Send' }).click();
  const card = ask.getByTestId('chat-card').filter({ hasText: 'Rename Welcome video' });
  await card.getByRole('button', { name: 'Propose' }).click();
  await expect(card.getByTestId('chat-card-outcome')).toContainText('Proposed to');
  await page.getByTestId('simple-ask').first().click();
  await expect(ask).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  await signOut(page);
  await login(page, 'approver@example.com');
  await page.setViewportSize({ width: 1512, height: 756 });
}

test('a pending proposal reads as a request, has the room in its row and waits on Decisions', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(
    (key) => localStorage.setItem(key, 'meeting-agenda-owner'),
    MOCK_SCENARIO_KEY,
  );
  await proposeRename(page);
  await page.goto('/simple');

  await page.getByTestId('simple-nav').getByRole('link', { name: 'Inbox', exact: true }).click();
  const row = page
    .locator('[role=tabpanel] tr[data-row]')
    .filter({ has: page.getByTestId('meeting-proposal-context') })
    .filter({ hasText: 'Welcome video' });
  await expect(row).toBeVisible();
  // #1913
  const words = row.getByTestId('meeting-proposal-context');
  await expect(words).toContainText(
    /^Theo Brandt asks through Ask Oracle to rename Welcome video to “Welcome tour” · [A-Z][a-z]{2} \d{1,2}/,
  );
  await expect(words).not.toContainText('Renamed');
  // #1912
  const widths = await row.evaluate((r) =>
    [...r.querySelectorAll(':scope > td')].map((td) => td.getBoundingClientRect().width),
  );
  const item = widths[1];
  expect(item, `item ${item} of ${widths.join(', ')}`).toBe(Math.max(...widths));
  for (const name of ['Kind', 'Item', 'For', 'Age'])
    await expect(
      page.getByRole('columnheader', { name, exact: true }).first(),
    ).not.toBeInViewport();

  // #1893
  await page
    .getByTestId('simple-nav')
    .getByRole('link', { name: /^Decisions/ })
    .click();
  const mine = page.getByTestId('questions-mine');
  const waiting = mine.getByRole('listitem').filter({ hasText: 'Renamed Welcome video' });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText('Proposed by Theo Brandt');
  await expect(waiting.getByRole('button', { name: 'Accept' })).toBeVisible();
  await expect(mine).not.toContainText('Nothing waits on you');
});

test('an owner change the Inbox counts for the Owner waits on Decisions too', async ({
  page,
  context,
}) => {
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    MOCK_SCENARIO_KEY,
    INBOX_REPLACED_PROPOSAL_SCENARIO,
  ] as const);
  await login(page);
  await page.goto('/simple');
  await page.getByTestId('simple-nav').getByRole('link', { name: 'Inbox', exact: true }).click();
  await expect(
    page
      .locator('[role=tabpanel] tr[data-row]')
      .filter({ has: page.getByTestId('meeting-proposal-context') })
      .filter({ hasText: 'Trusted seller badge' }),
  ).toBeVisible();

  await page
    .getByTestId('simple-nav')
    .getByRole('link', { name: /^Decisions/ })
    .click();
  const mine = page.getByTestId('questions-mine');
  await expect(
    mine.getByRole('listitem').filter({ hasText: 'Trusted seller badge' }),
  ).toBeVisible();
  await expect(mine).not.toContainText('Nothing waits on you');
});

test('a proposal routed to me that I may not decide opens in the Inbox and Home counts it once', async ({
  page,
  context,
}) => {
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    MOCK_SCENARIO_KEY,
    INBOX_REPLACED_PROPOSAL_SCENARIO,
  ] as const);
  // A meeting's owner change on Block list, routed to the commenter, who may not decide it.
  await login(page, 'commenter@example.com');
  await page.goto('/simple');
  await page
    .getByTestId('simple-nav')
    .getByRole('link', { name: /^Decisions/ })
    .click();
  const row = page
    .getByTestId('questions-mine')
    .getByRole('listitem')
    .filter({ hasText: 'Block list' });
  await expect(row.getByRole('link', { name: 'Open' })).toBeVisible();
  // It opens in Simple's Inbox, keeping Simple's shell.
  await expect(row.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/simple/inbox');
  await expect(row.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  await page.getByTestId('simple-nav').getByRole('link', { name: 'Home', exact: true }).click();
  const also = page.getByTestId('home-also-waiting');
  await expect(also.getByRole('listitem').filter({ hasText: 'Block list' })).toBeVisible();
  // Its row only: never also "1 more in your Inbox", and the card's count is its rows.
  await expect(also.getByTestId('home-inbox-more')).toHaveCount(0);
  const rows = await also.getByTestId('home-also-waiting-list').getByRole('listitem').count();
  await expect(page.getByTestId('home-also-waiting-count')).toHaveText(String(rows));
});
