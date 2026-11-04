import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal buckets you can fully edit (the owner, Nov 4: "drag and drop for tasks between goal buckets
 * and ... edit, delete, add in place new tasks"), in BOTH Goal buckets views: with a dated plan
 * (the mock's "simple-plan": goals Reliability, Growth, Activation and Revenue) and without one
 * ("goal-buckets-undated": the same roadmap with no approved version yet, so Priorities falls back
 * to the goal cards). Invented data. Desktop 1440x900 and phone 390x844.
 *
 * Card tasks-move: protects = with no dated plan a task's grip carries it to another goal by
 * pointer (the page scrolls at the edge on a phone) or by keys (Enter, arrows, Enter); the target
 * lights up and says where it lands; Undo puts it back; fails_when = no grip, or it stays put.
 * Card tasks-add: protects = "+ Add a task" at a bucket's foot opens the form in place (name,
 * outcome, milestone), Save stays off with no name, the task shows in that bucket as a draft,
 * Undo removes it. Card tasks-edit: protects = a task's pencil opens the same form filled in;
 * the new name shows; Undo puts the name back. Card tasks-cut: protects = ⋯ Cut from the roadmap
 * asks first, then the task leaves the bucket; Undo brings it back. Card tasks-viewer: a viewer
 * sees no add row, pencil or ⋯.
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;

const VIEWS = [
  { name: "with a dated plan", scenario: "simple-plan", card: "plan-goal" },
  { name: "with no dated plan", scenario: "goal-buckets-undated", card: "goal-bucket" },
] as const;

type View = (typeof VIEWS)[number];

async function open(page: Page, view: View, viewport: { width: number; height: number }, who = ADMIN.email) {
  await page.setViewportSize(viewport);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, view.scenario, THEME_KEY] as const,
  );
  await login(page, who);
  await page.goto("/simple/priorities?tab=buckets");
  // With no dated plan, the goal cards and their intro; with one, the plan's header.
  if (view.card === "goal-bucket") {
    await expect(page.getByTestId("buckets-intro")).toContainText("Engineer-weeks per confirmed goal this quarter");
    await expect(page.getByTestId("buckets-head")).toHaveCount(0);
  } else await expect(page.getByTestId("buckets-head")).toBeVisible();
  await expect(bucket(page, view, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
}

const bucket = (page: Page, view: View, goal: string) => page.locator(`[data-testid="${view.card}"]`).filter({ has: page.getByRole("heading", { name: goal, exact: true }) });
const note = (page: Page) => page.getByTestId("bucket-note");

for (const view of VIEWS) {
  for (const size of SIZES) {
    test.describe(`${view.name}, ${size.name}`, () => {
      test("add a task in place to a goal, then Undo", async ({ page }) => {
        await open(page, view, size.viewport);
        const growth = bucket(page, view, "Growth");
        const add = growth.getByTestId("add-task");
        await add.getByRole("button", { name: "+ Add a task" }).click();
        const form = add.getByTestId("task-form");
        await expect(form.getByRole("heading", { name: "New task" })).toBeVisible();
        await expect(form).toContainText("Goal: Growth");
        const save = form.getByRole("button", { name: "Save task" });
        await expect(save).toBeDisabled();
        await form.getByLabel("Name").fill("Saved carts");
        await form.getByLabel("Outcome: what changes for people").fill("Shoppers pick up where they left off");
        await form.getByLabel("Milestone").selectOption({ index: 1 });
        await expect(save).toBeEnabled();
        await save.click();
        await expect(note(page)).toContainText("Added Saved carts to Growth.");
        const made = growth.getByTestId("plan-feature").filter({ hasText: "Saved carts" });
        await expect(made).toBeVisible();
        await expect(made).toContainText("Draft");
        await expect(add.getByRole("button", { name: "+ Add a task" })).toBeVisible();
        await note(page).getByRole("button", { name: "Undo" }).click();
        await expect(note(page)).toContainText("Undone");
        await expect(made).toHaveCount(0);
      });

      test("edit a task in place: its name, outcome and milestone, then Undo", async ({ page }) => {
        await open(page, view, size.viewport);
        const row = bucket(page, view, "Reliability").locator('[data-code="F-03"]');
        await row.getByRole("button", { name: "Edit Setup failure alerts" }).click();
        const form = row.getByTestId("task-form");
        await expect(form.getByRole("heading", { name: "Edit task" })).toBeVisible();
        await expect(form.getByLabel("Name")).toHaveValue("Setup failure alerts");
        await form.getByLabel("Name").fill("Setup failure alarms");
        await form.getByLabel("Outcome: what changes for people").fill("Teams hear about a failed setup within a minute");
        await form.getByLabel("Milestone").selectOption({ index: 1 });
        const milestone = await form.getByLabel("Milestone").inputValue();
        await form.getByRole("button", { name: "Save task" }).click();
        await expect(note(page)).toContainText("Saved Setup failure alarms.");
        await expect(row.getByTestId("plan-feature-name")).toContainText("Setup failure alarms");
        // The form opens again with what was saved.
        await row.getByRole("button", { name: "Edit Setup failure alarms" }).click();
        await expect(form.getByLabel("Outcome: what changes for people")).toHaveValue("Teams hear about a failed setup within a minute");
        await expect(form.getByLabel("Milestone")).toHaveValue(milestone);
        await form.getByRole("button", { name: "Cancel" }).click();
        await note(page).getByRole("button", { name: "Undo" }).click();
        await expect(note(page)).toContainText("Undone");
        await expect(row.getByTestId("plan-feature-name")).toContainText("Setup failure alerts");
      });

      test("cut a task from the roadmap from its ⋯, then Undo", async ({ page }) => {
        await open(page, view, size.viewport);
        const row = bucket(page, view, "Reliability").locator('[data-code="F-03"]');
        await row.getByRole("button", { name: "More for Setup failure alerts" }).click();
        await row.getByRole("menuitem", { name: "Cut from the roadmap" }).click();
        const dialog = page.getByRole("dialog", { name: "Cut Setup failure alerts" });
        await expect(dialog).toContainText("Cut Setup failure alerts from the roadmap?");
        await expect(dialog.getByTestId("cut-dependents")).toBeVisible();
        await dialog.getByRole("button", { name: "Cut from the roadmap" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(note(page)).toContainText("Cut Setup failure alerts from the roadmap.");
        await expect(row).toHaveCount(0);
        await note(page).getByRole("button", { name: "Undo" }).click();
        await expect(note(page)).toContainText("Undone");
        await expect(row).toBeVisible();
      });

      test("move a task by keyboard to another goal, then Undo", async ({ page }) => {
        await open(page, view, size.viewport);
        const grip = bucket(page, view, "Reliability").locator('[data-code="F-03"]').getByTestId("feature-grip");
        await expect(grip).toHaveAccessibleName("Move Setup failure alerts to another goal");
        await grip.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("bucket-live")).toContainText("Picked up Setup failure alerts.");
        await page.keyboard.press("ArrowDown");
        await expect(page.getByTestId("bucket-live")).toHaveText("Over goal 2, Growth. Enter drops it there.");
        await expect(bucket(page, view, "Growth")).toHaveAttribute("data-drop", "");
        await expect(bucket(page, view, "Growth").getByTestId("drop-note")).toHaveText("Drop here: Growth becomes the goal it moves most");
        await page.keyboard.press("Enter");
        await expect(bucket(page, view, "Growth").locator('[data-code="F-03"]')).toBeVisible();
        await expect(bucket(page, view, "Reliability").locator('[data-code="F-03"]')).toHaveCount(0);
        await expect(note(page)).toContainText("Moved Setup failure alerts to Growth.");
        await note(page).getByRole("button", { name: "Undo" }).click();
        await expect(bucket(page, view, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
      });

      test("drag a task by its grip to another goal, then Undo", async ({ page }) => {
        await open(page, view, size.viewport);
        const grip = bucket(page, view, "Reliability").locator('[data-code="F-03"]').getByTestId("feature-grip");
        await grip.scrollIntoViewIfNeeded();
        const from = (await grip.boundingBox())!;
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        const target = bucket(page, view, "Growth").getByRole("heading", { name: "Growth", exact: true });
        let to = (await target.boundingBox())!;
        if (to.y > size.viewport.height - 120) {
          // Growth is below the screen: holding at the bottom edge scrolls the page under the finger.
          await page.mouse.move(from.x + 4, size.viewport.height - 30, { steps: 6 });
          await expect(page.getByTestId("drag-edge")).toContainText("Scrolling down");
          await expect.poll(async () => (await target.boundingBox())!.y, { intervals: [30] }).toBeLessThan(size.viewport.height - 160);
          await page.mouse.move(from.x + 4, size.viewport.height / 2, { steps: 2 });
          to = (await target.boundingBox())!;
        }
        await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 8 });
        await expect(bucket(page, view, "Growth")).toHaveAttribute("data-drop", "");
        await expect(page.getByTestId("drag-ghost")).toContainText("Setup failure alerts");
        await page.mouse.up();
        await expect(bucket(page, view, "Growth").locator('[data-code="F-03"]')).toBeVisible();
        await expect(note(page)).toContainText("Moved Setup failure alerts to Growth.");
        await note(page).getByRole("button", { name: "Undo" }).click();
        await expect(bucket(page, view, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
      });

      test("a viewer sees the tasks with no add row, pencil, ⋯ or grip", async ({ page }) => {
        await open(page, view, size.viewport, "viewer@example.com");
        const reliability = bucket(page, view, "Reliability");
        await expect(reliability.locator('[data-code="F-03"]')).toBeVisible();
        await expect(page.getByTestId("add-task")).toHaveCount(0);
        await expect(page.getByTestId("task-actions")).toHaveCount(0);
        await expect(page.getByTestId("feature-grip")).toHaveCount(0);
      });
    });
  }
}
