import { LADDER_KR_CODES, LADDER_KR_CODES_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * kr-in-goal-map, key results' codes, on the mock's "goal-ladder-key-result-codes" scenario
 * (invented: the key-result ladder, with Goal 2 coded G-B; its key results G-B.1 and G-B.2 each
 * hold one of its milestones; under G-B.1 a proposed key result is older than a confirmed one).
 *
 * Card kr-deeper-code: protects = a key result's own key result is numbered among every sibling,
 * proposed ones too, as the goal tree numbers subgoals: G-B.1.2 when a proposed one is older; it
 * reads with its name behind its goal's (i); fails_when = it reads G-B.1.1 (only confirmed
 * siblings counted), or the proposed one is listed.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_KR_CODES_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("gm-goal").first()).toBeVisible();
}

const C = LADDER_KR_CODES;
const goal = (page: Page) => page.getByTestId("gm-goal").filter({ hasText: C.goal });

test.describe("Goal map: key results' codes", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a key result's own key result is numbered among every sibling, a proposed one too", async ({ page }) => {
    await open(page);
    await goal(page).getByRole("button", { name: `About ${C.goal}` }).hover();
    const tip = goal(page).getByRole("tooltip");
    await expect(tip).toContainText(`G-B.1 ${C.first}`);
    await expect(tip).toContainText(`G-B.2 ${C.second}`);
    // The older proposed key result under G-B.1 is not listed, but keeps its number.
    await expect(tip).not.toContainText(C.proposed);
    await expect(tip).toContainText(`G-B.1.2 ${C.deeper}`);
  });
});
