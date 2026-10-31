import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 4, docs lane: the Publish page. Checkout redesign PRD v2 (default scenario) is held
// by one critical blocker; Usage alerts roadmap v1 is held by a date whose schedule basis was
// withdrawn, and is published in the "approved-plan" scenario. Invented data only.

type Role = "viewer" | "commenter" | "approver" | "owner";

async function open(page: Page, slug: string, role: Role = "owner", scenario?: string) {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, role] as const);
  if (scenario) await page.addInitScript(([sk, s]) => localStorage.setItem(sk, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto(`/documents/${slug}/publish`);
  await expect(page.getByTestId("publish-readiness")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("publish-inspector");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-docs-share-3: a roadmap's Publish page uses roadmap words and its own check, not the PRD checks", async ({ page }) => {
    await open(page, "usage-alerts-roadmap");
    await expect(page.getByTestId("block-row")).toHaveCount(1);
    const lines = inspector(page).getByTestId("on-publish").getByRole("listitem");
    await expect(lines).toContainText(["Roadmap status set to Published"]);
    await expect(inspector(page)).not.toContainText("PRD status");
    await expect(page.getByRole("region", { name: "Advisory" })).toHaveCount(0);
    await expect(page.getByText("Problem and user clarity")).toHaveCount(0);
  });

  test("qa4-docs-share-20: a roadmap shows no 'Hard checks 3' that do not apply; its dates check is shown instead", async ({ page }) => {
    await open(page, "usage-alerts-roadmap");
    await expect(page.getByRole("region", { name: "Hard checks" })).toHaveCount(0);
    const checks = page.getByRole("region", { name: "Checks" });
    await expect(checks).toContainText("Dates backed by a confirmed schedule");
    await expect(checks.getByTestId("dates-check")).toContainText("Fail");
  });

  test("qa4-docs-share-22: a published roadmap's breadcrumb says Published, as the page does", async ({ page }) => {
    await open(page, "usage-alerts-roadmap", "owner", "approved-plan");
    await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb).toContainText("Published");
    await expect(crumb).not.toContainText("Approved");
  });

  test("qa4-docs-share-11: the advisory blocker check does not pass while the hard check has an open critical blocker", async ({ page }) => {
    await open(page, "checkout-redesign");
    await expect(page.locator('[data-testid="hard-check"][data-key="critical_blockers"]')).toHaveAttribute("data-status", "critical");
    const advisory = page.locator('[data-testid="advisory"][data-key="blocker_feasibility"]');
    await expect(advisory).toBeVisible();
    await expect(advisory).not.toHaveAttribute("data-status", "pass");
    await expect(advisory).not.toContainText("Pass");
  });

  test("qa4-docs-share-52: a blocker's Resolve and Open blocker go to the same place", async ({ page }) => {
    await open(page, "checkout-redesign");
    const row = page.getByTestId("block-row").filter({ hasText: "Critical blocker" }).first();
    await row.click();
    const resolve = await row.getByRole("link", { name: "Resolve" }).getAttribute("href");
    const openBlocker = await inspector(page).getByRole("link", { name: "Open blocker" }).getAttribute("href");
    expect(resolve).toContain("tab=blockers");
    expect(resolve).toBe(openBlocker);
  });

  test("qa4-docs-share-54: the disabled Publish is explained in words on the page", async ({ page }) => {
    await open(page, "checkout-redesign");
    await expect(page.getByTestId("publish-button")).toBeDisabled();
    await expect(page.getByText("Publishing waits for 1 critical blocker")).toBeVisible();
  });
});

test.describe("phone", () => {
  test("qa4-docs-share-55: a viewer is told advisory criticals never block publishing", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "checkout-redesign", "viewer");
    const advisory = page.getByRole("region", { name: "Advisory" });
    await expect(advisory).toContainText("critical");
    await expect(advisory.getByText("Advice only: these never block publishing")).toBeVisible();
  });
});
