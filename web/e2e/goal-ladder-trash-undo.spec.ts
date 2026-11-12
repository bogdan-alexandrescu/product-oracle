import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * goal-delete-r5: the Goal ladder ("goal-ladder", invented data), owner, desktop 1440x900. Goal 1 Teams stay
 * past their first year holds Team templates gallery, a roadmap feature on no milestone ("Not on a key result").
 *
 * Card ladder-goal-trash-undo: protects = Move Goal 1 to Trash in Edit, its feature moves to No goal; Undo in
 * the toast brings the goal back with Team templates gallery under it again (the goal's restore gives the
 * roadmap's items their goals back, as Trash's Restore does); fails_when = the goal comes back but its
 * feature stays under No goal; no_claim = Restore from Settings › Trash.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const GOAL = "Teams stay past their first year";
const FEATURE = "Team templates gallery";

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
}

const card = (page: Page) => page.getByTestId("ld-goal").filter({ hasText: GOAL });

test("Undo after Move to Trash on a goal brings its feature back under it", async ({ page }) => {
  await open(page);
  const id = (await card(page).getAttribute("data-goal"))!;
  const free = page.locator(`[data-testid="ld-free"][data-goal="${id}"]`);
  await expect(free.getByTestId("ld-feature").filter({ hasText: FEATURE })).toHaveCount(1);

  await page.getByTestId("ld-edit").click();
  await card(page).getByRole("button", { name: `More for ${GOAL}` }).click();
  await page.getByTestId("ld-goal-menu").getByRole("menuitem", { name: "Move to Trash" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Move to Trash" }).click();
  const toast = page.getByRole("status").filter({ hasText: `${GOAL} to Trash` });
  await expect(toast).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("ld-nogoal").getByTestId("ld-feature").filter({ hasText: FEATURE })).toHaveCount(1);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(card(page)).toHaveCount(1);
  await expect(free.getByTestId("ld-feature").filter({ hasText: FEATURE })).toHaveCount(1);
  await expect(page.getByTestId("ld-nogoal").getByTestId("ld-feature").filter({ hasText: FEATURE })).toHaveCount(0);
});
