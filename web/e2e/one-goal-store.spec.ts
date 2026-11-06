import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Train AO fix 2: one goal, read and changed in one place. On Priorities ("goal-buckets-undated":
 * invented goals Reliability, Growth, Grow retention, ...; invented features Weekly alert digest,
 * Status page, ...), a goal's measure changed in a feature's panel shows in its goal bucket's Edit
 * goal, and one changed in Edit goal shows in the panel, each with Undo. Desktop 1440x900.
 *
 * Card one-goal-panel-to-bucket: protects = the panel's measure change reloads the goal buckets, so
 * Edit goal opens with it, and the panel's Undo puts it back there too; fails_when = Edit goal shows
 * the old measure (two goal stores, or no reload).
 * Card one-goal-bucket-to-panel: protects = Edit goal's save shows in the open panel, and its Undo
 * too; fails_when = the panel keeps the old measure.
 * Card one-goal-changed-since: protects = Edit goal opened before the panel changed the measure
 * is refused on save with plain words, and the goal keeps the panel's measure; fails_when = the
 * save silently overwrites it.
 * Card one-goal-trashed: protects = once a goal is in Trash, a feature's panel lists no such goal
 * and changes the feature's goal at once; fails_when = it offers the goal in Trash or says
 * "Changed since you saw it".
 * Card one-goal-delete-closes: protects = a feature deleted from its Priorities row closes its open
 * panel; fails_when = the panel stays open on a feature in Trash.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId("floating-card");
const bucket = (page: Page) => page.locator('[data-testid="goal-bucket"][data-key="grow-retention"]');
const WAS = "Teams active after 90 days";
const NEW = "Teams active after 60 days";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** With the keyboard: the open panel sits over the page's right side. */
async function press(l: Locator) {
  await l.focus();
  await l.press("Enter");
}

/** Priorities, with Weekly alert digest's panel open over the Goal buckets tab. */
async function open(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "goal-buckets-undated"] as const);
  await login(page);
  await page.goto("/simple/priorities");
  await tap(page.getByTestId("prio-title").filter({ hasText: "Weekly alert digest" }));
  await expect(panel(page).getByTestId("card-goal-measure")).toHaveText(WAS);
  await tap(page.locator("#prio-tab-buckets"));
  await expect(bucket(page).getByRole("button", { name: "More for Grow retention" })).toBeVisible();
}

async function panelMeasure(page: Page, to: string) {
  await tap(panel(page).getByRole("button", { name: "Change the measure" }));
  await panel(page).getByTestId("card-goal-measure-edit").getByLabel("Measure").fill(to);
  await tap(panel(page).getByTestId("card-goal-measure-edit").getByRole("button", { name: "Save" }));
  await expect(panel(page).getByTestId("card-goal-measure")).toHaveText(to);
}

async function editGoal(page: Page): Promise<Locator> {
  await tap(bucket(page).getByRole("button", { name: "More for Grow retention" }));
  await tap(page.getByRole("menuitem", { name: "Edit goal" }));
  return bucket(page).getByTestId("goal-form").getByLabel("Measure");
}

test("a measure changed in the panel shows in the bucket's Edit goal, and its Undo too", async ({ page }) => {
  await open(page);
  await panelMeasure(page, NEW);
  await expect(await editGoal(page)).toHaveValue(NEW);
  await tap(bucket(page).getByRole("button", { name: "Cancel" }));
  await tap(page.getByRole("button", { name: "Undo" }).last());
  await expect(panel(page).getByTestId("card-goal-measure")).toHaveText(WAS);
  await expect(await editGoal(page)).toHaveValue(WAS);
});

test("a measure changed in Edit goal shows in the open panel, and its Undo too", async ({ page }) => {
  await open(page);
  const measure = await editGoal(page);
  await measure.fill(NEW);
  await tap(bucket(page).getByRole("button", { name: "Save goal" }));
  await expect(page.getByTestId("bucket-note")).toContainText("Saved Grow retention");
  await expect(panel(page).getByTestId("card-goal-measure")).toHaveText(NEW);
  await press(page.getByTestId("bucket-note").getByRole("button", { name: "Undo" }));
  await expect(panel(page).getByTestId("card-goal-measure")).toHaveText(WAS);
});

test("Edit goal opened before the panel changed the measure is refused, in plain words", async ({ page }) => {
  await open(page);
  const measure = await editGoal(page);
  await measure.fill("Teams active after 30 days");
  await panelMeasure(page, NEW);
  await tap(bucket(page).getByRole("button", { name: "Save goal" }));
  await expect(page.getByRole("alert").filter({ hasText: "This goal changed since you opened it. Look again and save." })).toBeVisible();
  await expect(panel(page).getByTestId("card-goal-measure")).toHaveText(NEW);
});

test("deleting a feature from its row closes its open panel", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "goal-buckets-undated"] as const);
  await login(page);
  await page.goto("/simple/priorities");
  const row = page.getByTestId("prio-title").filter({ hasText: "Weekly alert digest" });
  await tap(row);
  await expect(panel(page)).toBeVisible();
  await press(page.getByRole("button", { name: "More for Weekly alert digest (WAD)" }));
  await press(page.getByRole("menuitem", { name: "Delete feature" }));
  await expect(page.getByText("Moved Weekly alert digest to Trash.")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

test("once a goal is in Trash, the panel leaves it out and changes the feature's goal", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "goal-buckets-undated"] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await tap(bucket(page).getByRole("button", { name: "More for Grow retention" }));
  await tap(page.getByRole("menuitem", { name: "Delete goal" }));
  const dialog = page.getByRole("dialog", { name: "Delete Grow retention" });
  const to = dialog.getByLabel("Goal", { exact: true });
  await to.selectOption({ label: (await to.locator("option").allTextContents()).find((o) => o.endsWith("Faster activation"))! });
  await tap(dialog.getByRole("button", { name: "Delete goal" }));
  await expect(bucket(page)).toHaveCount(0);

  await tap(page.locator("#prio-tab-ranked"));
  await tap(page.getByTestId("prio-title").filter({ hasText: "Weekly alert digest" }));
  const goal = panel(page).getByTestId("card-goal");
  await expect(goal).not.toContainText("Grow retention");
  await tap(panel(page).getByRole("button", { name: "Change the goal" }));
  const pick = panel(page).getByTestId("card-goal-edit").getByLabel("Goal");
  const options = await pick.locator("option").allTextContents();
  expect(options.some((o) => o.includes("Grow retention"))).toBe(false);
  await pick.selectOption({ label: options.find((o) => o.startsWith("Faster activation"))! });
  await tap(panel(page).getByTestId("card-goal-edit").getByRole("button", { name: "Save" }));
  await expect(goal).toContainText("Faster activation");
  await expect(page.getByText("Changed since you saw it")).toHaveCount(0);
});
