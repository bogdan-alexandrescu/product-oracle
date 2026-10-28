import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * P3d Cost prominence (owner, 2026-10-19): cost is not a headline. A run shows one small line in
 * its details ("$6.30 of $26.50 est."), with no spend bar and no per-segment cost; cost comes
 * forward only where it needs a decision, the cost approval and the overrun pause.
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1366, height: 820 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

const DOLLARS = /\$\d/;

async function openRuns(page: Page) {
  await login(page);
  // Runs sits under More on a phone; the address works at every size.
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
}

/** Opens the run page of the row for `slug`. */
async function openRun(page: Page, slug: string, heading: string) {
  await openRuns(page);
  await page.locator(`[data-testid="run-row"][data-document="${slug}"]`).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  return page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
}

for (const size of SIZES) {
  test.describe(`at ${size.name} width`, () => {
    test.use({ viewport: size.viewport });

    test("runs list: a dollar figure only on the cost approval and the overrun", async ({ page }) => {
      await openRuns(page);
      const rows = page.getByTestId("run-row");
      // B3: the seed also holds the finished Baseline to PRD run on saved-carts whose agents made the
      // baseline proposals (lib/api/mock/baseline.ts AGENT_RUN), so five runs, as runs.spec.ts counts.
      await expect(rows).toHaveCount(5);
      // Waiting, running and finished rows carry no cost.
      for (const slug of ["team-onboarding", "checkout-redesign", "saved-carts"]) {
        const row = rows.and(page.locator(`[data-document="${slug}"]`));
        await expect(row).toBeVisible();
        await expect(row).not.toContainText(DOLLARS);
        await expect(row.locator("[data-cost]")).toHaveCount(0);
      }
      // The decisions: the estimate awaiting approval, spent of estimate on the overrun, both prominent.
      const approval = rows.and(page.locator('[data-document="usage-alerts-v2"]'));
      await expect(approval.locator('[data-cost="prominent"]')).toHaveText(/^\$[\d,.]+ est\.$/);
      const overrun = rows.and(page.locator('[data-document="team-workspaces"]'));
      await expect(overrun.locator('[data-cost="prominent"]')).toHaveText("$14.20 / $9.00");
    });

    test("run page of a waiting run: one small Cost line in Details, no Cost section, no bar", async ({ page }) => {
      const inspector = await openRun(page, "team-onboarding", "Baseline to PRD");
      await expect(inspector.getByTestId("run-cost-section")).toHaveCount(0);
      await expect(inspector.getByTestId("spend-bar")).toHaveCount(0);
      const details = inspector.getByTestId("run-details");
      const cost = details.getByTestId("run-cost");
      await expect(cost).toHaveText("$6.30 of $26.50 est.");
      await expect(cost).toHaveAttribute("data-cost", "small");
      await expect(details.getByTestId("run-spent")).toHaveText("$6.30");
      await expect(details.getByText("Cost", { exact: true })).toBeVisible();
      // The only figures in the inspector are that line's.
      await expect(inspector.locator("[data-cost]")).toHaveCount(1);
    });

    test("run page of a finished run: the same small line, no section", async ({ page }) => {
      const inspector = await openRun(page, "checkout-redesign", "Feedback loop");
      await expect(inspector.getByTestId("run-cost-section")).toHaveCount(0);
      await expect(inspector.getByTestId("run-details").getByTestId("run-cost")).toHaveText("$8.10 of $9.00 est.");
    });

    test("run page awaiting cost approval: the Cost approval section, prominent, no per-segment cost", async ({ page }) => {
      const inspector = await openRun(page, "usage-alerts-v2", "Baseline to PRD");
      const section = inspector.getByTestId("run-cost-section");
      await expect(section).toContainText("Cost approval");
      await expect(section.locator('[data-cost="prominent"]')).toHaveText(/^\$[\d,.]+ est\.$/);
      await expect(inspector.getByTestId("spend-bar")).toHaveCount(0);
      await section.getByRole("button", { name: "About cost" }).click();
      const tip = section.getByRole("tooltip");
      await expect(tip).toContainText("an owner approves the cost before any agent starts");
      await expect(tip).not.toContainText(/\d\. .+: \$/);
      // The small line in Details stays.
      await expect(inspector.getByTestId("run-details").getByTestId("run-cost")).toHaveText(/ est\.$/);
    });

    test("run page paused on overrun: the Overrun section, prominent, with ceiling, no per-segment cost", async ({ page }) => {
      const inspector = await openRun(page, "team-workspaces", "Feedback loop");
      const section = inspector.getByTestId("run-cost-section");
      await expect(section).toContainText("Overrun");
      await expect(section.locator('[data-cost="prominent"]')).toHaveText("$14.20 / $9.00");
      await expect(inspector.getByTestId("spend-bar")).toHaveCount(0);
      await section.getByRole("button", { name: "About cost" }).click();
      const tip = section.getByRole("tooltip");
      await expect(tip).toContainText("Spend passed $13.50 (1.5× the estimate)");
      await expect(tip).toContainText("Pauses above $13.50.");
      await expect(tip).not.toContainText(/\d\. .+: \$/);
      await expect(inspector.getByTestId("run-details").getByTestId("run-cost")).toHaveText("$14.20 of $9.00 est.");
    });
  });
}
