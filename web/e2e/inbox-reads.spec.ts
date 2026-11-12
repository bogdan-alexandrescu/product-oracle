import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card inbox-reads-one: protects = one load of the Inbox page reads the whole Inbox once (GET
 * /v1/inbox): recording the visit as my last one (what "new" is measured from) reads nothing
 * back (POST /v1/inbox/seen), so the page's reads end with the first; fails_when = the visit is
 * recorded by reading the Inbox again (GET /v1/inbox?mark_seen=true, after the first ends), or
 * the rail or another part of the page reads it on its own; no_claim = how fast the API answers
 * (api/tests/test_inbox_reads.py pins its statements).
 */

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

/** Waits until no call has been made for a moment (at most a few rounds), then returns them all. */
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

/** The whole Inbox's reads: GET /v1/inbox with or without a query, not its counts or my questions. */
const wholeInbox = (list: string[]) => list.filter((c) => /^GET \/v1\/inbox(\?|$)/.test(c));

for (const path of ["/simple/inbox", "/inbox"]) {
  test(`${path}: one load of the Inbox reads it once, and records the visit`, async ({ page }) => {
    await login(page);
    await page.goto(path);
    await expect(page.getByText(/^\d+ waiting$/).first()).toBeVisible({ timeout: 15_000 });
    const seen = await settledCalls(page);
    expect(wholeInbox(seen)).toEqual(["GET /v1/inbox"]);
    expect(seen.filter((c) => c === "POST /v1/inbox/seen")).toHaveLength(1);
  });
}
