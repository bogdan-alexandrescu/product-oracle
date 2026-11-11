import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Goal ladder editing (goal-map-editing, the owner's ask of Nov 6: "this doesn't have delete or
 * drag-drop. we need those otherwise the ui is not useful"), driven through the UI against the
 * mock ("goal-ladder" scenario: invented goals, milestones and features; F-66 to F-69 serve a
 * goal but no milestone, F-64 and F-65 serve no goal). At 1440 a person drags cards by pointer;
 * at 390 (one goal at a time, no canvas) the same moves go through each card's ⋯ menu.
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
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
}

const phone = (page: Page) => page.viewportSize()!.width <= 600;
const card = (page: Page, code: string) => page.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: new RegExp(`^${code}$`) }) });
const krCard = (page: Page, name: string) => page.getByTestId("ld-milestone").filter({ hasText: name });
const goalCard = (page: Page, name: string) => page.getByTestId("ld-goal").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

/** Drags with the mouse in steps, as a person does. */
async function dragBy(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
}
/** The part of the canvas on screen, above where toasts show. */
async function area(page: Page) {
  await page.getByTestId("ld-canvas").evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const c = (await page.getByTestId("ld-canvas").boundingBox())!;
  const top = Math.max(c.y, 0);
  return { x: c.x, y: top, width: c.width, height: Math.min(c.y + c.height, page.viewportSize()!.height - 100) - top };
}
/** Zooms out until both fit in the canvas, then pans them into view (the wheel over the canvas). */
async function showBoth(page: Page, a: Locator, b: Locator) {
  const canvas = await area(page);
  for (let i = 0; i < 14; i++) {
    const [A, B] = [(await a.boundingBox())!, (await b.boundingBox())!];
    const top = Math.min(A.y, B.y);
    const bottom = Math.max(A.y + A.height, B.y + B.height);
    if (top >= canvas.y && bottom <= canvas.y + canvas.height) return;
    if (bottom - top > canvas.height - 40) {
      await page.getByRole("button", { name: "Zoom out" }).click();
      continue;
    }
    await page.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, -(canvas.y + canvas.height / 2 - (top + bottom) / 2));
    await page.waitForTimeout(50);
  }
}
async function mid(loc: Locator) {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page: Page, from: Locator, to: Locator) {
  await showBoth(page, from, to);
  await dragBy(page, await mid(from), await mid(to));
}
/** On a phone: the goal's tab, then the card's ⋯ menu item. */
async function goalTab(page: Page, n: number | "No goal") {
  await page.getByRole("tab", { name: typeof n === "number" ? `Goal ${n}` : n, exact: true }).click();
}
async function menu(page: Page, on: Locator, item: string) {
  await on.getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

for (const [label, size] of [["1440", DESKTOP], ["390", PHONE]] as const) {
  test.describe(label, () => {
    test.use(size);

    test("a feature on no milestone, put on a milestone: it moves there and the badge count drops", async ({ page }) => {
      // protects=every feature is on the ladder (F-66 under Goal 1's "Not on a key result"), the
      // badge opens the list of them, and a drop (or Move to… on a phone) links it to M3 with Undo;
      // fails_when=unlinked features are not drawn, the drop only places the card, or the badge
      // keeps its count; no_claim=the API's link (pytest test_simple_goal_ladder_editing_api).
      await open(page);
      const badge = page.getByTestId("gm-flag-unplaced");
      await expect(badge).toHaveText("6 features serve no gate");
      await badge.click();
      await expect(page.getByTestId("gm-flag-list").getByTestId("gm-unplaced")).toHaveCount(6);
      await page.getByTestId("gm-flag-list").getByRole("button", { name: "Close" }).click();
      await expect(page.getByTestId("gm-flag-list")).toHaveCount(0);
      if (phone(page)) await goalTab(page, 1);
      const free = page.getByTestId("ld-free").filter({ has: card(page, "F-66") });
      await expect(free).toBeVisible();
      await expect(free).toContainText("Not on a key result");
      if (!phone(page)) await expect(page.getByTestId("ld-nogoal")).toContainText("F-64");
      await page.getByTestId("ld-edit").click();
      // M3, the goal's last milestone: its work sits just above the group.
      const m3 = page.locator("[data-ld-group]").filter({ hasText: "Mobile check-ins weekly for half of teams" }).first();
      if (phone(page)) {
        await menu(page, card(page, "F-66"), "Move to…");
        await page.getByTestId("ld-move-sheet").getByText("Mobile check-ins weekly for half of teams").click();
        await page.getByTestId("ld-move-go").click();
      } else await drag(page, card(page, "F-66"), m3.locator("span").first());
      await expect(toast(page, "Moved F-66")).toContainText("Mobile check-ins weekly for half of teams");
      await expect(m3.getByTestId("ld-feature").filter({ hasText: "F-66" })).toHaveCount(1);
      await expect(badge).toHaveText("5 features serve no gate");
    });

    test("a milestone moved to another goal", async ({ page }) => {
      // protects=a key result dragged onto another goal's column (Move to… on a phone) serves
      // that goal, with Undo; fails_when=it stays under its goal or the drop pans the canvas;
      // no_claim=the gate's reading.
      await open(page);
      await page.getByTestId("ld-edit").click();
      const kr = krCard(page, "Mobile check-ins weekly for half of teams");
      if (phone(page)) {
        await menu(page, kr, "Move to…");
        await page.getByTestId("ld-ms-move-sheet").getByText("New teams set up in one day").click();
        await page.getByTestId("ld-move-go").click();
        await goalTab(page, 2);
      } else await drag(page, kr, krCard(page, "Imports finish without help"));
      await expect(toast(page, "Moved")).toContainText("Mobile check-ins weekly for half of teams");
      const column = phone(page) ? page.getByTestId("ld-phone") : page.getByTestId("ld-column").nth(1);
      await expect(column.getByTestId("ld-milestone").filter({ hasText: "Mobile check-ins weekly" })).toHaveCount(1);
      if (!phone(page)) await expect(page.getByTestId("ld-column").nth(0).getByTestId("ld-milestone")).toHaveCount(2);
    });

    test("two goals reordered: the one goal order", async ({ page }) => {
      // protects=a goal column dragged onto another (Move left on a phone) changes the one goal
      // order, with Undo; fails_when=the order is only drawn, not kept; no_claim=Home's order control.
      await open(page);
      await page.getByTestId("ld-edit").click();
      if (phone(page)) {
        await goalTab(page, 2);
        await menu(page, goalCard(page, "New teams set up in one day"), "Move left");
      } else await drag(page, goalCard(page, "New teams set up in one day"), goalCard(page, "Teams stay past their first year"));
      await expect(toast(page, "Goal order saved")).toBeVisible();
      if (phone(page)) {
        await goalTab(page, 1);
        await expect(page.getByTestId("ld-goal")).toContainText("New teams set up in one day");
      } else await expect(page.getByTestId("ld-goal").first()).toContainText("New teams set up in one day");
      await page.reload();
      await expect(page.getByTestId("ld-goal").first()).toContainText("New teams set up in one day");
    });

    test("a milestone moved to Trash, then Undo puts it back", async ({ page }) => {
      // protects=Move to Trash on a key result's ⋯ menu takes it off the ladder with a toast whose
      // Undo brings it back; fails_when=no Delete on a key result or Undo leaves it gone.
      await open(page);
      await page.getByTestId("ld-edit").click();
      const kr = krCard(page, "Renewal rate at 85% for spring renewals");
      await menu(page, kr, "Move to Trash");
      await expect(kr).toHaveCount(0);
      await toast(page, "to Trash").getByRole("button", { name: "Undo" }).click();
      await expect(kr).toHaveCount(1);
    });

    test("a goal moved to Trash shows in Settings > Trash", async ({ page }) => {
      // protects=Move to Trash on a goal's ⋯ menu asks first, naming what sits under it, then the
      // goal leaves the ladder and Settings › Trash lists it with Restore; fails_when=no Delete on a
      // goal, no confirm, or Trash does not list it.
      await open(page);
      await page.getByTestId("ld-edit").click();
      if (phone(page)) await goalTab(page, 4);
      await menu(page, goalCard(page, "Half the support tickets per team"), "Move to Trash");
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("3 milestones");
      await dialog.getByRole("button", { name: "Move to Trash" }).click();
      await expect(toast(page, "to Trash")).toContainText("Half the support tickets per team");
      await expect(goalCard(page, "Half the support tickets per team")).toHaveCount(0);
      await page.goto("/settings/trash");
      const row = page.getByRole("listitem").filter({ hasText: "Half the support tickets per team" }).first();
      await expect(row.getByTestId("trash-kind")).toHaveText("Goal");
      await expect(row.getByRole("button", { name: /Restore/ })).toBeVisible();
    });

    test("an approver who is not the roadmap's decider suggests a milestone's Trash, never moves it", async ({ page }) => {
      // protects=a milestone's can_change (the roadmap's owner or decider, as the API's 403 checks) gates
      // its ⋯ menu's Move to… and Move up/down and its grip, not the map's can_edit; its Move to Trash
      // and Delete key become a suggestion to the decider (goal-map-editing); fails_when=the approver
      // is offered a move the API then refuses, or the Delete key moves it; no_claim=the decider's own menu.
      await open(page, "approver");
      await page.getByTestId("ld-edit").click();
      const kr = krCard(page, "Renewal rate at 85% for spring renewals");
      await expect(kr).toHaveCount(1);
      await kr.focus();
      await page.keyboard.press("Delete");
      await expect(toast(page, "Suggested: move")).toContainText(/Renewal rate at 85% for spring renewals to Trash; it waits for (?!the roadmap's owner)\S/);
      await expect(kr).toHaveCount(1);
      await kr.getByTestId("ld-more").first().click();
      await expect(page.getByRole("menuitem", { name: "Edit the gate" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Move to Trash", exact: true })).toHaveCount(1);
      for (const name of ["Move to…", "Move up", "Move down"]) {
        await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
      }
      await page.keyboard.press("Escape");
      if (phone(page)) await goalTab(page, 4);
      await expect(goalCard(page, "Half the support tickets per team").getByTestId("ld-more").first()).toBeVisible();
    });

    test("a commenter's drop becomes a suggestion", async ({ page }) => {
      // protects=in Suggest changes, a commenter's move of F-66 to Goal 2 is a suggestion (the
      // card stays where it is until it is accepted); fails_when=the change applies or is refused;
      // no_claim=the decider's accept.
      await open(page, "commenter");
      await page.getByTestId("ld-edit").click();
      if (phone(page)) {
        await menu(page, card(page, "F-66"), "Move to…");
        await page.getByTestId("ld-move-sheet").getByText("Not on a key result").nth(1).click();
        await page.getByTestId("ld-move-go").click();
      } else await drag(page, card(page, "F-66"), page.getByTestId("ld-free").nth(1));
      await expect(toast(page, "Suggested")).toContainText("F-66");
      await expect(page.getByTestId("ld-free").first().getByTestId("ld-feature").filter({ hasText: "F-66" })).toHaveCount(1);
    });
  });
}
