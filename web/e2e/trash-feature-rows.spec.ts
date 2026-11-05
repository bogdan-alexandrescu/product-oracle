import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * trash-features-goals, the screens: a roadmap feature deleted from its row (the Gantt's and the
 * Timeline's context menu, the Priorities row's ⋯) goes to Trash and the note's Undo brings it
 * back; a goal deleted from its bucket's ⋯ is restored from Settings › Trash; a goal renamed from
 * Edit goal reads its new name. Mock data only (invented features and goals).
 *
 * Card tfr-row-delete: protects = Delete feature on a Gantt, Timeline or Priorities row takes the
 * feature off the page, says "Moved <name> to Trash.", and Undo puts it back; fails_when = no
 * menu on the row, the feature stays, or Undo leaves it off; no_claim = the feature panel's own
 * Delete (another lane), proposals for who may not decide (pytest and the mock's own spec).
 * Card tfr-goal-trash: protects = Delete goal from the bucket menu lists the goal in Settings ›
 * Trash, and its Restore brings the bucket back; fails_when = the goal is not in Trash or stays
 * off the buckets after Restore.
 * Card tfr-goal-rename: protects = Edit goal saves a new name, read on its bucket; fails_when = the
 * old name stays.
 */

const toasts = (page: Page) => page.getByTestId("toasts");

async function roadmap(page: Page, format: "gantt" | "timeline") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await page.getByTestId(`format-${format}`).click();
}

/** The row's context menu: its title (from the menu's name), then Delete feature. */
async function deleteFromMenu(page: Page, row: ReturnType<Page["locator"]>): Promise<string> {
  await row.click({ button: "right" });
  const menu = page.getByTestId("feature-menu");
  await expect(menu).toBeVisible();
  const title = ((await menu.getAttribute("aria-label")) ?? "").replace(/^More for /, "");
  expect(title).not.toBe("");
  await menu.getByRole("menuitem", { name: "Delete feature" }).click();
  await expect(menu).toHaveCount(0);
  await expect(toasts(page)).toContainText(`Moved ${title} to Trash.`);
  return title;
}

test("Gantt: Delete feature from a row's context menu takes it off; Undo brings it back", async ({ page }) => {
  await roadmap(page, "gantt");
  const label = page.getByTestId("chart-label").first();
  await expect(label).toBeVisible();
  const id = (await label.getAttribute("data-item-id"))!;
  const bar = page.locator(`[data-testid="bar"][data-bar-id="${id}"]`);
  await expect(bar).toHaveCount(1);
  const title = await deleteFromMenu(page, label);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("label-title").filter({ hasText: title })).toHaveCount(0);
  await toasts(page).getByRole("button", { name: "Undo" }).click();
  await expect(toasts(page)).toContainText(`Undone: ${title} and its links are back.`);
  await expect(bar).toHaveCount(1);
});

test("Timeline: Delete feature from a row's context menu takes it off; Undo brings it back", async ({ page }) => {
  await roadmap(page, "timeline");
  const bar = page.getByTestId("timeline-bar").first();
  await expect(bar).toBeVisible();
  const id = (await bar.getAttribute("data-bar-id"))!;
  const same = page.locator(`[data-testid="timeline-bar"][data-bar-id="${id}"]`);
  await deleteFromMenu(page, bar);
  await expect(same).toHaveCount(0);
  await toasts(page).getByRole("button", { name: "Undo" }).click();
  await expect(same).toHaveCount(1);
});

test("Priorities: a row's ⋯ deletes the feature to Trash; Undo brings it back", async ({ page }) => {
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities");
  const row = page.getByTestId("prio-row").first();
  await expect(row).toBeVisible();
  const code = (await row.getAttribute("data-code"))!;
  const title = (await row.getByTestId("prio-title").textContent())!;
  const same = page.locator(`[data-testid="prio-row"][data-code="${code}"]`);
  await row.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: "Delete feature" }).click();
  await expect(toasts(page)).toContainText(`Moved ${title} to Trash.`);
  await expect(same).toHaveCount(0);
  await toasts(page).getByRole("button", { name: "Undo" }).click();
  await expect(same).toHaveCount(1);
});

test("a viewer's rows have no Delete feature", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/simple/priorities");
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
  await expect(page.getByTestId("prio-row").getByRole("button", { name: /^More for / })).toHaveCount(0);
  await page.goto("/simple/roadmap");
  await page.getByTestId("format-gantt").click();
  await page.getByTestId("chart-label").first().click({ button: "right" });
  await expect(page.getByTestId("feature-menu")).toHaveCount(0);
});

async function buckets(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
}

const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);

test("a goal deleted from its bucket menu is restored from Settings › Trash", async ({ page }) => {
  await buckets(page);
  await bucket(page, "Activation").getByRole("button", { name: "More for Activation" }).click();
  await page.getByRole("menuitem", { name: "Delete goal" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Activation" });
  const go = dialog.getByRole("button", { name: "Delete goal" });
  if (await go.isDisabled()) await dialog.getByLabel("Goal", { exact: true }).selectOption({ label: "1 · Reliability" });
  await go.click();
  await expect(bucket(page, "Activation")).toHaveCount(0);

  await page.goto("/settings/trash");
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Activation" });
  await expect(entry).toContainText("Goal");
  await page.getByRole("button", { name: "Restore Activation" }).click();
  await expect(entry).toHaveCount(0);

  await page.goto("/simple/priorities?tab=buckets");
  await expect(bucket(page, "Activation")).toBeVisible();
});

test("Edit goal renames a goal, and its bucket reads the new name", async ({ page }) => {
  await buckets(page);
  await bucket(page, "Growth").getByRole("button", { name: "More for Growth" }).click();
  await page.getByRole("menuitem", { name: "Edit goal" }).click();
  await page.getByRole("textbox", { name: "Goal", exact: true }).fill("Growth in new markets");
  await page.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByTestId("bucket-note")).toContainText("Saved Growth in new markets");
  await expect(bucket(page, "Growth in new markets")).toBeVisible();
  await expect(bucket(page, "Growth")).toHaveCount(0);
});
