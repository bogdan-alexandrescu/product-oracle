import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Every field editable (the owner's rule: every field of every feature, goal and milestone can
 * be changed in the UI), driven against the mock with invented data:
 * - a key result moves to another goal from the Goal ladder's ⋯ menu and from its own editor
 *   (Edit the gate): the owner moves it with Undo, an approver who is not the roadmap's decider
 *   asks for it (a proposal), a viewer only reads;
 * - a roadmap item with no code gets its feature code in its panel: a code another feature has
 *   is refused in plain words, the owner's has Undo (refused in plain words when another item
 *   took the old code since), a commenter's is a proposal, a viewer reads.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1440, height: 900 } });

type Role = "commenter" | "approver" | "viewer";

const KR = "Mobile check-ins weekly for half of teams";
const OTHER_GOAL = "New teams set up in one day";
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const krCard = (page: Page, name: string) => page.getByTestId("ld-milestone").filter({ hasText: name });
const panel = (page: Page) => page.getByTestId("floating-card");

async function asRole(page: Page, role?: Role) {
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
}

async function openLadder(page: Page, role?: Role) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  await asRole(page, role);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
}

async function krMenu(page: Page, item: string) {
  await krCard(page, KR).getByTestId("ld-more").first().click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.describe("a key result's goal", () => {
  test("the owner moves it in its own editor, with Undo", async ({ page }) => {
    // protects=Edit the gate has the key result's Goal; saving another goal moves it there (the
    // owner's own move) and Undo puts it back; fails_when=the drawer has no Goal or the key result
    // stays under its goal; no_claim=the gate's numbers.
    await openLadder(page);
    await page.getByTestId("ld-edit").click();
    await krMenu(page, "Edit the gate");
    const editor = page.getByTestId("gm-editor");
    await editor.getByTestId("gm-kr-goal").selectOption({ label: OTHER_GOAL });
    await editor.getByTestId("gm-save").click();
    await expect(toast(page, `Moved ${KR} to ${OTHER_GOAL}`)).toBeVisible();
    await expect(page.getByTestId("ld-column").nth(1).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);
    await toast(page, `Moved ${KR}`).getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("ld-column").nth(0).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);
  });

  test("a move with no gate typed sends only the move; a gate of 0 is never saved after a move", async ({ page }) => {
    // protects=in Edit the gate, a new goal with At least left blank moves the key result and
    // nothing else (no error after the move); a new goal with At least 0 cannot be saved, so the
    // key result never moves before a refused gate; fails_when=Save gate stays on with 0 and the
    // key result moves, then an error flashes; no_claim=the gate's own numbers.
    await openLadder(page);
    await page.getByTestId("ld-edit").click();
    await krMenu(page, "Edit the gate");
    const editor = page.getByTestId("gm-editor");
    await editor.getByTestId("gm-kr-goal").selectOption({ label: OTHER_GOAL });
    await editor.getByLabel("At least").fill("0");
    await expect(editor.getByTestId("gm-save")).toBeDisabled();
    await expect(page.getByTestId("ld-column").nth(0).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);
    await editor.getByLabel("At least").fill("");
    await editor.getByTestId("gm-save").click();
    await expect(toast(page, `Moved ${KR} to ${OTHER_GOAL}`)).toBeVisible();
    await expect(page.getByTestId("ld-column").nth(1).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);
    await expect(page.getByTestId("gm-editor")).toHaveCount(0);
  });

  test("an approver who is not the decider asks for it from the ladder and from its editor", async ({ page }) => {
    // protects=an approver who may not move key results gets Move to another goal… in its ⋯ menu
    // and the Goal in its editor; each sends a proposal that waits in Needs a decision and leaves
    // the key result where it is; fails_when=the approver has no way to change its goal, or their
    // move lands at once; no_claim=the decider's accept.
    await openLadder(page, "approver");
    await page.getByTestId("ld-edit").click();
    await krMenu(page, "Move to another goal…");
    await page.getByTestId("ld-ms-move-sheet").getByText(OTHER_GOAL).click();
    await page.getByTestId("ld-move-go").click();
    await expect(toast(page, new RegExp(`Proposed: move M\\d+ ${KR} to Goal 2 ${OTHER_GOAL}; it waits in Needs a decision`))).toBeVisible();
    await expect(page.getByTestId("ld-column").nth(0).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);

    await krMenu(page, "Edit the gate");
    const editor = page.getByTestId("gm-editor");
    await editor.getByTestId("gm-kr-goal").selectOption({ label: "Larger teams add paid seats" });
    await editor.getByTestId("gm-save").click();
    await expect(toast(page, `Proposed: move ${KR} to Larger teams add paid seats`)).toBeVisible();
    await expect(page.getByTestId("ld-column").nth(0).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);
  });

  test("a viewer reads it with no way to move it", async ({ page }) => {
    // protects=a viewer sees the key result under its goal with no ⋯ menu; fails_when=a viewer is
    // offered a move the API refuses; no_claim=the map's other cards.
    await openLadder(page, "viewer");
    await expect(page.getByTestId("ld-column").nth(0).getByTestId("ld-milestone").filter({ hasText: KR })).toHaveCount(1);
    if (await page.getByTestId("ld-edit").isVisible()) await page.getByTestId("ld-edit").click();
    await expect(page.getByRole("button", { name: `More for ${KR}` })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Move to another goal…" })).toHaveCount(0);
  });
});

test.describe("a roadmap item's feature code", () => {
  async function openExport(page: Page, role?: Role) {
    await asRole(page, role);
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await openRoadmapItem(page, "alert-export");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByTestId("card-code")).toHaveText("None");
  }

  async function giveCode(page: Page, code: string) {
    await panel(page).getByRole("button", { name: "Change the code" }).click();
    await panel(page).getByLabel("Code").fill(code);
    await panel(page).getByTestId("card-code-edit").getByRole("button", { name: "Save" }).click();
  }

  test("the owner gives it a free code, with Undo; a taken one is refused in plain words", async ({ page }) => {
    // protects=the panel's Code: a code another feature has is refused ("F-06 is already the code
    // of F-06 Weekly alert digest") and nothing changes; a free one (typed f-31) shows as F-31
    // before its name and Undo takes it off; fails_when=no Code field, a taken code lands, or Undo
    // leaves it; no_claim=the Ground Truth page's list.
    await openExport(page);
    await giveCode(page, "F-06");
    await expect(toast(page, "F-06 is already the code of F-06 Weekly alert digest")).toBeVisible();
    await expect(panel(page).getByTestId("card-code")).toHaveText("None");
    await giveCode(page, "f-31");
    await expect(panel(page).getByTestId("card-code")).toHaveText("F-31");
    await expect(panel(page).getByTestId("card-name")).toHaveText(/^F-31\s*Alert history export/);
    await toast(page, "Code changed").getByRole("button", { name: "Undo" }).click();
    await expect(panel(page).getByTestId("card-code")).toHaveText("None");
  });

  test("Undo never gives the old code to a second item: it is refused in plain words", async ({ page, context }) => {
    // protects=Undo of a code change whose old code another item took since (here from a second
    // tab) is refused ("F-31 is already the code of F-31 Alert routing by team") and both items
    // keep their codes; fails_when=Undo lands and two items read F-31; no_claim=a Ground Truth
    // feature taking the code.
    await openExport(page);
    await giveCode(page, "F-31");
    await expect(panel(page).getByTestId("card-code")).toHaveText("F-31");
    await giveCode(page, "F-32");
    await expect(panel(page).getByTestId("card-code")).toHaveText("F-32");
    const undoIt = toast(page, "Code changed").getByRole("button", { name: "Undo" });
    await undoIt.hover(); // held while the other tab gives F-31 away

    const other = await context.newPage();
    await other.goto("/simple/roadmap");
    await expect(other.getByTestId("simple-roadmap")).toBeVisible();
    await openRoadmapItem(other, "alert-sso");
    await expect(panel(other).getByTestId("card-code")).toHaveText("None");
    await giveCode(other, "F-31");
    await expect(panel(other).getByTestId("card-code")).toHaveText("F-31");
    await other.close();

    await undoIt.click();
    await expect(toast(page, "F-31 is already the code of F-31 Alert routing by team")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await openRoadmapItem(page, "alert-export");
    await expect(panel(page).getByTestId("card-code")).toHaveText("F-32");
  });

  test("a commenter's code is a proposal", async ({ page }) => {
    // protects=a commenter's code waits in Needs a decision and the item keeps no code;
    // fails_when=a commenter's code lands at once; no_claim=the decider's accept.
    await openExport(page, "commenter");
    await giveCode(page, "F-31");
    await expect(toast(page, /Code changed proposed/)).toBeVisible();
    await expect(panel(page).getByTestId("card-code")).toHaveText("None");
  });

  test("a code from its PRD reads in place, with why behind an (i)", async ({ page }) => {
    // protects=an item whose code comes from its PRD shows that code with no Change, and why
    // only behind its (i); fails_when=the Code field opens for editing and the refusal comes
    // only on save; no_claim=a Ground Truth feature's code (the same field, the other reason).
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await openRoadmapItem(page, "alert-digest");
    await expect(panel(page).getByTestId("card-code")).toContainText("F-06");
    await expect(panel(page).getByRole("button", { name: "Change the code" })).toHaveCount(0);
    await panel(page).getByRole("button", { name: "About this code" }).click();
    await expect(panel(page).getByText("It comes from its PRD's section: change it in the PRD.")).toBeVisible();
  });

  test("a viewer reads the code with no Change", async ({ page }) => {
    // protects=a viewer sees the item's code and no Change for it; fails_when=a viewer may change
    // it; no_claim=other fields.
    await openExport(page, "viewer");
    await expect(panel(page).getByRole("button", { name: "Change the code" })).toHaveCount(0);
  });
});
