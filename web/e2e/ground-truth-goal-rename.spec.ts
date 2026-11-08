import { expect, test, type Page } from "./test";

import { OKR_IMPORT_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-rename, driven through the UI on the mock API as a person would. "okr-import" adds a
 * proposed key-result goal from an OKR import, stored before the placeholder guard: its name and
 * description hold an unfilled "[n]", its target as written is "[n] live helpers", it is due
 * 2027-03-31 over 2027-03-01..2027-03-31, and it names its parent goal by key (paid conversion's).
 * Test cards (protects / fails_when / no_claim):
 * - "plain words": protects=the panel's Attributes read dates month first, the parent goal by
 *   its name and a placeholder value as missing; fails_when="2027-03-31", "g.paid-conversion" or
 *   "[n]" shows; no_claim=attributes other pages show.
 * - "rename": protects=the stored name reads without "[n]" in the Goals row, the panel's heading
 *   and description and Home's goals, and a person who can change goals renames the proposed goal
 *   from its Goals row (Rename opens its panel on the Edit form, starting from the stored name), and
 *   the new name shows in the panel, the Goals table and Home's goals; fails_when="[n]" shows, the
 *   row has no Rename, the save is refused or the old name stays anywhere; no_claim=the audit row
 *   (api tests/test_goal_rename.py).
 * - "confirmed": protects=once confirmed the goal reads without "[n]" on the Goal map too, and its
 *   row still has Rename; the new name shows on the Goals row, the panel, Home and the Goal map;
 *   fails_when=a confirmed goal has no Rename or "[n]" or the old name shows; no_claim=goals on the
 *   map's cards (api tests/test_simple_goal_map_api.py).
 */

const STORED = "KR 1.1 [n] of [n] live helpers averaging 50 replied threads a day in March 2027";
const CLEAN = "KR 1.1 live helpers averaging 50 replied threads a day in March 2027";
const RENAMED = "KR 1.1 Ten live helpers averaging 50 replied threads a day in March 2027";

async function signIn(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, OKR_IMPORT_SCENARIO] as const);
  await login(page);
}

async function groundTruth(page: Page) {
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  return page.getByTestId("goal-kr-1-1");
}

async function rename(page: Page, row: ReturnType<Page["getByTestId"]>, to: string) {
  const panel = page.getByTestId("entity-drawer");
  await row.getByRole("button", { name: "Rename" }).click();
  const form = panel.getByRole("form", { name: "Edit" });
  // The form starts from the stored name, so a person sees what they are replacing.
  await expect(form.getByLabel("Title")).toHaveValue(STORED);
  await form.getByLabel("Title").fill(to);
  await form.getByLabel("Description").fill("Reach ten live helpers, each replying to 50 threads a day.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.getByRole("heading", { name: to })).toBeVisible();
  await expect(panel).toContainText("Reach ten live helpers, each replying to 50 threads a day.");
  await expect(panel).not.toContainText("[n]");
  await expect(row.getByRole("button", { name: to })).toBeVisible();
  return panel;
}

/** The goal on the Goal map, as Simple Home's goal card opens it (its name there without its "KR 1.1" code). */
async function onGoalMap(page: Page, name: string) {
  const words = name.replace(/^KR 1\.1 /, "");
  await page.goto("/simple");
  await page.getByRole("link", { name: `${words} on the Goal map` }).click();
  const off = page.getByTestId("gm-off-map");
  await expect(off).toContainText(words);
  await expect(off).not.toContainText("[n]");
}

test("plain words: a proposed goal's Attributes read month first, its parent by name, a placeholder as missing", async ({ page }) => {
  await signIn(page);
  const row = await groundTruth(page);
  await row.getByRole("button", { name: CLEAN }).click();
  const panel = page.getByTestId("entity-drawer");
  const attrs = panel.getByRole("definition");
  await expect(panel.locator('[data-attr="due"]')).toHaveText("Mar 31, 2027");
  await expect(panel.locator('[data-attr="period"]')).toHaveText("Mar 1 – Mar 31, 2027");
  await expect(panel.locator('[data-attr="parent_goal"]')).toHaveText("Grow paid conversion");
  await expect(panel.getByText("Parent goal", { exact: true })).toBeVisible();
  await expect(panel.locator('[data-attr="target_text"]')).toHaveText("Missing");
  await expect(attrs.filter({ hasText: "2027-03" })).toHaveCount(0);
  await expect(attrs.filter({ hasText: "g.paid-conversion" })).toHaveCount(0);
  await expect(attrs.filter({ hasText: "[n]" })).toHaveCount(0);
});

test("rename: a goal stored with '[n]' reads without it, is renamed from its Goals row, and Home's goals show the new name", async ({ page }) => {
  await signIn(page);
  const row = await groundTruth(page);
  await expect(row.getByRole("button", { name: CLEAN })).toBeVisible();
  // The name: its Target column reads the target as written ("[n] live helpers"), not the name.
  await expect(row.getByRole("button").filter({ hasText: "[n]" })).toHaveCount(0);
  await row.getByRole("button", { name: CLEAN }).click();
  const panel = page.getByTestId("entity-drawer");
  await expect(panel.getByRole("heading", { name: CLEAN })).toBeVisible();
  await expect(panel).toContainText("Reach live helpers, each replying to 50 threads a day.");
  await expect(panel).not.toContainText("[n]");

  await page.goto("/home");
  const home = page.getByTestId("home-goals");
  await expect(home).toContainText(CLEAN);
  // The name; the card's target reads as written ("/ [n] live helpers").
  await expect(home).not.toContainText("KR 1.1 [n]");

  const back = await groundTruth(page);
  // The goal's panel already open: its row's Rename turns it to the Edit form.
  await back.getByRole("button", { name: CLEAN }).click();
  await expect(page.getByTestId("entity-drawer").getByRole("button", { name: "Edit" })).toBeVisible();
  const renamed = await rename(page, back, RENAMED);
  // Still proposed: the owner confirms it once it reads right.
  await expect(renamed.getByRole("button", { name: "Confirm" })).toBeVisible();

  await page.goto("/home");
  const goals = page.getByTestId("home-goals");
  await expect(goals).toContainText(RENAMED);
  await expect(goals).not.toContainText(CLEAN);
});

test("confirmed: a confirmed goal reads without '[n]' on the Goal map, and its row's Rename renames it everywhere", async ({ page }) => {
  await signIn(page);
  const row = await groundTruth(page);
  await row.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await onGoalMap(page, CLEAN);

  const back = await groundTruth(page);
  await expect(back.getByRole("button").filter({ hasText: "[n]" })).toHaveCount(0);
  await rename(page, back, RENAMED);
  await expect(back).not.toContainText(CLEAN);

  await page.goto("/home");
  const goals = page.getByTestId("home-goals");
  await expect(goals).toContainText(RENAMED);
  await expect(goals).not.toContainText(CLEAN);
  await onGoalMap(page, RENAMED);
});
