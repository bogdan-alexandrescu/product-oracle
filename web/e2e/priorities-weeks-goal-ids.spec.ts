import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple's Priorities after PRs 1420 and 1432 (the mock's default company, and a feature whose goal has no value):
 * effort reads "1 week" / "N weeks" on the Ranked tab too (a row's numbers, the effort box, a proposal); a feature the
 * mock does not list has no effort, as the API reads it; a feature whose goal has no value is counted by its goal's
 * name, never "no goal"; and a mark shrinks from the keyboard. (Shapes keyed by a goal's id:
 * value-effort-wording.spec.ts renames a goal to another's name.)
 */

/** The mock's scenario with an invented feature whose goal has no value (simple-priorities.ts). */
const GOAL_NO_VALUE = "priorities-goal-no-value";

const DESKTOP = { width: 1440, height: 900 };

async function open(page: Page, tab: "ranked" | "value-effort", scenario: string | null = null, email: string = ADMIN.email): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, email);
  await page.goto(`/simple/priorities?tab=${tab}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  if (tab === "value-effort") {
    await expect(page.getByTestId("vxe-point").first()).toBeVisible();
    // The plot is measured and laid out (marks and counts at their pixels).
    await page.waitForTimeout(300);
  }
}

const row = (page: Page, code: string) => page.locator(`[data-testid="prio-row"][data-code="${code}"]`);
const mark = (page: Page, code: string) => page.locator(`[data-testid="vxe-point"][data-code="${code}"]`);

test("the Ranked tab says weeks: a row's numbers, the effort box and what it saves", async ({ page }) => {
  await open(page, "ranked");
  await expect(row(page, "alert-rules").getByTestId("prio-numbers")).toContainText("4 weeks");
  for (const t of await page.getByTestId("prio-numbers").allInnerTexts()) expect(t).not.toMatch(/\bwk\b/);
  // Health log is a feature the mock does not list: no effort (as the API reads it), so no score, until one is added.
  const log = row(page, "setup-health-log");
  await expect(log.getByTestId("prio-pm-owned")).toBeVisible();
  await log.getByRole("button", { name: "Add effort" }).click();
  const edit = log.getByTestId("prio-effort-edit");
  await expect(edit.getByText("weeks", { exact: true })).toBeVisible();
  await expect(edit.getByText("wk", { exact: true })).toHaveCount(0);
  await edit.getByLabel("Effort for Health log, in engineer-weeks").fill("1");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(log.getByTestId("prio-pm-owned")).toHaveCount(0);
  await expect(log.getByTestId("prio-numbers")).toContainText(/(^|·)1 week·/);
});

test("a proposed re-estimate reads its effort in weeks", async ({ page }) => {
  await open(page, "value-effort", null, "commenter@example.com");
  // Sample data import (3 weeks) shrinks half a week from the keyboard: a commenter proposes it.
  await mark(page, "setup-import").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText(/^Proposed: .* decides$/)).toBeVisible();
  await page.getByRole("tab", { name: "Ranked list" }).click();
  await expect(page.getByTestId("prio-proposal-words").filter({ hasText: "proposes effort" })).toContainText("proposes effort 2.5 weeks");
});

test("a mark shrinks from the keyboard: Arrow Left takes half a week off, never below half a week", async ({ page }) => {
  await open(page, "value-effort");
  // Weekly alert digest: goal value 5, 2 weeks.
  const digest = mark(page, "alert-digest");
  await expect(digest).toHaveAttribute("aria-label", /goal value 5, effort 2 weeks/);
  const x0 = (await digest.boundingBox())!.x;
  await digest.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(digest).toHaveAttribute("aria-label", /goal value 5, effort 1\.5 weeks/);
  await expect(page.getByText(/^Re-estimated Weekly alert digest.*: effort 1\.5 weeks$/)).toBeVisible();
  await expect.poll(async () => (await digest.boundingBox())!.x).toBeLessThan(x0 - 10);
  for (const at of ["1 week", "0.5 weeks"]) {
    await digest.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(digest).toHaveAttribute("aria-label", new RegExp(`effort ${at.replace(".", "\\.")}`));
  }
  // At half a week it shrinks no more.
  await digest.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  await expect(digest).toHaveAttribute("aria-label", /effort 0\.5 weeks/);
  await page.getByRole("tab", { name: "Ranked list" }).click();
  await expect(row(page, "alert-digest").getByTestId("prio-numbers")).toContainText("0.5 weeks");
});

test("a feature whose goal has no value is counted by its goal's name, not 'no goal'", async ({ page }) => {
  await open(page, "value-effort", GOAL_NO_VALUE);
  // Quiet hours for alerts serves Grow retention, which gives it no value: it sits at goal value 0, 1 week, with two
  // features that serve no goal.
  const count = page.locator('[data-testid="vxe-crowd"][aria-label*="Quiet hours for alerts"]');
  await expect(count).toHaveCount(1);
  await expect(count).toHaveAttribute("aria-label", /^\d+ features at effort 1 week · goal value 0 or Grow retention or no goal: /);
  await count.click();
  const sheet = page.getByTestId("vxe-crowd-sheet");
  await expect(sheet.getByRole("heading")).toHaveText(/ · effort 1 week · goal value 0 or Grow retention or no goal$/);
  const quiet = sheet.locator('[data-testid="vxe-crowd-row"][data-code="alert-quiet-hours"]');
  await expect(quiet).toBeVisible();
  // Its mark is Grow retention's shape, as Weekly alert digest's (a lone mark), never the no-goal one.
  await expect(quiet).toHaveAttribute("data-shape", (await mark(page, "alert-digest").getAttribute("data-shape"))!);
  await expect(quiet).not.toHaveAttribute("data-shape", "none");
});
