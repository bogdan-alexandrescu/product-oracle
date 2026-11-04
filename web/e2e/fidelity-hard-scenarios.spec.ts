import { GOAL_BUCKETS_HARD_SCENARIO, MOCK_SCENARIO_KEY, ROADMAP_MILESTONES_HARD_SCENARIO } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Fidelity checks for the mock's two "hard" scenarios, driven through the UI as a person would:
 *
 * mk-goalbuckets gb2-a-hard ("goal-buckets-hard"): Grow partner network holds 15 features over
 * M2 and M3, four of which also serve Growth; Archive goal says "It holds 15 features...".
 *
 * mk-milestones ms1/ms2/ms3-a-hard ("roadmap-milestones-hard"): Grow retention holds 30 items;
 * two of the roadmap's own milestones (Grow retention's M2 and Faster activation's new M2) land
 * on the same day, so the Timeline's axis reads "2 on Dec 22"; an item each of Grow retention's
 * M3 and Faster activation's M2 waits on ends after it ("Ends after M3 ..." and "Ends after
 * M2 ...", desktop only: the chips' exact placement is not asserted on a phone's narrow chart).
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;

async function openScenario(page: Page, viewport: { width: number; height: number }, scenario: string, path: string) {
  await page.setViewportSize(viewport);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto(path);
}

const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);

for (const size of SIZES) {
  test.describe(size.name, () => {
    test("goal-buckets-hard: Archive goal says Grow partner network holds 15 features", async ({ page }) => {
      await openScenario(page, size.viewport, GOAL_BUCKETS_HARD_SCENARIO, "/simple/priorities?tab=buckets");
      await expect(page.getByTestId("buckets-head")).toBeVisible();
      const big = bucket(page, "Grow partner network");
      await expect(big.getByTestId("plan-feature")).toHaveCount(15);
      await expect(big.getByTestId("also-goals")).toHaveCount(4);
      await big.getByRole("button", { name: "More for Grow partner network" }).click();
      await page.getByRole("menuitem", { name: "Archive goal" }).click();
      const dialog = page.getByRole("dialog", { name: "Archive Grow partner network" });
      await expect(dialog).toContainText("It holds 15 features");
      await expect(dialog).toContainText("4 serve another goal too and go there");
    });

    test("roadmap-milestones-hard: Grow retention holds 30 items", async ({ page }) => {
      await openScenario(page, size.viewport, ROADMAP_MILESTONES_HARD_SCENARIO, "/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await expect(page.getByTestId("goal-counter").filter({ hasText: "Grow retention" })).toContainText("30 items");
    });

    if (size.name === "desktop") {
      test("roadmap-milestones-hard: two milestones share Dec 22, each late milestone names what ends after it", async ({ page }) => {
        await openScenario(page, size.viewport, ROADMAP_MILESTONES_HARD_SCENARIO, "/simple/roadmap");
        await expect(page.getByTestId("simple-roadmap")).toBeVisible();
        await expect(page.getByTestId("ms-same-day")).toHaveText("2 on Dec 22");
        await expect(page.getByTestId("ms-late").filter({ hasText: "Ends after M3 Teams set 3 rules in week 1" })).toBeVisible();
        await expect(page.getByTestId("ms-late").filter({ hasText: "Ends after M2 Half of new teams invite a teammate" })).toBeVisible();
      });
    }
  });
}
