import { GM_TRACKS_SCENARIO } from "../lib/api/mock/goal-map-tracks";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal map, "Goals by tracks grid": the goal map's own editors, from the grid's ⋯ menus and from
 * the badges that ask for them (a milestone's No gate, a goal's Not measured), and a feature on two
 * milestones of one goal, driven through the UI against the mock ("goal-map-tracks": invented
 * goals, milestones, tracks and features).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1512, height: 900 } });

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GM_TRACKS_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });
const chip = (page: Page, name: string) => page.getByTestId("gm-chip").filter({ hasText: name });
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function milestoneMenu(page: Page, name: string, item: string | RegExp) {
  const m = strip(page, name);
  await m.hover();
  await m.getByRole("button", { name: new RegExp(`More for .*${name}`) }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function chipMenu(page: Page, name: string, item: string) {
  const c = chip(page, name);
  await c.hover();
  await c.getByRole("button", { name: new RegExp(`More for .*${name}`) }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.describe("Goal map editors in the tracks grid", () => {
  test("a milestone's No gate leads to its gate; once set, it no longer says No gate", async ({ page }) => {
    // protects: every badge leads to the action that resolves it (the gate editor), and saving it
    // clears the badge. fails_when: No gate is plain text, or the gate cannot be set from the grid.
    await open(page);
    const m = strip(page, "Annual plans live");
    await m.getByRole("button", { name: "No gate" }).click();
    const drawer = page.getByRole("dialog", { name: /gate of Annual plans live/ });
    await drawer.getByRole("textbox", { name: "At least" }).fill("18000");
    await drawer.getByRole("button", { name: "Save gate" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(strip(page, "Annual plans live")).toBeVisible();
    await expect(strip(page, "Annual plans live").getByText("No gate")).toHaveCount(0);
  });

  test("Set the gate from a milestone's ⋯ menu", async ({ page }) => {
    // protects: the gate editor from the menu too. fails_when: the menu has no Set the gate.
    await open(page);
    await expect(strip(page, "Self-serve setup").getByRole("button", { name: "No gate" })).toBeVisible();
    await milestoneMenu(page, "Self-serve setup", "Set the gate");
    const drawer = page.getByRole("dialog", { name: /gate of Self-serve setup/ });
    await drawer.getByRole("textbox", { name: "At least" }).fill("25");
    await drawer.getByRole("button", { name: "Save gate" }).click();
    await expect(strip(page, "Self-serve setup").getByText("No gate")).toHaveCount(0);
  });

  test("New PRD from it opens the new PRD sheet with the milestone's name", async ({ page }) => {
    // protects: a PRD started from a milestone in the grid. fails_when: the menu lacks it.
    await open(page);
    await milestoneMenu(page, "32 demos per rep", "New PRD from it");
    const drawer = page.getByRole("dialog", { name: "New PRD from a milestone" });
    await drawer.getByRole("checkbox").first().check();
    await drawer.getByRole("button", { name: "Start the PRD" }).click();
    await expect(page.getByPlaceholder("For example: Saved shipping addresses")).toHaveValue("32 demos per rep");
  });

  test("a goal's Not measured leads to Pick its metric; once picked, it reads", async ({ page }) => {
    // protects: the badge leads to the metric picker; the goal then has a status from its reading.
    // fails_when: Not measured is plain text or the metric cannot be picked from the grid.
    await open(page);
    const g = goal(page, "Activations per team per week");
    await g.getByRole("button", { name: "Not measured" }).click();
    const drawer = page.getByRole("dialog", { name: /Pick the metric for Activations per team per week/ });
    await drawer.getByRole("button", { name: /Weekly team activations/ }).click();
    await drawer.getByRole("button", { name: "Use this metric" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(goal(page, "Activations per team per week")).not.toContainText("Not measured");
    await expect(goal(page, "Activations per team per week")).toContainText("At risk");
  });

  test("Pick its metric from a goal's ⋯ menu", async ({ page }) => {
    // protects: the goal menu's metric picker. fails_when: the menu lacks Pick its metric.
    await open(page);
    const g = goal(page, "Activations per team per week");
    await g.hover();
    await g.getByRole("button", { name: /More for Activations per team per week/ }).click();
    await page.getByRole("menuitem", { name: "Pick its metric" }).click();
    await expect(page.getByRole("dialog", { name: /Pick the metric for Activations per team per week/ }).getByRole("button", { name: /Weekly team activations/ })).toBeVisible();
  });
});

test.describe("A feature on two milestones of one goal", () => {
  test("its chip names both milestones; No milestone detaches both, and Undo restores each with its own expected lift", async ({ page }) => {
    // protects: the chip shows every milestone of its goal; Move to... No milestone takes it off all
    // of them; Undo puts back each link with its own expected lift and confidence.
    // fails_when: the chip names only the first, one link stays, or Undo loses the expected lift.
    await open(page);
    const c = chip(page, "No-show reminder texts");
    await expect(c).toContainText("32 demos per rep");
    await expect(c).toContainText("40 demos per rep");
    await chipMenu(page, "No-show reminder texts", "Move to…");
    await page.getByRole("dialog", { name: /Move .*No-show reminder texts/ }).getByRole("button", { name: "No milestone" }).click();
    await expect(chip(page, "No-show reminder texts")).toContainText("No milestone");
    await expect(chip(page, "No-show reminder texts")).not.toContainText("demos per rep");
    await toast(page, /Moved .*No-show reminder texts/).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page, /Moved .*No-show reminder texts back/)).toBeVisible();
    await expect(chip(page, "No-show reminder texts")).toContainText("32 demos per rep");
    await expect(chip(page, "No-show reminder texts")).toContainText("40 demos per rep");
    await chip(page, "No-show reminder texts").getByRole("button", { name: /No-show reminder texts/ }).click();
    const served = page.getByTestId("gm-panel-milestone");
    await expect(served).toContainText("+1 demo a day");
    await expect(served).toContainText("+3 demos a day");
  });

  test("Undo of No milestone restores the link's expected lift", async ({ page }) => {
    // protects: Undo re-attaches with the link's own expected lift, never an empty one.
    await open(page);
    await chipMenu(page, "Lead list ranking", "Move to…");
    await page.getByRole("dialog", { name: /Move .*Lead list ranking/ }).getByRole("button", { name: "No milestone" }).click();
    await expect(chip(page, "Lead list ranking")).toContainText("No milestone");
    await toast(page, /Moved .*Lead list ranking/).getByRole("button", { name: "Undo" }).click();
    await expect(chip(page, "Lead list ranking")).toContainText("32 demos per rep");
    await chip(page, "Lead list ranking").getByRole("button", { name: /Lead list ranking/ }).click();
    await expect(page.getByTestId("gm-panel-milestone")).toContainText("+2 demos a day");
  });

  test("Add a feature offers one already on another milestone of the goal as a move", async ({ page }) => {
    // protects: adding a feature never makes a silent second link on the same goal; it moves.
    // fails_when: the feature is listed as a plain add and the chip still shows only its old milestone.
    await open(page);
    await milestoneMenu(page, "40 demos per rep", "Add a feature");
    const drawer = page.getByRole("dialog", { name: "Add a feature" });
    await drawer.getByPlaceholder("Search the roadmap").fill("Rep calendar sync");
    const pick = drawer.getByTestId("gm-attach-list").getByRole("button", { name: /Rep calendar sync/ });
    await expect(pick).toContainText("Move from");
    await pick.click();
    await drawer.getByRole("button", { name: "Move here" }).click();
    await expect(chip(page, "Rep calendar sync")).toContainText("40 demos per rep");
    await expect(chip(page, "Rep calendar sync")).not.toContainText("32 demos per rep");
  });

  test("Move Undo says Moved back", async ({ page }) => {
    // protects: the move's Undo confirms itself as the track and Trash Undos do.
    await open(page);
    await chipMenu(page, "Lead list ranking", "Move to…");
    await page.getByRole("dialog", { name: /Move .*Lead list ranking/ }).getByRole("button", { name: /40 demos per rep/ }).click();
    await toast(page, /Moved .*Lead list ranking/).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page, /Moved .*Lead list ranking back to .*32 demos per rep/)).toBeVisible();
  });
});

test.describe("A PRD's milestone", () => {
  test("its ⋯ menu opens its PRD", async ({ page }) => {
    // protects: Open <PRD> navigates to the PRD. fails_when: the item is missing or goes nowhere.
    await open(page);
    await milestoneMenu(page, "Card retry live", "Open Payments clean-up");
    await expect(page).toHaveURL(/\/simple\/one-pagers\/payments-clean-up/);
  });
});
