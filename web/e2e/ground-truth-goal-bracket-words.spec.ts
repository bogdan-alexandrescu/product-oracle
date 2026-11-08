import { expect, test, type Page } from "./test";

import { OKR_IMPORT_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * gt-goal-bracket-words, driven through the UI on the mock API as a person would. "okr-import" adds the proposed
 * goal kr-1-1, stored with an unfilled "[n]" (see ground-truth-goal-rename.spec.ts).
 * Test cards (protects / fails_when / no_claim):
 * - "bracketed words": protects=a goal renamed to a name with a real bracketed word ("Project [X]", "Price [Value]",
 *   "Launch [beta]") keeps it in the panel and the Goals row, and only an import's placeholder form ("[n] of [n]") is
 *   dropped; fails_when="[X]", "[Value]" or "[beta]" is stripped, or "[n]" shows; no_claim=the API's guard
 *   (api tests/test_goal_rename.py).
 * - "rename tooltip": protects=the desktop Rename button, which reads Rename, has no tooltip, while the phone's pencil
 *   still says Rename; fails_when=the desktop button carries a title or the pencil has none.
 */

async function groundTruth(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, OKR_IMPORT_SCENARIO] as const);
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  return page.getByTestId("goal-kr-1-1");
}

async function rename(page: Page, row: ReturnType<Page["getByTestId"]>, to: string, shown: string) {
  const panel = page.getByTestId("entity-drawer");
  await row.getByRole("button", { name: "Rename" }).click();
  const form = panel.getByRole("form", { name: "Edit" });
  await form.getByLabel("Title").fill(to);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(panel.getByRole("heading", { name: shown, exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: shown, exact: true })).toBeVisible();
}

test("bracketed words: a real bracketed word stays in a goal's name; an import's placeholder is dropped", async ({ page }) => {
  const row = await groundTruth(page);
  for (const name of ["Project [X] live helpers", "Price [Value] per seat", "Launch [beta] to ten teams"]) {
    await rename(page, row, name, name);
  }
  await rename(page, row, "KR [n] of [n] agents", "KR agents");
  await expect(row.getByRole("button").filter({ hasText: "[n]" })).toHaveCount(0);
});

test("rename tooltip: the desktop Rename button has no tooltip; the phone's pencil says Rename", async ({ page }) => {
  const row = await groundTruth(page);
  const button = row.getByTestId("rename-goal");
  await expect(button).toHaveText("Rename");
  await expect(button).not.toHaveAttribute("title");
  await expect(button.locator("[title]")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toHaveAccessibleName("Rename");
  await expect(button.locator('[title="Rename"]')).toBeVisible();
});
