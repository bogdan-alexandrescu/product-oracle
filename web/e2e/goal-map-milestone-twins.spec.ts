import { LADDER_TWINS, LADDER_TWINS_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal map milestone twins (the owner's Goal map findings of Nov 10), on the mock's "goal-ladder-twins"
 * scenario (invented: Goal 2's own "Imports finish without help", by Dec 18, and an undated milestone
 * of the same name from the PRD "Bulk imports"; an undated "Seat changes from the admin page" from that
 * PRD alone; a Jan 29 "40 replies per agent per day" the PRD's plan no longer holds).
 *
 * Card twin-once: protects = a goal's milestone and a PRD's whose names match are one milestone with
 * one code (roadmap_codes, "Join whenever names match"), so the Goal map's milestone strip draws it
 * once; fails_when = the undated twin is drawn beside the dated one.
 * Card prd-milestone-trash: protects = a PRD's milestone's menu never offers Move to Trash (always
 * refused: "A PRD's milestone is not deleted here"); fails_when = Move to Trash is offered.
 * Card every-dated-coded: protects = every milestone in the map's milestone strip carries its
 * roadmap code; a PRD milestone its plan dropped is not drawn (the roadmap read leaves it out, so it
 * has no code); fails_when = "40 replies per agent per day" shows with no M code.
 * Card same-goal-only: protects = a goal's milestone joins a PRD's only within the same goal (the owner,
 * Nov 11): Goal 4's own "Imports finish" leads the twin's name but keeps a code of its own; fails_when =
 * it and Goal 2's "Imports finish without help" show one code in the strip.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_TWINS_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
  await expect(page.getByTestId("gm-strip-milestone").first().locator("b")).toHaveText(/^M\d+$/);
}

/** A milestone in the strip, by its whole name. */
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ has: page.getByTitle(name, { exact: true }) });

test.describe("Goal map milestone twins", () => {
  test("a goal's milestone and the PRD's of the same name are drawn once, with one code", async ({ page }) => {
    await open(page);
    const twin = strip(page, LADDER_TWINS.twin);
    await expect(twin).toHaveCount(1);
    await expect(twin.locator("b")).toHaveText(/^M\d+$/);
    await expect(twin).toContainText("Dec 18");
  });

  test("two goals' milestones of matching names show two codes", async ({ page }) => {
    await open(page);
    const twin = strip(page, LADDER_TWINS.twin);
    const other = strip(page, LADDER_TWINS.other);
    await expect(twin).toHaveCount(1);
    await expect(other).toHaveCount(1);
    const code = (await twin.locator("b").textContent())!.trim();
    await expect(other.locator("b")).toHaveText(/^M\d+$/);
    await expect(other.locator("b")).not.toHaveText(code);
  });

  test("a PRD's milestone never offers Move to Trash", async ({ page }) => {
    await open(page);
    const lone = strip(page, LADDER_TWINS.lone);
    await lone.hover();
    await lone.getByRole("button", { name: new RegExp(`More for .*${LADDER_TWINS.lone}`) }).click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toHaveCount(0);
  });

  test("every milestone in the strip carries its code", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("gm-strip-milestone").filter({ hasText: LADDER_TWINS.stale })).toHaveCount(0);
    for (const m of await page.getByTestId("gm-strip-milestone").all()) await expect(m.locator("b")).toHaveText(/^M\d+$/);
  });
});
