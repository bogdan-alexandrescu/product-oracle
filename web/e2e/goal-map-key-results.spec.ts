import { LADDER_KR_SCENARIO, LADDER_KRS } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * kr-in-goal-map, on the mock's "goal-ladder-key-results" scenario (invented: the ladder's four
 * goals, each with one or two key results, which the API also lists as goals of the map; the
 * milestone "Mobile check-ins weekly for half of teams" is a key result's).
 *
 * Card kr-columns: protects = the Goal map draws the four goals only, Goal 1 to Goal 4, each key
 * result as a line (name and target) in its own goal's card; fails_when = a key result is a goal
 * column ("Goal 5 · ...") or missing from its goal's card.
 * Card kr-milestone: protects = a key result's milestone and its work sit under its goal;
 * fails_when = they show in a column of their own or are lost.
 * Card kr-move: protects = Move to… on that milestone lists the four goals and moves it;
 * fails_when = a key result is offered as a goal or the move does not land.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_KR_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
}

const column = (page: Page, goal: string) => page.getByTestId("ld-column").filter({ has: page.getByTestId("ld-goal").filter({ hasText: goal }) });
async function menu(page: Page, on: Locator, item: string) {
  await on.getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.describe("Goal map: key results sit inside their goal", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("four goal columns, each key result in its own goal's card", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("ld-column")).toHaveCount(4);
    const cards = page.getByTestId("ld-goal");
    await expect(cards).toHaveCount(4);
    for (const [i, goal] of LADDER_KRS.goals.entries()) {
      const card = cards.nth(i);
      await expect(card).toContainText(`Goal ${i + 1}`);
      await expect(card).toContainText(goal);
      const krs = card.getByTestId("ld-goal-kr");
      await expect(krs).toHaveCount(LADDER_KRS.of(goal).length);
      for (const kr of LADDER_KRS.of(goal)) await expect(krs.filter({ hasText: kr })).toContainText(/ of /);
    }
    // No key result is a goal card of its own.
    for (const kr of LADDER_KRS.goals.flatMap((g) => LADDER_KRS.of(g))) await expect(cards.filter({ hasText: kr })).toHaveCount(1);
    await expect(page.getByText("Goal 5")).toHaveCount(0);
  });

  test("a key result's milestone and its work show under its goal, and Move to… still moves it", async ({ page }) => {
    await open(page);
    const [first, second] = LADDER_KRS.goals;
    const goal1 = column(page, first);
    const milestone = goal1.getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone });
    await expect(milestone).toHaveCount(1);
    await expect(goal1.locator("[data-ld-group]").filter({ hasText: LADDER_KRS.milestone }).getByTestId("ld-feature").first()).toBeVisible();

    await page.getByTestId("ld-edit").click();
    await menu(page, milestone, "Move to…");
    const sheet = page.getByTestId("ld-ms-move-sheet");
    await expect(sheet.getByRole("radio")).toHaveCount(4);
    for (const kr of LADDER_KRS.of(first)) await expect(sheet).not.toContainText(kr);
    await sheet.getByText(second).click();
    await page.getByTestId("ld-move-go").click();
    await expect(page.getByRole("status").filter({ hasText: "Moved" })).toContainText(LADDER_KRS.milestone);
    await expect(column(page, second).getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(1);
    await expect(goal1.getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(0);
  });
});
