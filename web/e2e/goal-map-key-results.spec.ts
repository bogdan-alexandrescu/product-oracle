import { LADDER_KR_SCENARIO, LADDER_KRS } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * kr-in-goal-map, on the mock's "goal-ladder-key-results" scenario (invented: the ladder's four
 * goals, each with one or two key results, which the API also lists as goals of the map; the
 * milestone "Mobile check-ins weekly for half of teams" is a key result's).
 *
 * Card kr-columns: protects = the Goal map draws the four goals only as columns, in order, each
 * key result named behind its own goal's (i); fails_when = a key result is a goal column of its
 * own or missing from its goal's (i).
 * Card kr-milestone: protects = a key result's milestone and its work sit under its goal;
 * fails_when = they show in a column of their own or are lost.
 * Card kr-move: protects = Move to… on that work lists the four goals only and moves it;
 * fails_when = a key result is offered as a goal or the move does not land.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_KR_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });
/** The cells of a goal's column (every track row). */
const cells = (page: Page, goalId: string) => page.locator(`[data-testid="gm-cell"][data-goal="${goalId}"]`);
/** A key result's work: "Mobile daily check-in with one tap status for each task" is on its milestone. */
const WORK = "Mobile daily check-in with one tap status for each task";

test.describe("Goal map: key results sit inside their goal", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("four goal columns, each key result behind its own goal's (i)", async ({ page }) => {
    await open(page);
    const columns = page.getByTestId("gm-goal");
    await expect(columns).toHaveCount(4);
    for (const [i, name] of LADDER_KRS.goals.entries()) {
      await expect(columns.nth(i)).toContainText(name);
      await goal(page, name).getByRole("button", { name: `About ${name}` }).hover();
      const tip = goal(page, name).getByRole("tooltip");
      for (const kr of LADDER_KRS.of(name)) await expect(tip).toContainText(kr);
    }
    // No key result is a goal column of its own.
    for (const kr of LADDER_KRS.goals.flatMap((g) => LADDER_KRS.of(g))) await expect(columns.getByTitle(kr, { exact: true })).toHaveCount(0);
  });

  test("a key result's milestone and its work show under its goal, and Move to… still moves it", async ({ page }) => {
    await open(page);
    const [first, second] = LADDER_KRS.goals;
    const g1 = (await goal(page, first).getAttribute("data-goal"))!;
    const g2 = (await goal(page, second).getAttribute("data-goal"))!;
    // The milestone sits on Goal 1's part of the strip; its work in Goal 1's cells.
    await expect(page.getByTestId("gm-strip").locator(":scope > div").nth(0).getByTestId("gm-strip-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(1);
    const onIt = page.getByTestId("gm-chip").filter({ hasText: LADDER_KRS.milestone });
    await expect(onIt.first()).toBeVisible();
    await expect(cells(page, g1).getByTestId("gm-chip").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(await onIt.count());

    const c = cells(page, g1).getByTestId("gm-chip").filter({ hasText: WORK });
    await c.hover();
    await c.getByRole("button", { name: new RegExp(`More for .*${WORK}`) }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    const mover = page.getByRole("dialog", { name: new RegExp(`Move .*${WORK}`) });
    for (const name of LADDER_KRS.goals) await expect(mover).toContainText(name);
    for (const kr of LADDER_KRS.of(first)) await expect(mover).not.toContainText(kr);
    await mover.getByRole("button", { name: /Setup time under two days/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved" })).toContainText(WORK);
    await expect(cells(page, g2).getByTestId("gm-chip").filter({ hasText: WORK })).toHaveCount(1);
    await expect(cells(page, g1).getByTestId("gm-chip").filter({ hasText: WORK })).toHaveCount(0);
  });
});
