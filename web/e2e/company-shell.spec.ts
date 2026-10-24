import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/*
 * H1's Company shell: the rail item and its tab strip, which H4, H2 and H8 add their tabs to.
 * Each test states its card: protects / fails_when / no_claim.
 */

test("the rail places Company after Inbox, just above Settings; it lands on Strategy with both highlighted", async ({ page }) => {
  // protects=the rail order Home, Requests, Baseline, PRDs, Priorities, Plan, Runs, Inbox,
  // Company, then Settings (owner, 2026-10-21, "Rail order"); clicking Company lands on /company/strategy (its first tab, H4) with
  // Company current and the Strategy tab selected, H8's Updates tab after Decisions for an owner; fails_when=Company is missing, out of
  // order, or not highlighted on its pages; no_claim=none beyond protects (F1 renamed Roadmap to Plan).
  await login(page);
  const nav = page.getByTestId("app-nav");
  // The rail draws its items once the role's capabilities load; read them after that.
  await expect(nav.getByTestId("nav-settings")).toBeVisible();
  const ids = await nav.locator("a[data-testid^='nav-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(ids.filter((id) => id !== "nav-brand")).toEqual([
    "nav-home",
    "nav-requests",
    "nav-baseline",
    "nav-prds",
    "nav-priorities",
    "nav-plan",
    "nav-runs",
    "nav-inbox",
    "nav-company",
    "nav-settings",
  ]);
  await expect(nav.getByTestId("nav-company")).toHaveText("Company");
  await nav.getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Company" })).toBeVisible();
  await expect(nav.getByTestId("nav-company")).toHaveAttribute("aria-current", "page");
  const tabs = page.getByRole("navigation", { name: "Company" });
  await expect(tabs.getByTestId("company-tab-strategy")).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link")).toHaveText(["Strategy", "Decisions", "Rituals", "Updates", "Metrics"]);
});

test("phone: Company is in the More sheet and the page never scrolls sideways", async ({ page }) => {
  // protects=at 390 px the tab bar keeps Home, PRDs, Plan, Inbox, More and Company opens
  // from the More sheet; the Company page fits the width; fails_when=Company takes a tab or
  // the page overflows; no_claim=Chromium's layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const bar = page.getByTestId("tab-bar");
  await expect(bar.getByText("Company", { exact: true })).toHaveCount(0);
  await bar.getByTestId("tab-more").click();
  const more = page.getByRole("dialog", { name: "More" });
  await more.getByRole("link", { name: "Company" }).click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await expect(page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-strategy")).toBeVisible();
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
});
