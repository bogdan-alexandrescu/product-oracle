import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Owner's decision (Nov 4): Oracle's cited graph is the Ground Truth. A person walks Detailed >
 * Ground Truth (the nav, the page and tab title, Approve), the run's steps and the Inbox row, and
 * an old /baseline link lands on /ground-truth with its query; no screen says "Baseline" for it.
 * Mock API, "baseline-review" scenario (a Build the Ground Truth run of Oct 20). Made-up data.
 */

const RUN = "7a11c0de-0000-4000-8000-0000000000b2";

/** "Baseline" naming the graph; a goal measure's starting value would read "Baseline value". */
const OLD_NAME = /\bbaseline\b(?! value)/i;

async function seeded(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "baseline-review"] as const);
  await login(page);
}

async function saysNoBaseline(page: Page) {
  await expect(page.locator("main").first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(OLD_NAME);
}

const VIEWS = [
  { name: "desktop light", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  { name: "desktop dark", viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  { name: "390px light", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { name: "390px dark", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
] as const;

for (const view of VIEWS) {
  test.describe(view.name, () => {
    test.use({ viewport: view.viewport, colorScheme: view.colorScheme });
    const phone = view.viewport.width < 600;

    test("the nav, the page and its Approve say Ground Truth", async ({ page }) => {
      await seeded(page);
      if (phone) {
        await page.getByTestId("tab-more").click();
        await page.getByTestId("more-sheet").getByRole("link", { name: "Ground Truth" }).click();
      } else {
        const link = page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-baseline");
        await expect(link).toHaveText("Ground Truth");
        await link.click();
      }
      await expect(page).toHaveURL(/\/ground-truth$/);
      await expect(page.getByRole("heading", { name: "Ground Truth", exact: true })).toBeVisible();
      await expect(page).toHaveTitle(/^Ground Truth/);
      await saysNoBaseline(page);
    });

    test("the Inbox row and its review: Confirm the Ground Truth, Approve the Ground Truth", async ({ page }) => {
      await seeded(page);
      await page.goto("/inbox");
      const row = page.locator("tr[data-row]").filter({ has: page.locator(`a[href="/ground-truth?run=${RUN}"]`) }).filter({ visible: true });
      await expect(row).toContainText("Confirm the Ground Truth");
      await saysNoBaseline(page);
      await row.getByRole("link", { name: "Review" }).click();
      await expect(page).toHaveURL(new RegExp(`/ground-truth\\?run=${RUN}$`));
      await expect(page.getByTestId("from-run-band")).toContainText("Build the Ground Truth");
      await expect(page.getByTestId("from-run-bar").getByRole("button", { name: "Approve the Ground Truth" })).toBeVisible();
      await saysNoBaseline(page);
    });

    test("the run's steps say Ground Truth", async ({ page }) => {
      await seeded(page);
      await page.goto(`/runs/${RUN}`);
      await expect(page.getByText("Ground Truth proposal").filter({ visible: true }).first()).toBeVisible();
      await saysNoBaseline(page);
    });

    test("an old /baseline link lands on /ground-truth with its query", async ({ page }) => {
      await seeded(page);
      await page.goto(`/baseline?run=${RUN}`);
      await expect(page).toHaveURL(new RegExp(`/ground-truth\\?run=${RUN}$`));
      await expect(page.getByTestId("from-run-band")).toContainText("Build the Ground Truth");
      await saysNoBaseline(page);
    });
  });
}
