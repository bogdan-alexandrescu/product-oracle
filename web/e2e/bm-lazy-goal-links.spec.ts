import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * A feature moved onto a default goal on Priorities, read on the Roadmap (train BM review), on the
 * mock's "simple-plan" scenario (invented: Guided setup's plan; goals Reliability, Growth,
 * Activation and Revenue; Launch email, PM-owned, serves Growth and has no goal of its own).
 *
 * - moved-goal-reads: protects = once a person moves a feature onto a goal on Priorities' Goal
 *   buckets, the Roadmap's feature panel reads that goal for an item with no goal of its own, and
 *   a goal change's before is that goal (Undo puts it back); fails_when = the panel reads "No goal
 *   yet", or Undo leaves no goal; no_claim = the goals the plan seeded and no person touched (the
 *   Roadmap reads them the same before and after Priorities opens: roadmap-nov10-findings).
 */

const panel = (page: Page) => page.getByTestId("floating-card");
const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);

async function launchEmail(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  await page.getByRole("button", { name: /^Launch email:/ }).click();
  await expect(panel(page).getByTestId("card-goal")).toBeVisible();
}

test.describe("A feature moved onto a goal on Priorities", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("reads that goal in its Roadmap panel, and a goal change's Undo puts it back", async ({ page }) => {
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple/priorities?tab=buckets");
    await expect(page.getByTestId("buckets-head")).toBeVisible();
    const grip = bucket(page, "Growth").locator('[data-code="F-10"]').getByTestId("feature-grip");
    await expect(grip).toHaveAccessibleName("Move Launch email to another goal");
    await grip.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("bucket-live")).toHaveText("Over goal 4, Revenue. Enter drops it there.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bucket-live")).toHaveText("Moved Launch email to Revenue.");
    await expect(bucket(page, "Revenue").locator('[data-code="F-10"]')).toBeVisible();

    await launchEmail(page);
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Revenue");
    await panel(page).getByRole("button", { name: "Change the goal" }).click();
    await panel(page).getByRole("combobox", { name: "Goal" }).selectOption({ label: "Grow retention (measured by Teams active after 90 days)" });
    await panel(page).getByRole("button", { name: "Save" }).click();
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Grow retention");
    await expect(page.getByTestId("toasts")).not.toContainText("Changed since you saw it");
    // The change's before is the goal the panel read: Undo puts Revenue back.
    await page.getByTestId("toasts").getByRole("button", { name: "Undo" }).click();
    await expect(panel(page).getByTestId("card-goal")).toHaveText("Revenue");
  });
});
