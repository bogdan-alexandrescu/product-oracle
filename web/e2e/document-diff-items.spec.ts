import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// E3 on the PRD text diff page: under "Changes from v1 to v2", the roadmap items of the two
// versions compared item by item, as a roadmap version's Items tab compares them.
//
// The default mock seeds checkout-redesign v1 and v2 draft items (Guest checkout moved to
// Now, the Shipping step's date removed, Saved addresses new, One-tap wallet pay dropped,
// Cart review unchanged). The "roadmap-diff" scenario: usage-alerts-roadmap v2 adds Spend
// limits, moves Behaviour to Next and drops Usage exports. saved-carts has no draft items.

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const item = (page: Page, title: string) => visible(page, "diff-item").filter({ hasText: title });

// Card prd-diff-items: protects = the PRD diff page says what the new version moves, adds
// and drops in its roadmap items, with the dropped one struck; fails_when = the panel is
// missing, a chip is wrong, the unchanged item shows before it is asked for, or the link to
// the version's Roadmap tab is wrong; no_claim = the real API (mocked; pytest covers the diff).
test("the PRD diff page shows what changed in the roadmap items", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/diff?from=1&to=2");
  const panel = visible(page, "diff-items");
  await expect(panel).toContainText("Roadmap items");
  await expect(visible(page, "diff-items-summary")).toHaveText("Since draft v1: 1 new · 1 dropped · 1 moved · 1 changed");
  await expect(visible(page, "diff-item")).toHaveCount(4);
  await expect(item(page, "Guest checkout").getByTestId("item-change")).toHaveText("Next → Now");
  await expect(item(page, "Shipping step").getByTestId("item-change")).toHaveText("Date removed");
  await expect(item(page, "Saved addresses").getByTestId("item-change")).toHaveText("New");
  const dropped = item(page, "One-tap wallet pay");
  await expect(dropped).toHaveAttribute("data-change", "dropped");
  await expect(dropped.locator("s")).toHaveText("One-tap wallet pay");
  // The unchanged item waits for the Unchanged toggle, as unchanged sections do.
  await expect(item(page, "Cart review")).toHaveCount(0);
  await panel.getByLabel("Show unchanged items").check();
  await expect(item(page, "Cart review")).toHaveCount(1);
  await expect(item(page, "Cart review")).toHaveAttribute("data-change", "unchanged");
  await panel.getByRole("link", { name: "Open items" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/roadmap$/);
});

// Card prd-diff-items-what-changed: protects = each changed item says field by field what
// changed; fails_when = the line is missing or names the wrong values; no_claim = notes order.
test("an item on the diff page lists what changed", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/diff?from=1&to=2");
  await expect(item(page, "Guest checkout")).toContainText("Horizon: Next → Now");
  await expect(item(page, "Shipping step")).toContainText("Date: 30 Nov 2026 → none");
});

// Card roadmap-diff-items: protects = a roadmap's diff page compares its versions' items too,
// in the roadmap's words ("Since v1"); fails_when = the panel is missing or labelled as a
// draft; no_claim = the approved plan (the Items tab's own spec).
test("a roadmap's diff page compares the two versions' items", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "roadmap-diff"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/diff?from=1&to=2");
  await expect(visible(page, "diff-items-summary")).toHaveText("Since v1: 1 new · 1 dropped · 1 moved");
  await expect(item(page, "Spend limits").getByTestId("item-change")).toHaveText("New");
  await expect(item(page, "Behaviour").getByTestId("item-change")).toHaveText("Now → Next");
  await expect(item(page, "Usage exports")).toHaveAttribute("data-change", "dropped");
  await visible(page, "diff-items").getByRole("link", { name: "Open items" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap\/v\/2\/items$/);
});

// Card prd-diff-items-not-ready: protects = a PRD whose version has no roadmap items yet
// says so instead of an error; fails_when = an error note shows or the text diff goes;
// no_claim = drafting the items (E1).
test("a PRD version without roadmap items says so", async ({ page }) => {
  await login(page);
  await page.goto("/documents/saved-carts/diff?from=1&to=2");
  await expect(visible(page, "diff-section").first()).toBeVisible();
  await expect(visible(page, "diff-items")).toContainText("Roadmap items for v2 are not ready yet");
  await expect(visible(page, "diff-item")).toHaveCount(0);
});

// Card prd-diff-items-phone: protects = the panel fits a phone; fails_when = the page scrolls
// sideways; no_claim = chip wrapping details.
test("the items panel fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/documents/checkout-redesign/diff?from=1&to=2");
  await expect(visible(page, "diff-item")).toHaveCount(4);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
