import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * protects=the mock answers Write the digest with Oracle in the API's order
 * (oracle.rituals.summaries.on_demand): the pre-read's readiness, then a summary already
 * being written, then H11 market at Observe; fails_when=a person who asks while another
 * tab's digest is being written, after the market was set to Observe, reads the Observe
 * refusal instead of "Oracle is already writing this summary"; no_claim=the API's own
 * order (test_market_digest.py, test_ritual_summaries.py).
 *
 * Three tabs, each signed in as the owner: tab A keeps the occurrence open with its
 * button; tab B starts the digest (its clock paused, so it never reads again and the run
 * stays under way); tab C sets Watch the market to Observe; then tab A asks.
 */

test.use({ timezoneId: "America/New_York", locale: "en-US" });

const ASK = "Write the digest with Oracle";

async function openDigest(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "market"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-rituals").locator("tr[data-row]").filter({ hasText: "Pre-read ready · Monthly competitive digest" });
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  return page.getByTestId("occurrence-summary");
}

test("asking while another tab's digest is being written says so, even at Observe", async ({ context }) => {
  const a = await context.newPage();
  const summaryA = await openDigest(a);
  await expect(summaryA.getByRole("button", { name: ASK })).toBeVisible();

  const b = await context.newPage();
  await login(b);
  await b.goto(a.url());
  const summaryB = b.getByTestId("occurrence-summary");
  await expect(summaryB.getByRole("button", { name: ASK })).toBeVisible();
  // Tab B's clock is paused and moved on 100 ms at a time (the mock answers after 60 ms)
  // only until the run shows: its look-again timer (every second) never fires, so the
  // run stays under way.
  await b.clock.pauseAt(new Date((await b.evaluate(() => Date.now())) + 1_000));
  await summaryB.getByRole("button", { name: ASK }).click();
  const writing = summaryB.getByText("Writing the digest…");
  for (let i = 0; i < 9 && !(await writing.isVisible()); i++) await b.clock.runFor(100);
  await expect(writing).toBeVisible();
  await b.close();
  await context.clock.resume();

  const c = await context.newPage();
  await login(c);
  await c.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await c.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(c.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  const market = c.getByTestId("autonomy-row-market");
  await market.getByRole("group").getByRole("button", { name: "Observe", exact: true }).click();
  const sheet = c.getByRole("dialog", { name: "Change Watch the market" });
  await sheet.getByLabel("Why").fill("Digest order test");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(market.getByRole("group").getByRole("button", { name: "Observe", exact: true })).toHaveAttribute("aria-pressed", "true");
  await c.close();

  await summaryA.getByRole("button", { name: ASK }).click();
  await expect(summaryA).toContainText("Oracle is already writing this summary");
  await expect(summaryA).not.toContainText("Oracle does not write the digest at Observe");
});
