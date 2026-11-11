import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Every field editable (the owner's rule: every field of every feature, goal and milestone can
 * be changed in the UI), driven against the mock with invented data:
 * - a key result (a goal's milestone) on the Goal map: a viewer reads it under its goal with no
 *   way to change it;
 * - a roadmap item with no code gets its feature code in its panel: a code another feature has
 *   is refused in plain words, the owner's has Undo (refused in plain words when another item
 *   took the old code since), a commenter's is a proposal, a viewer reads;
 * - an item added with a title that starts with a code another item has is refused in plain words.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1440, height: 900 } });

type Role = "commenter" | "approver" | "viewer";

const KR = "Mobile check-ins weekly for half of teams";
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
/** A milestone on the Goal map's strip, in its goal's part of it (goals in order). */
const onStrip = (page: Page, goal: number, name: string) => page.getByTestId("gm-strip").locator(":scope > div").nth(goal).getByTestId("gm-strip-milestone").filter({ hasText: name });
const panel = (page: Page) => page.getByTestId("floating-card");

async function asRole(page: Page, role?: Role) {
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
}

async function openLadder(page: Page, role?: Role) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  await asRole(page, role);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

test.describe("a key result's goal", () => {
  test("a viewer reads it with no way to move it", async ({ page }) => {
    // protects=a viewer sees the key result under its goal on the Goal map with no ⋯ menu, and its
    // work's menu offers only Open; fails_when=a viewer is offered a change the API refuses;
    // no_claim=the map's other goals.
    await openLadder(page, "viewer");
    const m = onStrip(page, 0, KR);
    await expect(m).toHaveCount(1);
    await m.hover();
    await expect(m.getByRole("button", { name: /More for / })).toHaveCount(0);
    const work = page.getByTestId("gm-chip").filter({ hasText: KR }).first();
    await work.hover();
    await work.getByRole("button", { name: /More for / }).click();
    await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move to…" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Move to Trash" })).toHaveCount(0);
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

test.describe("an added item's code", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function addFromSheet(page: Page, title: string) {
    await page.getByTestId("quick-add-open").click();
    const sheet = page.getByRole("dialog", { name: "Add an item" });
    await sheet.getByLabel("Title").fill(title);
    await sheet.getByLabel("Roadmap").selectOption({ label: "Alerts roadmap" });
    await sheet.getByLabel("Where").selectOption({ label: "Next" });
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    return sheet;
  }

  // protects=adding an item whose title starts with a code another item has is refused in
  // set_code's plain words and nothing is added; a free code adds; fails_when=two items read
  // F-06 after the add; no_claim=a proposal accepted after the code was taken (pytest).
  test("a code another item has is refused in plain words; a free one adds", async ({ page }) => {
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    const sheet = await addFromSheet(page, "F-06 Night digest");
    await expect(toast(page, "F-06 is already the code of F-06 Weekly alert digest")).toBeVisible();
    await expect(page.getByTestId("timeline-row").filter({ hasText: "Night digest" })).toHaveCount(0);
    await sheet.getByLabel("Title").fill("F-37 Night digest");
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(toast(page, "Added F-37 Night digest as a draft")).toBeVisible();
    await expect(panel(page).getByTestId("card-code")).toHaveText("F-37");
  });
});

test.describe("a restored item's code", () => {
  async function giveCode(page: Page, key: string, code: string) {
    await openRoadmapItem(page, key);
    await panel(page).getByRole("button", { name: "Change the code" }).click();
    await panel(page).getByLabel("Code").fill(code);
    await panel(page).getByTestId("card-code-edit").getByRole("button", { name: "Save" }).click();
    await expect(panel(page).getByTestId("card-code")).toHaveText(code);
    await page.keyboard.press("Escape");
  }

  // protects=Restore in Settings › Trash of an item whose code another item took while it was in
  // Trash is refused in set_code's plain words and the item stays in Trash; fails_when=two items
  // read F-31 after the restore; no_claim=a feature's key (pytest).
  test("a code another item took meanwhile is refused in plain words", async ({ page }) => {
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await giveCode(page, "alert-export", "F-31");
    const bar = page.locator('[data-testid="timeline-row"][data-item="alert-export"] [data-testid="timeline-bar"]');
    await bar.click({ button: "right" });
    await page.getByTestId("feature-menu").getByRole("menuitem", { name: "Delete feature" }).click();
    await expect(page.getByTestId("toasts")).toContainText("to Trash.");
    await expect(bar).toHaveCount(0);
    await giveCode(page, "alert-sso", "F-31");

    await page.goto("/settings/trash");
    const row = page.getByTestId("trash-entry").filter({ hasText: "Alert history export" });
    await row.getByRole("button", { name: /^Restore / }).click();
    await expect(row).toContainText("F-31 is already the code of F-31 Alert routing by team: rename it first");
    await expect(row).toHaveCount(1);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await expect(bar).toHaveCount(0);
  });
});
