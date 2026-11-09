import { LADDER_KR_SCENARIO, LADDER_KRS } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * kr-in-goal-map review fixes, on the mock's "goal-ladder-key-results" scenario (invented: four
 * goals with key results; "Mobile check-ins weekly for half of teams" is a milestone of the key
 * result "Half of teams check in from mobile", under Goal 1).
 *
 * Card kr-tree-fresh: protects = a key result added on the Ground Truth (another tab) shows in its
 * goal's card after the next edit on the map, with no reload; fails_when = the card keeps the old
 * list until the page is reloaded.
 * Card kr-current-kept: protects = a key result's current value still shows after the map is
 * drawn again (edits on the map); fails_when = it reads "—".
 * Card kr-feature-stays: protects = a feature taken off a key result's milestone into its own goal
 * ("Not on a key result" in that goal) keeps serving the key result; fails_when = its roadmap item
 * moves onto the goal.
 * Card kr-onto-goal: protects = Move to… moves a key result's milestone onto its own goal;
 * fails_when = the goal is taken as where it already is and nothing moves.
 * Card kr-undo: protects = Undo after a key result's milestone moved to another goal puts it back
 * on its key result; fails_when = it stays on the other goal or lands on the goal itself.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_KR_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
}

const [FIRST, SECOND] = LADDER_KRS.goals;
const column = (page: Page, goal: string) => page.getByTestId("ld-column").filter({ has: page.getByTestId("ld-goal").filter({ hasText: goal }) });
const goalCard = (page: Page, goal: string) => page.getByTestId("ld-goal").filter({ hasText: goal });
const milestone = (page: Page) => page.getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
async function menu(page: Page, on: Locator, item: string) {
  await on.getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
/** A map edit: a new target for Goal 2, through its ⋯ menu (Edit ladder on). */
async function changeTarget(page: Page, to: string) {
  await menu(page, goalCard(page, SECOND), "Change the target");
  const editor = page.getByTestId("gm-editor");
  await editor.getByPlaceholder("Type a number").fill(to);
  await editor.getByTestId("gm-save").click();
  await expect(page.getByTestId("gm-flash")).toContainText("Goal saved");
}

test.describe("Goal map: key results after edits", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a key result added on the Ground Truth shows in its goal's card after a map edit", async ({ page }) => {
    await open(page);
    const krs = goalCard(page, FIRST).getByTestId("ld-goal-kr");
    await expect(krs).toHaveCount(LADDER_KRS.of(FIRST).length);

    // Another tab of the same browser: the Ground Truth, a new confirmed key result under Goal 1.
    const NEW = "Teams invite a second admin";
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
    await page.getByTestId("ld-edit").click();
    await changeTarget(page, "0.8");
    await expect(krs).toHaveCount(LADDER_KRS.of(FIRST).length + 1);
    await expect(krs.filter({ hasText: NEW })).toContainText("No target yet");
  });

  test("a key result's current value stays after the map is drawn again", async ({ page }) => {
    await open(page);
    const line = goalCard(page, FIRST).getByTestId("ld-goal-kr").filter({ hasText: LADDER_KRS.of(FIRST)[0] });
    await expect(line).toContainText("74% of 80%");
    await page.getByTestId("ld-edit").click();
    await changeTarget(page, "0.8");
    await expect(line).toContainText("74% of 80%");
    await changeTarget(page, "0.6");
    await expect(line).toContainText("74% of 80%");
    await expect(line).not.toContainText("—");
  });

  test("a feature taken off a key result's milestone into its own goal keeps serving the key result", async ({ page }) => {
    await open(page);
    const feature = column(page, FIRST).locator("[data-ld-group]").filter({ hasText: LADDER_KRS.milestone }).getByTestId("ld-feature").first();
    const id = (await feature.getAttribute("data-ld-card"))!;
    const card = page.locator(`[data-ld-card="${id}"]`);

    await page.getByTestId("ld-edit").click();
    await menu(page, card, "Move to…");
    const sheet = page.getByTestId("ld-move-sheet");
    // Goal 1's "Not on a key result" (the goals are listed in order).
    await sheet.getByText("Not on a key result").first().click();
    await page.getByTestId("ld-move-go").click();
    await expect(toast(page, "Moved")).toContainText("Not on a key result");
    await expect(column(page, FIRST).getByTestId("ld-free").locator(`[data-ld-card="${id}"]`)).toHaveCount(1);

    await page.getByTestId("ld-edit").click();
    await card.click();
    await card.getByTestId("ld-open").click();
    const panel = page.getByTestId("gm-feature-panel");
    await expect(panel.getByTestId("card-goal")).toHaveText(LADDER_KRS.of(FIRST)[1]);
  });

  test("Move to… moves a key result's milestone onto its own goal", async ({ page }) => {
    await open(page);
    await page.getByTestId("ld-edit").click();
    await menu(page, milestone(page), "Move to…");
    const sheet = page.getByTestId("ld-ms-move-sheet");
    // On its key result: none of the goals is where it is now.
    await expect(sheet).not.toContainText("(now)");
    await sheet.getByText(`Goal 1 · ${FIRST}`).click();
    await page.getByTestId("ld-move-go").click();
    await expect(toast(page, "Moved")).toContainText(`Goal 1 ${FIRST}`);
    await expect(column(page, FIRST).getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(1);

    await menu(page, milestone(page), "Move to…");
    await expect(sheet.getByRole("radio").first()).toBeChecked();
    await expect(sheet.locator("label").first()).toContainText("(now)");
  });

  test("Undo after a key result's milestone moved puts it back on its key result", async ({ page }) => {
    await open(page);
    await page.getByTestId("ld-edit").click();
    await menu(page, milestone(page), "Move to…");
    const sheet = page.getByTestId("ld-ms-move-sheet");
    await sheet.getByText(SECOND).click();
    await page.getByTestId("ld-move-go").click();
    await expect(toast(page, "Moved")).toContainText(`Goal 2 ${SECOND}`);
    await expect(column(page, SECOND).getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(1);

    await toast(page, "Moved").getByRole("button", { name: "Undo" }).click();
    await expect(column(page, FIRST).getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(1);
    await expect(column(page, SECOND).getByTestId("ld-milestone").filter({ hasText: LADDER_KRS.milestone })).toHaveCount(0);

    // Back on its key result, not on Goal 1 itself: Move to… marks no goal as where it is now.
    await menu(page, milestone(page), "Move to…");
    await expect(sheet.getByRole("radio")).toHaveCount(4);
    await expect(sheet).not.toContainText("(now)");
    for (const r of await sheet.getByRole("radio").all()) await expect(r).not.toBeChecked();
  });
});
