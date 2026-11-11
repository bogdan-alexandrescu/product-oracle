import { LADDER_KR_SCENARIO, LADDER_KRS } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * kr-in-goal-map review fixes, on the mock's "goal-ladder-key-results" scenario (invented: four
 * goals with key results, each named behind its goal's (i) on the Goal map).
 *
 * Card kr-tree-fresh: protects = a key result added on the Ground Truth (another tab) shows behind
 * its goal's (i) after the next edit on the map, with no reload; fails_when = the (i) keeps the old
 * list until the page is reloaded.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_KR_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

const [FIRST] = LADDER_KRS.goals;
const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
/** A map edit: Goal 2's milestone renamed from the milestone strip, through its ⋯ menu. */
async function renameMilestone(page: Page, was: string, to: string) {
  const m = page.getByTestId("gm-strip-milestone").filter({ hasText: was });
  await m.hover();
  await m.getByRole("button", { name: new RegExp(`More for .*${was}`) }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const input = page.getByRole("textbox", { name: `Rename ${was}` });
  await input.fill(to);
  await input.press("Enter");
  await expect(toast(page, `Renamed ${was} to ${to}`)).toBeVisible();
}
/** Goal 1's (i), opened. */
async function firstTip(page: Page) {
  await goal(page, FIRST).getByRole("button", { name: `About ${FIRST}` }).hover();
  return goal(page, FIRST).getByRole("tooltip");
}

test.describe("Goal map: key results after edits", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a key result added on the Ground Truth shows behind its goal's (i) after a map edit", async ({ page }) => {
    await open(page);
    const NEW = "Teams invite a second admin";
    const before = await firstTip(page);
    for (const kr of LADDER_KRS.of(FIRST)) await expect(before).toContainText(kr);
    await expect(before).not.toContainText(NEW);

    // Another tab of the same browser: the Ground Truth, a new confirmed key result under Goal 1.
    const other = await page.context().newPage();
    await other.goto("/ground-truth");
    const parent = other.getByTestId("goal-g.lg1");
    await parent.getByRole("button", { name: "Add subgoal" }).click();
    const add = other.getByRole("form", { name: "Add subgoal" });
    await add.getByLabel("Subgoal title").fill(NEW);
    await add.getByRole("button", { name: "Add" }).click();
    const row = other.getByTestId("goal-g.lg1.teams-invite-a-second-admin");
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Confirm" }).click();
    await expect(row.getByRole("button", { name: "Confirm" })).toHaveCount(0);
    await other.close();

    // Back on the map, no reload: the next edit reads the goals again.
    await renameMilestone(page, "Setup time under two days", "Setup time under a day and a half");
    const after = await firstTip(page);
    await expect(after).toContainText(NEW);
    for (const kr of LADDER_KRS.of(FIRST)) await expect(after).toContainText(kr);
  });
});
