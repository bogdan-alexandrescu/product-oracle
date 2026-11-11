import { login, openRoadmapItem, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * feature-panel-gaps: three decided gaps in the one feature panel, driven through the Simple
 * roadmap's Timeline against the mock's default scenario (invented alert features).
 *
 * Card fp-tasks (ec1 'Edit each row in place', Nov 5): protects = a task is added, retitled, given
 * an owner, a due day (month first) and a status in place, and dropped with Undo; a commenter's add
 * is a proposal; a viewer reads with no add row; a dropped task waits in Settings › Trash and
 * Restore puts it back; fails_when = no '+ Add a task', no in-place controls, or Drop this task
 * has no Undo or no Trash row.
 * Card fp-review (train BK review follow-ups): protects = a typed due day saves once, whole, on
 * Enter (never on its month's first digit) and Escape keeps the old one; a viewer's task row has
 * no Retitle, Owner, Status or due-day control; a commenter's Cut and Move to Trash… ask "Propose
 * cutting…?" / "Propose moving … to Trash?" with a Propose button and the toast names who it
 * waits for; a task restored while its feature is in Trash says it shows when that is restored;
 * fails_when = '1' of '12' saves January, a viewer gets controls, a commenter is asked to Cut or
 * Move to Trash, or the restore says nothing of the feature.
 * Card fp-menu (pm1 '⋯ menu by the close', pm2 'List what points at it', Nov 5): protects = Cut
 * and Restore live in the ⋯ menu (not the Status select), Cut asks first naming what needs it, and
 * Move to Trash… always asks, listing what points at the feature; fails_when = Cut in the Status
 * select, or Delete with no list.
 * Card fp-fields: protects = the Decider and Horizon are changed in place; a commenter's horizon
 * is a proposal; fails_when = no Decider or Horizon field.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId("floating-card");
const toasts = (page: Page) => page.getByTestId("toasts");
const task = (page: Page, title: string) => panel(page).getByTestId("card-task").filter({ hasText: title });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function open(page: Page, email: string | undefined, key: string) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

async function menu(page: Page, item: string) {
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: item }));
}

async function addTask(page: Page, title: string) {
  await tap(panel(page).getByRole("button", { name: "+ Add a task" }));
  await panel(page).getByLabel("New task").fill(title);
  await tap(panel(page).getByRole("button", { name: "Add", exact: true }));
}

test("an owner adds a task and edits each part of its row in place; Drop this task has Undo", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, undefined, "alert-export");
  await addTask(page, "Draft the export help page");
  await expect(toasts(page)).toContainText("Added the task “Draft the export help page”");
  await expect(task(page, "Draft the export help page")).toContainText("No owner · No due date");
  await expect(panel(page).getByTestId("card-tasks")).toContainText("Tasks · 0 of 1 done");

  // The title retitles it in place.
  await tap(panel(page).getByRole("button", { name: "Retitle Draft the export help page" }));
  await panel(page).getByLabel("Task title").fill("Write the export help page");
  await tap(panel(page).getByTestId("card-tasks").getByRole("button", { name: "Save" }));
  const row = task(page, "Write the export help page");
  await expect(row).toBeVisible();

  // The owner picks a person; the date picks a day, read month first.
  await tap(row.getByRole("button", { name: "Owner of Write the export help page" }));
  await tap(row.getByRole("menuitem", { name: "Priya Raman" }));
  await expect(row).toContainText("Priya Raman");
  await tap(row.getByRole("button", { name: "Due date of Write the export help page" }));
  await row.getByLabel("Due date of Write the export help page").fill("2026-11-20");
  await expect(row).toContainText("due Nov 20");

  // The status pill: Doing, then Done counts in the heading.
  await tap(row.getByRole("button", { name: "Status of Write the export help page" }));
  await tap(row.getByRole("menuitem", { name: "Done" }));
  await expect(row.getByTestId("task-status")).toHaveText("Done ▾");
  await expect(panel(page).getByTestId("card-tasks")).toContainText("Tasks · 1 of 1 done");

  // Drop this task, last in the status list: it leaves the list; Undo brings it back.
  await tap(row.getByRole("button", { name: "Status of Write the export help page" }));
  await tap(row.getByRole("menuitem", { name: "Drop this task" }));
  await expect(toasts(page)).toContainText("Moved the task “Write the export help page” to Trash");
  await expect(row).toHaveCount(0);
  await tap(toasts(page).getByRole("button", { name: "Undo" }).last());
  await expect(task(page, "Write the export help page")).toBeVisible();

  // Dropped again, it waits in Settings › Trash, and Restore puts it back as it was (Done).
  await tap(task(page, "Write the export help page").getByRole("button", { name: "Status of Write the export help page" }));
  await tap(task(page, "Write the export help page").getByRole("menuitem", { name: "Drop this task" }));
  await expect(task(page, "Write the export help page")).toHaveCount(0);
  await page.goto("/settings/trash");
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Write the export help page" });
  await expect(entry).toBeVisible();
  await tap(entry.getByRole("button", { name: /^Restore/ }).first());
  await expect(entry).toHaveCount(0);
  await page.goto("/simple/roadmap");
  await openRoadmapItem(page, "alert-export");
  await expect(task(page, "Write the export help page").getByTestId("task-status")).toHaveText("Done ▾");
});

test("a commenter's new task is a proposal", async ({ page }) => {
  await open(page, "commenter@example.com", "alert-export");
  await addTask(page, "Check the export on a phone");
  await expect(toasts(page)).toContainText("proposed");
  await expect(task(page, "Check the export on a phone")).toHaveCount(0);
});

test("a viewer reads tasks with no add row and no controls on a task", async ({ page }) => {
  await open(page, undefined, "alert-export");
  await addTask(page, "Draft the export help page");
  await expect(task(page, "Draft the export help page")).toBeVisible();
  // Signed out, then in as a viewer.
  await page.goto("/home");
  await signOut(page);
  await open(page, "viewer@example.com", "alert-export");
  const row = task(page, "Draft the export help page");
  await expect(row).toContainText("No owner · No due date");
  await expect(panel(page).getByRole("button", { name: "+ Add a task" })).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Retitle Draft the export help page" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Owner of Draft the export help page" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Status of Draft the export help page" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Due date of Draft the export help page" })).toHaveCount(0);
  await expect(row.locator("input")).toHaveCount(0);
});

test("a typed due day saves once, whole, on Enter; Escape leaves it as it was", async ({ page }) => {
  await open(page, undefined, "alert-export");
  await addTask(page, "Draft the export help page");
  const row = task(page, "Draft the export help page");
  const due = row.locator('input[type="date"]');
  await tap(row.getByRole("button", { name: "Due date of Draft the export help page" }));
  await due.fill("2026-11-20");
  await expect(row).toContainText("due Nov 20");

  // The month typed digit by digit ('1' on the way to '12'): nothing saves until Enter.
  await tap(row.getByRole("button", { name: "Due date of Draft the export help page" }));
  await expect(due).toBeFocused();
  await page.keyboard.type("12");
  await expect(due).toBeVisible();
  await expect(due).toHaveValue("2026-12-20");
  await page.keyboard.press("Enter");
  await expect(row).toContainText("due Dec 20");

  // Escape: the typed day is left, the old one stays, and the panel stays open.
  await tap(row.getByRole("button", { name: "Due date of Draft the export help page" }));
  await page.keyboard.type("3");
  await page.keyboard.press("Escape");
  await expect(due).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(row).toContainText("due Dec 20");
});

test("a commenter's Cut and Move to Trash… ask to propose, and wait for the decider", async ({ page }) => {
  await open(page, "commenter@example.com", "alert-export");
  await menu(page, "Propose: cut");
  const cut = page.getByRole("alertdialog", { name: "Propose cutting Alert history export?" });
  await expect(cut.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
  await tap(cut.getByRole("button", { name: "Propose", exact: true }));
  await expect(toasts(page)).toContainText(/Proposed: cut Alert history export from the roadmap; it waits for \S.+ in Needs a decision/);
  await expect(panel(page).getByTestId("item-cut")).toHaveCount(0);

  await menu(page, "Propose: move to Trash…");
  const trash = page.getByRole("alertdialog", { name: "Propose moving Alert history export to Trash?" });
  await expect(trash.getByTestId("confirm-row").filter({ hasText: "Needed by" })).toBeVisible();
  await expect(trash.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  await tap(trash.getByRole("button", { name: "Propose", exact: true }));
  await expect(toasts(page)).toContainText(/Proposed: move Alert history export to Trash; it waits for \S.+ in Needs a decision/);
  await expect(panel(page)).toBeVisible();
});

test("a task restored while its feature is in Trash says it shows when the feature is restored", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, undefined, "alert-export");
  await addTask(page, "Draft the export help page");
  const row = task(page, "Draft the export help page");
  await tap(row.getByRole("button", { name: "Status of Draft the export help page" }));
  await tap(row.getByRole("menuitem", { name: "Drop this task" }));
  await expect(row).toHaveCount(0);
  await menu(page, "Move to Trash…");
  await tap(page.getByRole("alertdialog", { name: "Move Alert history export to Trash?" }).getByRole("button", { name: "Move to Trash" }));
  await expect(panel(page)).toHaveCount(0);

  await page.goto("/settings/trash");
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Draft the export help page" });
  await tap(entry.getByRole("button", { name: /^Restore/ }).first());
  await expect(toasts(page)).toContainText(/Restored .*Draft the export help page; it shows when (\S+ )?Alert history export is restored/);
  await expect(entry).toHaveCount(0);
  const feature = page.getByTestId("trash-entry").filter({ hasText: "Alert history export" });
  await tap(feature.getByRole("button", { name: /^Restore/ }).first());
  await expect(feature).toHaveCount(0);
  await page.goto("/simple/roadmap");
  await openRoadmapItem(page, "alert-export");
  await expect(task(page, "Draft the export help page").getByTestId("task-status")).toHaveText("To do ▾");
});

test("Cut and Restore live in the ⋯ menu; Move to Trash… lists what points at the feature", async ({ page }) => {
  await open(page, undefined, "alert-export");
  // The Status select no longer offers Cut.
  await tap(panel(page).getByRole("button", { name: "Change the status" }));
  await expect(panel(page).getByTestId("card-status-edit").getByLabel("Status").locator("option")).toHaveText(["Planned", "Done"]);
  await tap(panel(page).getByTestId("card-status-edit").getByRole("button", { name: "Cancel" }));

  await addTask(page, "Draft the export help page");
  await expect(task(page, "Draft the export help page")).toBeVisible();

  // Move to Trash… always asks, one row each for what points at it; Cancel keeps it.
  await menu(page, "Move to Trash…");
  const ask = page.getByRole("alertdialog", { name: "Move Alert history export to Trash?" });
  const rows = ask.getByTestId("confirm-row");
  await expect(rows.filter({ hasText: "Needed by" })).toContainText("Alert routing by team loses this link");
  await expect(rows.filter({ hasText: "Depends on" })).toContainText("Nothing");
  await expect(rows.filter({ hasText: "Milestone" })).toBeVisible();
  await expect(rows.filter({ hasText: "Key result" })).toBeVisible();
  await expect(rows.filter({ hasText: "Tasks" })).toContainText("1 task goes with it");
  await tap(ask.getByRole("button", { name: "Cancel" }));
  await expect(ask).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  // Cut asks first, naming what needs it; then Restore sits in its place.
  await menu(page, "Cut from the roadmap");
  const cut = page.getByRole("alertdialog", { name: "Cut Alert history export?" });
  await expect(cut).toContainText("Alert routing by team loses it");
  await tap(cut.getByRole("button", { name: "Cut", exact: true }));
  await expect(toasts(page)).toContainText("Cut Alert history export from the roadmap");
  await expect(panel(page).getByTestId("item-cut")).toBeVisible();
  // The cut panel's strip restores in one click; the menu offers Restore in Cut's place.
  await tap(panel(page).getByRole("button", { name: "Restore", exact: true }));
  await expect(toasts(page)).toContainText("Restored Alert history export to the roadmap");
  await expect(panel(page).getByTestId("item-cut")).toHaveCount(0);
  await menu(page, "Cut from the roadmap");
  await tap(cut.getByRole("button", { name: "Cut", exact: true }));
  await expect(panel(page).getByTestId("item-cut")).toBeVisible();
  await menu(page, "Restore to the roadmap");
  await expect(panel(page).getByTestId("item-cut")).toHaveCount(0);
});

test("the Decider and Horizon are changed in place", async ({ page }) => {
  await open(page, undefined, "alert-export");
  await tap(panel(page).getByRole("button", { name: "Change the decider" }));
  await panel(page).getByTestId("card-decider-edit").getByLabel("Decider").selectOption({ label: "Priya Raman" });
  await tap(panel(page).getByTestId("card-decider-edit").getByRole("button", { name: "Save" }));
  await expect(toasts(page)).toContainText("Decider changed");
  await expect(panel(page).getByTestId("card-decider")).toHaveText("Priya Raman");

  await tap(panel(page).getByRole("button", { name: "Change the horizon" }));
  await panel(page).getByTestId("card-horizon-edit").getByLabel("Horizon").selectOption("later");
  await tap(panel(page).getByTestId("card-horizon-edit").getByRole("button", { name: "Save" }));
  await expect(toasts(page)).toContainText("Horizon changed");
  await expect(panel(page).getByTestId("card-horizon")).toHaveText("Later");
});

test("a commenter's horizon is a proposal", async ({ page }) => {
  await open(page, "commenter@example.com", "alert-mobile");
  const was = await panel(page).getByTestId("card-horizon").innerText();
  await tap(panel(page).getByRole("button", { name: "Change the horizon" }));
  const other = was === "Now" ? "next" : "now";
  await panel(page).getByTestId("card-horizon-edit").getByLabel("Horizon").selectOption(other);
  await tap(panel(page).getByTestId("card-horizon-edit").getByRole("button", { name: "Save" }));
  await expect(toasts(page)).toContainText("Horizon changed proposed");
  await expect(panel(page).getByTestId("card-horizon")).toHaveText(was);
});
