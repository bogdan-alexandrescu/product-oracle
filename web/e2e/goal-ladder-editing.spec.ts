import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Goal map editing (goal-map-editing, the owner's ask of Nov 6: "this doesn't have delete or
 * drag-drop. we need those otherwise the ui is not useful"), on the goals by tracks grid, driven
 * through the UI against the mock ("goal-ladder" scenario: invented goals, milestones and
 * features; F-66 to F-69 serve a goal but no milestone, F-64 and F-65 serve no goal). At 1440 and
 * at 390 the moves go through each chip's and each milestone's ⋯ menu.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, role?: "commenter" | "approver") {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("gm-goal").first()).toBeVisible();
}

/** A feature's chip by its code (F-06, never F-066). */
const chip = (page: Page, code: string) => page.getByTestId("gm-chip").filter({ hasText: new RegExp(`${code}(?!\\d)`) });
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });
const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

/** A chip's ⋯ menu (shown on hover or focus), then the item. */
async function chipMenu(page: Page, c: Locator, item: string) {
  await c.getByRole("button").first().focus();
  await c.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
/** A strip milestone's ⋯ menu (shown on hover), then the item. */
async function milestoneMenu(page: Page, m: Locator, item: string) {
  await m.hover();
  await m.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

for (const [label, size] of [["1440", DESKTOP], ["390", PHONE]] as const) {
  test.describe(label, () => {
    test.use(size);

    test("a feature on no milestone, put on a milestone: it moves there", async ({ page }) => {
      // protects=every feature serving a goal is on the map (F-66 in Goal 1's column, "No
      // milestone"; F-64, which serves no goal, is not), and Move to… links it to Mobile check-ins
      // weekly for half of teams; fails_when=unlinked features are not drawn, or the move leaves it
      // on no milestone; no_claim=the API's link (pytest test_simple_goal_ladder_editing_api).
      await open(page);
      const goal1 = await goal(page, "Teams stay past their first year").getAttribute("data-goal");
      const f66 = chip(page, "F-66");
      await expect(f66).toContainText("No milestone");
      await expect(page.locator(`[data-testid="gm-cell"][data-goal="${goal1}"]`).filter({ has: f66 })).toHaveCount(1);
      await expect(chip(page, "F-64")).toHaveCount(0);
      await chipMenu(page, f66, "Move to…");
      await page.getByTestId("gm-mover").getByRole("button", { name: /Mobile check-ins weekly for half of teams/ }).click();
      await expect(toast(page, "Moved F-66")).toContainText("Mobile check-ins weekly for half of teams");
      await expect(chip(page, "F-66")).toContainText("Mobile check-ins weekly for half of teams");
      await expect(chip(page, "F-66")).not.toContainText("No milestone");
    });

    test("a milestone moved to Trash, then Undo puts it back", async ({ page }) => {
      // protects=Move to Trash on a milestone's ⋯ menu takes it off the map with a toast whose
      // Undo brings it back; fails_when=no Move to Trash on a milestone or Undo leaves it gone.
      await open(page);
      const m = strip(page, "Renewal rate at 85% for spring renewals");
      await milestoneMenu(page, m, "Move to Trash");
      await expect(m).toHaveCount(0);
      await toast(page, "to Trash").getByRole("button", { name: "Undo" }).click();
      await expect(m).toHaveCount(1);
    });

    test("an approver who is not the roadmap's decider gets no milestone menu, but keeps the goals'", async ({ page }) => {
      // protects=a milestone's can_change (the roadmap's owner or decider, as the API's 403 checks)
      // gates its ⋯ menu, not the map's can_edit; fails_when=the approver is offered a rename or
      // Trash the API then refuses; no_claim=the decider's own menu.
      await open(page, "approver");
      await expect(strip(page, "Renewal rate at 85% for spring renewals")).toHaveCount(1);
      await expect(page.locator('[data-testid^="gm-menu-m-"]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="gm-menu-g-"]')).toHaveCount(4);
    });
  });
}
