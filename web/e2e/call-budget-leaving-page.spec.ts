import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * Card call-budget-leaving-page: protects = moving from Home to the Inbox reads the waiting list
 * only the once it was read on Home: the Inbox's broken links take the rail's answer (one shared
 * read), even when the Inbox's page arrives a moment late; fails_when = a part of the Inbox reads
 * GET /v1/simple/decisions/waiting again for itself; no_claim = the reads after an action there.
 */

const WAITING = 'GET /v1/simple/decisions/waiting';

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) =>
  page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

/** Waits until no call has been made for a moment, then returns them all. */
async function settledCalls(page: Page): Promise<string[]> {
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const now = (await calls(page)).length;
    if (now === last) break;
    last = now;
    await page.waitForTimeout(1200);
  }
  return calls(page);
}

test('moving from Home to the Inbox on a slow network reads the waiting list no more', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple');
  await expect(page.getByTestId('simple-nav-inbox').first()).toBeVisible();
  expect(await settledCalls(page)).toContain(WAITING);
  await page.evaluate(
    () => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls!.length = 0),
  );
  // A slow network: the Inbox's page arrives a moment after the person clicks.
  await page.route(
    (u) => u.pathname === '/simple/inbox',
    async (r) => {
      await new Promise((done) => setTimeout(done, 3000));
      await r.continue();
    },
  );
  await page.getByTestId('simple-nav-inbox').first().click();
  await expect(page).toHaveURL((u) => u.pathname === '/simple/inbox');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const seen = await settledCalls(page);
  expect(seen).toContain('POST /v1/inbox/seen');
  expect(seen.filter((c) => c === WAITING)).toEqual([]);
});
