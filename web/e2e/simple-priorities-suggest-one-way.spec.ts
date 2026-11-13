import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * PR9 (QA Nov 12, docs/qa/2026-11-12/simple-goalmap.md), the owner's pick of Nov 13: Goal buckets' suggestions
 * drawer offers one way to ask Oracle, "✦ Ask Oracle to suggest"; "✦ Get more from Oracle" and "Ask in the chat"
 * are gone. Driven through the UI on the mock (invented data only), desktop 1440x900.
 * fails_when = the drawer shows "Get more from Oracle" or "Ask in the chat", or has no "Ask Oracle to suggest"
 * that asks Oracle.
 */

async function open(page: Page, scenario: string | null) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
}

test.describe("PR9: Goal buckets' suggestions drawer asks Oracle one way", () => {
  test("a dated plan: the drawer opened from '+ Suggest a feature' has only 'Ask Oracle to suggest', and it asks", async ({ page }) => {
    await open(page, "simple-plan");
    await page.getByTestId("goal-suggest-feature").first().click();
    const drawer = page.getByTestId("goal-panel");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "✦ Get more from Oracle" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Ask in the chat" })).toHaveCount(0);
    const ask = drawer.getByRole("button", { name: "✦ Ask Oracle to suggest" });
    await expect(ask).toHaveCount(1);
    await ask.click();
    await expect(drawer.getByRole("tab", { name: /Oracle/ })).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByTestId("goal-suggestion").first()).toBeVisible({ timeout: 15_000 });
  });

  test("no plan yet: 'See or make suggestions' opens the same drawer, with only 'Ask Oracle to suggest'", async ({ page }) => {
    await open(page, null);
    await page.getByRole("button", { name: "Suggestions for Grow retention" }).click();
    const drawer = page.getByTestId("goal-panel");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("suggest-actions").getByRole("button")).toHaveText(["+ Suggest a feature", "✦ Ask Oracle to suggest"]);
  });
});
