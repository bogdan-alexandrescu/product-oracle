import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card rail-count-light: protects = a Simple page that does not show the Inbox (Roadmap, Goal
 * map, Priorities, Decisions, Meetings, One-pagers) never reads the whole Inbox (GET /v1/inbox)
 * for the rail's Inbox count: it reads the Inbox's counts alone (GET /v1/inbox/counts), and the
 * count it shows is the Inbox page's "N waiting"; fails_when = the rail reads the whole Inbox,
 * or its count differs from the Inbox's; no_claim = Home, which shows the Inbox's rows itself
 * (the rail shares that read).
 */

const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);
const wholeInbox = (list: string[]) => list.filter((c) => /^GET \/v1\/inbox(\?|$)/.test(c));
const railCount = (page: Page) => page.getByTestId("simple-nav").getByTestId("simple-nav-inbox-count");

/** The Inbox's "N waiting", on its page. */
async function waiting(page: Page): Promise<number> {
  const shown = page.getByText(/^\d+ waiting$/).first();
  await expect(shown).toBeVisible({ timeout: 15_000 });
  return Number((await shown.textContent())!.split(" ")[0]);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

for (const [name, path] of [
  ["Roadmap", "/simple/roadmap"],
  ["Goal map", "/simple/goals"],
  ["Priorities", "/simple/priorities"],
  ["Decisions", "/simple/decisions"],
  ["Meetings", "/simple/meetings"],
  ["One-pagers", "/simple/one-pagers"],
] as const) {
  test(`${name}: the rail's Inbox count reads the counts alone, never the whole Inbox`, async ({ page }) => {
    await login(page);
    await page.goto("/simple/inbox");
    const n = await waiting(page);
    await page.goto(path);
    await expect(railCount(page)).toHaveText(String(n), { timeout: 15_000 });
    const seen = await calls(page);
    expect(wholeInbox(seen)).toEqual([]);
    expect(seen).toContain("GET /v1/inbox/counts");
  });
}

/**
 * Card rail-count-follows: protects = confirming Oracle's dates on Decisions (an item the Inbox
 * counts too) brings the rail's Inbox count down by one at once, without a reload and without
 * reading the whole Inbox; fails_when = the rail keeps the count from before, or reads the whole
 * Inbox to update it.
 */
test("Decisions: confirming dates the Inbox counts brings the rail's count down at once", async ({ page }) => {
  await login(page);
  await page.goto("/simple/decisions");
  const count = railCount(page);
  await expect(count).toHaveText(/^\d+$/, { timeout: 15_000 });
  const before = Number(await count.textContent());
  const dates = page.getByTestId("questions-mine").getByRole("listitem", { name: "Dates to confirm: Alert routing by team" });
  await dates.getByRole("button", { name: "Confirm" }).click();
  await expect(dates).toHaveCount(0, { timeout: 15_000 });
  await expect(count).toHaveText(String(before - 1), { timeout: 15_000 });
  expect(wholeInbox(await calls(page))).toEqual([]);
});
