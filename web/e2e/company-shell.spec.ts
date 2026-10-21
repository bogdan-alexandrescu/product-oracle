import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/*
 * H1's Company shell: the rail item and its tab strip, which H4, H2 and H8 add their tabs to.
 * Each test states its card: protects / fails_when / no_claim.
 */

test("the rail places Company after Roadmap; it lands on Decisions with both highlighted", async ({ page }) => {
  // protects=the rail order Home, Requests, Baseline, PRDs, Priorities, Roadmap, Company,
  // Runs, Inbox; clicking Company lands on /company/decisions (its only tab before H4) with
  // Company current and the Decisions tab selected; fails_when=Company is missing, out of
  // order, or not highlighted on its pages; no_claim=Roadmap stands for Plan until F1 renames it.
  await login(page);
  const nav = page.getByTestId("app-nav");
  const ids = await nav.locator("a[data-testid^='nav-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(ids.filter((id) => id !== "nav-brand" && id !== "nav-settings")).toEqual([
    "nav-home",
    "nav-requests",
    "nav-baseline",
    "nav-prds",
    "nav-priorities",
    "nav-roadmap",
    "nav-company",
    "nav-runs",
    "nav-inbox",
  ]);
  await expect(nav.getByTestId("nav-company")).toHaveText("Company");
  await nav.getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/decisions$/);
  await expect(page.getByRole("heading", { level: 1, name: "Company" })).toBeVisible();
  await expect(nav.getByTestId("nav-company")).toHaveAttribute("aria-current", "page");
  const tabs = page.getByRole("navigation", { name: "Company" });
  await expect(tabs.getByTestId("company-tab-decisions")).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link")).toHaveText(["Decisions"]);
});

test("phone: Company is in the More sheet and the page never scrolls sideways", async ({ page }) => {
  // protects=at 390 px the tab bar keeps Home, PRDs, Roadmap, Inbox, More and Company opens
  // from the More sheet; the Company page fits the width; fails_when=Company takes a tab or
  // the page overflows; no_claim=Chromium's layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const bar = page.getByTestId("tab-bar");
  await expect(bar.getByText("Company", { exact: true })).toHaveCount(0);
  await bar.getByTestId("tab-more").click();
  const more = page.getByRole("dialog", { name: "More" });
  await more.getByRole("link", { name: "Company" }).click();
  await expect(page).toHaveURL(/\/company\/decisions$/);
  await expect(page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-decisions")).toBeVisible();
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
});
