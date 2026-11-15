import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card call-budget-leaving-page: protects = a page the person is leaving reads nothing again
 * while the next one loads: moving from Home to the Inbox reads the waiting list (Home's and the
 * rail's, one shared read) only the once it was read on Home; fails_when = the page left behind,
 * still drawn once the URL has changed, reads its lists again (GET /v1/simple/decisions/waiting,
 * which only the rail counts on the Inbox); no_claim = the rail's own re-reads after a change.
 */

const WAITING = "GET /v1/simple/decisions/waiting";

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

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

test("moving from Home to the Inbox on a slow network reads the waiting list no more", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("simple-nav-inbox").first()).toBeVisible();
  expect(await settledCalls(page)).toContain(WAITING);
  await page.evaluate(() => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls!.length = 0));
  // A slow network: the Inbox's page arrives a moment after the person clicks.
  await page.route(
    (u) => u.pathname === "/simple/inbox",
    async (r) => {
      await new Promise((done) => setTimeout(done, 3000));
      await r.continue();
    },
  );
  await page.getByTestId("simple-nav-inbox").first().click();
  await expect(page).toHaveURL((u) => u.pathname === "/simple/inbox");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const seen = await settledCalls(page);
  expect(seen).toContain("POST /v1/inbox/seen");
  expect(seen.filter((c) => c === WAITING)).toEqual([]);
});
