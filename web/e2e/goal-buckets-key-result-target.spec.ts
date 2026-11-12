import { GOAL_BUCKETS_KR_TARGET_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * goal-target-kept, on Priorities > Goal buckets ("goal-buckets-key-result-target": the invented goal Grow retention
 * with a confirmed key result, Teams read their alerts, whose target is stored as 60 in "%").
 *
 * Card kr-bucket-target: protects = a key result's target stored as a number reads in its unit behind its (i), as the
 * API's goal buckets read it (target and unit from its attrs); fails_when = the key result shows no target.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("Goal buckets: a key result's stored target reads in its unit", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_KR_TARGET_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  const goal = page.locator('[data-testid="plan-goal"][data-goal="Grow retention"]');
  const kr = goal.getByRole("list", { name: "Grow retention's key results" }).getByTestId("goal-kr").filter({ hasText: "Teams read their alerts" });
  await expect(kr).toHaveCount(1);
  await kr.getByTestId("goal-kr-tip").click();
  await expect(page.getByText("Alerts read: 60%")).toBeVisible();
});
