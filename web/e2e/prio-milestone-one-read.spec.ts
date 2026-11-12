import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITIES_PLAN_MILESTONES_SCENARIO } from "../lib/api/mock/simple-milestones";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Card prio-milestone-one-read: protects = a milestone renamed from Priorities > Goal buckets reads the roadmap
 * again once (the page's reads come again together), and Undo once more; fails_when = the milestones' own read
 * runs first and then again with every other read, so each change reads the roadmap twice. Mock scenario
 * "priorities-plan-milestones" (invented data), as the owner. Desktop 1440x900.
 */

const ROADMAP = "GET /v1/simple/roadmap";

/** The calls the in-browser mock API has served since this page loaded. */
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

/** Waits until no call has been made for a moment, then counts the roadmap's reads. */
async function roadmapReads(page: Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const now = (await calls(page)).length;
    if (now === last) break;
    last = now;
    await page.waitForTimeout(1200);
  }
  return (await calls(page)).filter((c) => c === ROADMAP).length;
}

const chip = (page: Page, code: string) => page.getByTestId("buckets-head").getByTestId("milestone-chip").filter({ hasText: new RegExp(`^${code} `) });
const card = (page: Page) => page.getByTestId("ms-prd-card");

test("a milestone renamed from Goal buckets reads the roadmap once, and its Undo once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, PRIORITIES_PLAN_MILESTONES_SCENARIO, THEME_KEY] as const,
  );
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(chip(page, "M2")).toHaveAttribute("title", "M2 Scale volume");
  const first = await roadmapReads(page);

  await chip(page, "M2").getByRole("button", { name: "M2 Scale volume" }).click();
  await card(page).getByLabel("Name", { exact: true }).fill("Grow volume");
  await card(page).getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-toast")).toContainText("Grow volume saved");
  await expect(chip(page, "M2")).toHaveAttribute("title", "M2 Grow volume");
  const renamed = await roadmapReads(page);
  expect(renamed - first, "roadmap reads for one rename").toBe(1);

  await page.getByTestId("ms-toast").getByRole("button", { name: "Undo" }).click();
  await expect(chip(page, "M2")).toHaveAttribute("title", "M2 Scale volume");
  expect((await roadmapReads(page)) - renamed, "roadmap reads for its Undo").toBe(1);
});
