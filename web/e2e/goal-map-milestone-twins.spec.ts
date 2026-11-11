import { LADDER_TWINS, LADDER_TWINS_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Goal map milestone twins (the owner's Goal map findings of Nov 10), on the mock's "goal-ladder-twins"
 * scenario (invented: Goal 2's own "Imports finish without help", by Dec 18, and an undated milestone
 * of the same name from the PRD "Bulk imports"; an undated "Seat changes from the admin page" from that
 * PRD alone; a Jan 29 "40 replies per agent per day" the PRD's plan no longer holds).
 *
 * Card twin-once: protects = a goal's milestone and a PRD's whose names match are one milestone with
 * one code (roadmap_codes, "Join whenever names match"), so the Goal map draws it once; fails_when =
 * the undated twin is drawn beside the dated one.
 * Card prd-milestone-trash: protects = a PRD's milestone's menu never offers Move to Trash (always
 * refused: "A PRD's milestone is not deleted here"); it leads to the PRD's one-pager, where its plan
 * changes; fails_when = Move to Trash is offered or there is no way to the PRD.
 * Card every-dated-coded: protects = every milestone on the map and its week strip carries its
 * roadmap code; a PRD milestone its plan dropped is not drawn (the roadmap read leaves it out, so it
 * has no code); fails_when = "40 replies per agent per day" shows with no M code.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_TWINS_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
  await expect(page.getByTestId("ld-week-mark").first()).toContainText(/^M\d+ /);
}

const krCard = (page: Page, name: string) => page.getByTestId("ld-milestone").filter({ hasText: name });

async function openMenu(on: Locator) {
  await on.getByTestId("ld-more").first().click();
}

test.describe("Goal map milestone twins", () => {
  test("a goal's milestone and the PRD's of the same name are drawn once, with one code", async ({ page }) => {
    await open(page);
    const twin = krCard(page, LADDER_TWINS.twin);
    await expect(twin).toHaveCount(1);
    await expect(twin.locator(".simple-code")).toHaveText(/^M\d+$/);
    await expect(twin).toContainText("Dec 18");
  });

  test("a PRD's milestone leads to its PRD instead of offering Move to Trash", async ({ page }) => {
    await open(page);
    await page.getByTestId("ld-edit").click();
    await openMenu(krCard(page, LADDER_TWINS.lone));
    const menu = page.getByTestId("ld-ms-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move to Trash" })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: `Open ${LADDER_TWINS.prd.title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/simple/one-pagers/${LADDER_TWINS.prd.slug}$`));
  });

  test("every milestone on the map and its week strip carries its code", async ({ page }) => {
    await open(page);
    await expect(krCard(page, LADDER_TWINS.stale)).toHaveCount(0);
    await expect(page.getByTestId("ld-week-mark").filter({ hasText: LADDER_TWINS.stale })).toHaveCount(0);
    for (const mark of await page.getByTestId("ld-week-mark").all()) {
      for (const line of (await mark.getAttribute("title"))!.split("\n")) expect(line).toMatch(/^M\d+ /);
    }
    for (const card of await page.getByTestId("ld-milestone").all()) await expect(card.locator(".simple-code")).toHaveText(/^M\d+$/);
  });
});
