import { expect, test, type Page } from "./test";

import { OKR_IMPORT_GOAL, OKR_IMPORT_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-rename, driven through the UI on the mock API as a person would. "okr-import" adds a
 * proposed key-result goal from an OKR import: its name and description hold an unfilled "[n]",
 * its target as written is "[n] live helpers", it is due 2027-03-31 over 2027-03-01..2027-03-31,
 * and it names its parent goal by key (paid conversion's). Test cards (protects / fails_when / no_claim):
 * - "rename": protects=a person who can change goals renames a proposed goal from its Goals row
 *   (Rename opens its panel on the Edit form), and the new name shows in the panel, the Goals
 *   table and Home's goals; fails_when=the row has no Rename, the save is refused or the old
 *   name stays anywhere; no_claim=the audit row (api tests/test_goal_rename.py).
 * - "plain words": protects=the panel's Attributes read dates month first, the parent goal by
 *   its name and a placeholder value as missing; fails_when="2027-03-31", "g.paid-conversion" or
 *   "[n]" shows; no_claim=attributes other pages show.
 */

const RENAMED = "KR 1.1 Ten live helpers averaging 50 replied threads a day in March 2027";

async function groundTruth(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, OKR_IMPORT_SCENARIO] as const);
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  return page.getByTestId("goal-kr-1-1");
}

test("plain words: a proposed goal's Attributes read month first, its parent by name, a placeholder as missing", async ({ page }) => {
  const row = await groundTruth(page);
  await row.getByRole("button", { name: OKR_IMPORT_GOAL }).click();
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

test("rename: a proposed goal is renamed from its Goals row, and Home's goals show the new name", async ({ page }) => {
  const row = await groundTruth(page);
  // The goal's panel already open: its row's Rename turns it to the Edit form.
  await row.getByRole("button", { name: OKR_IMPORT_GOAL }).click();
  const panel = page.getByTestId("entity-drawer");
  await expect(panel.getByRole("button", { name: "Edit" })).toBeVisible();
  await row.getByRole("button", { name: "Rename" }).click();
  const form = panel.getByRole("form", { name: "Edit" });
  await expect(form.getByLabel("Title")).toHaveValue(OKR_IMPORT_GOAL);
  await form.getByLabel("Title").fill(RENAMED);
  await form.getByLabel("Description").fill("Reach ten live helpers, each replying to 50 threads a day.");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.getByRole("heading", { name: RENAMED })).toBeVisible();
  await expect(panel).toContainText("Reach ten live helpers, each replying to 50 threads a day.");
  await expect(panel).not.toContainText("[n]");
  // Still proposed: the owner confirms it once it reads right.
  await expect(panel.getByRole("button", { name: "Confirm" })).toBeVisible();
  await expect(row.getByRole("button", { name: RENAMED })).toBeVisible();

  await page.goto("/home");
  const goals = page.getByTestId("home-goals");
  await expect(goals).toContainText(RENAMED);
  await expect(goals).not.toContainText(OKR_IMPORT_GOAL);
});
