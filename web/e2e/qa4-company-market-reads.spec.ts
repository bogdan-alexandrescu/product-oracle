import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * fix4-company review: Market reads the alternatives once for its header's Add alternative,
 * again on the sub-tabs that show it (Alternatives, Change log, Positioning), and not again on
 * Pricing, which has no such button.
 *
 * no_claim: the in-browser mock's call log (__poMockCalls) stands in for the network.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const reads = (page: Page) =>
  page.evaluate(() => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []).filter((c) => c === "GET /v1/competitors").length);
const subTab = (page: Page, name: string) => page.getByRole("tablist", { name: "Market" }).getByRole("tab", { name });

test("Market: opening Pricing reads the alternatives no more", async ({ page }) => {
  // protects=fix4-company review minor (Market reads /v1/competitors on every sub-tab change);
  // fails_when=Pricing reads the alternatives again; no_claim=the API's caching.
  await page.addInitScript((key) => localStorage.setItem(key, "market"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/company/market");
  await expect(subTab(page, "Alternatives")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("alternative-row").first()).toBeVisible();
  await page.waitForTimeout(500);
  const before = await reads(page);
  await subTab(page, "Pricing").click();
  await expect(page).toHaveURL(/tab=pricing/);
  await expect(subTab(page, "Pricing")).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(500);
  expect(await reads(page)).toBe(before);
});
