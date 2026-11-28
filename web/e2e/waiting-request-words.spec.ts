import { INBOX_REPLACED_PROPOSAL_SCENARIO } from '../lib/api/mock/inbox-proposal-scenario';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test } from './test';

/**
 * #1913 (reopened after the Nov 27 walk): a change that waits for a decision reads as a request and
 * names its item everywhere it is listed. On the mock's "inbox-replaced-proposal" company (invented
 * data), an owner change on F-46 Block list waits for the commenter; signed in as them:
 * - Home's "Also waiting for you" and Decisions' "Waiting for you" read "<who> asks to change the
 *   owner of F-46 Block list", never "proposed: changed the owner of …";
 * - the Inbox reads the same sentence.
 * The verb table the Inbox and the mock word requests by equals the API's: app/inbox/_request-words.test.ts.
 *
 * Test cards: protects=the waiting rows' request wording with the item named; fails_when=Home or
 * Decisions reads "proposed:", a past tense, or no code; no_claim=deciding it.
 */

const ASKS = /asks to change the owner of F-46 Block list/;

test('a waiting owner change reads as a request naming its item on Home, Decisions and the Inbox', async ({
  page,
  context,
}) => {
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    MOCK_SCENARIO_KEY,
    INBOX_REPLACED_PROPOSAL_SCENARIO,
  ] as const);
  await login(page, 'commenter@example.com');
  await page.goto('/simple');

  const also = page.getByTestId('home-also-waiting');
  const home = also.getByRole('listitem').filter({ hasText: 'Block list' });
  await expect(home).toContainText(ASKS);
  await expect(also).not.toContainText('proposed:');

  await page
    .getByTestId('simple-nav')
    .getByRole('link', { name: /^Decisions/ })
    .click();
  const mine = page.getByTestId('questions-mine');
  const decisions = mine.locator('li[data-kind]').filter({ hasText: 'Block list' });
  await expect(decisions).toContainText(ASKS);
  await expect(mine).not.toContainText('proposed:');

  await page.getByTestId('simple-nav').getByRole('link', { name: 'Inbox', exact: true }).click();
  const inbox = page
    .locator('[role=tabpanel] tr[data-row]')
    .getByTestId('meeting-proposal-context')
    .filter({ hasText: 'Block list' });
  await expect(inbox).toContainText(ASKS);
});
