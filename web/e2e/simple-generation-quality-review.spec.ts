import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The generation-quality review's two screens a person sees (oracle.simple.quality), on the
 * mock's invented data (./lib/api/mock/simple-one-pager.ts, simple-suggestions.ts).
 *
 * Card one-pager-not-in-prd: protects = a block Oracle marked "Not in the PRD yet" (nothing
 * of the PRD maps to it; the API's OnePagerBlock.missing) reads "Not in the PRD yet" to the
 * owner and a commenter, scenario "one-pager-not-in-prd"; fails_when = it reads "Not written
 * yet" or is blank; no_claim = when a block may be marked (api
 * tests/test_simple_generation_quality.py).
 *
 * Card suggestion-needs-look: protects = Oracle's suggestion that failed its checks twice
 * shows the owner, on its card in the goal's drawer, a quiet "Needs a look" note naming the
 * failed check, and a commenter does not see that suggestion at all, scenario
 * "simple-suggest-needs-look"; fails_when = the owner gets no note or the held suggestion
 * reaches the commenter; no_claim = the checks themselves (api tests).
 */

async function scenario(page: Page, name: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
}

const HELD = "Weekly team health email";

async function openGrowRetention(page: Page, email?: string) {
  await scenario(page, "simple-suggest-needs-look");
  await login(page, email);
  await page.goto("/simple");
  await page.getByRole("button", { name: "Suggestions for Grow retention", exact: true }).click();
  const drawer = page.getByTestId("goal-panel");
  await expect(drawer).toBeVisible();
  return drawer;
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    for (const email of [undefined, "commenter@example.com"]) {
      test(`a block not in the PRD reads "Not in the PRD yet" (${email ?? "owner"})`, async ({ page }) => {
        await scenario(page, "one-pager-not-in-prd");
        await login(page, email);
        await page.goto("/simple/prds/guided-setup");
        const notDoing = page.getByRole("region", { name: "Not doing" });
        await expect(notDoing.getByTestId("one-pager-empty-block")).toHaveText("Not in the PRD yet");
        await expect(notDoing.getByText("Not written yet")).toHaveCount(0);
      });
    }

    test("the owner reads a held suggestion with a quiet note", async ({ page }) => {
      const drawer = await openGrowRetention(page);
      await drawer.getByRole("tab", { name: "✦ Oracle · 2" }).click();
      const note = drawer.getByTestId("goal-suggestion").filter({ hasText: HELD }).getByRole("note", { name: "Needs a look" });
      await expect(note).toBeVisible();
      await expect(note).toContainText("“Weekly team health email” does not name its goal");
      await expect(drawer.getByTestId("goal-suggestion").filter({ hasText: "Alert templates for new teams" }).getByRole("note")).toHaveCount(0);
    });

    test("a commenter does not see a held suggestion", async ({ page }) => {
      const drawer = await openGrowRetention(page, "commenter@example.com");
      await expect(drawer.getByRole("tab", { name: "✦ Oracle · 1" })).toBeVisible();
      await expect(drawer.getByText(HELD)).toHaveCount(0);
      await expect(drawer.getByRole("note", { name: "Needs a look" })).toHaveCount(0);
    });
  });
}
