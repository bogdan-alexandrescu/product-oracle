import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * #344 Launches and changelog made by hand, driven through the UI as a person would, on the
 * mock API ("launches" scenario: Hard budget caps is Ready, Weekly usage digest is Planned,
 * Usage export is Launched; usage-alerts-roadmap v1 is the track's approved roadmap).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page, role?: "viewer" | "approver") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "launches"));
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
}

async function openLaunches(page: Page) {
  await page.goto("/plan/documents");
  await page.getByTestId("roadmap-launches-link").click();
  await expect(page).toHaveURL(/\/roadmap\/launches$/);
  await expect(page.getByTestId("launches-table")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("launch-inspector").filter({ visible: true });

async function openDigest(page: Page) {
  await openLaunches(page);
  await page.getByTestId("launch-filters").getByRole("button", { name: /^Planned/ }).click();
  await page.getByTestId("launch-row").filter({ hasText: "Weekly usage digest" }).click();
  await expect(inspector(page)).toContainText("Weekly usage digest");
}

test("344a: an approver plans a launch of two roadmap items with New launch", async ({ page }) => {
  // protects=New launch: the item picker from the approved roadmap, the name, the new Planned launch with both items;
  // fails_when=the picker is empty, Create is allowed with no item or no name, or the launch does not appear;
  // no_claim=the API's own checks on the items (API tests).
  await start(page);
  await openLaunches(page);
  await page.getByTestId("new-launch").click();
  const dialog = page.getByTestId("new-launch-dialog");
  await expect(dialog).toBeVisible();
  const create = dialog.getByRole("button", { name: "Create launch" });
  await expect(create).toBeDisabled();
  const items = dialog.getByTestId("launch-item-option");
  await expect(items.first()).toBeVisible();
  const first = (await items.nth(0).getByTestId("launch-item-title").innerText()).trim();
  const second = (await items.nth(1).getByTestId("launch-item-title").innerText()).trim();
  await items.nth(0).getByRole("checkbox").check();
  await items.nth(1).getByRole("checkbox").check();
  // The name starts as the first item's title; a person writes their own.
  await expect(dialog.getByLabel("Name")).toHaveValue(first);
  await dialog.getByLabel("Name").fill("");
  await expect(create).toBeDisabled();
  await dialog.getByLabel("Name").fill("Alerts bundle");
  await create.click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("launch-filters").getByRole("button", { name: /^Planned/ }).click();
  await expect(page.getByTestId("launch-row").filter({ hasText: "Alerts bundle" })).toBeVisible();
  await expect(inspector(page)).toContainText("Alerts bundle");
  await expect(inspector(page).getByTestId("launch-state")).toHaveText("Planned");
  await expect(inspector(page).getByTestId("launch-items")).toContainText(first);
  await expect(inspector(page).getByTestId("launch-items")).toContainText(second);

  // The same items again: the API refuses with 409 and the dialog says so.
  await page.getByTestId("new-launch").click();
  await items.nth(0).getByRole("checkbox").check();
  await items.nth(1).getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Create launch" }).click();
  await expect(dialog).toContainText("These items already have a launch");
});

test("344b: an approver adds a task and a note in the launch inspector", async ({ page }) => {
  // protects=Add task (title, audience) and Add note (name, how to reach them, what they asked) on a launch;
  // fails_when=either is not offered, saves a blank one, or the new row does not show;
  // no_claim=drafting the note (Oracle's kit run).
  await start(page);
  await openDigest(page);
  const tasks = inspector(page).getByTestId("launch-task");
  const before = await tasks.count();
  await inspector(page).getByTestId("add-task").click();
  const taskForm = inspector(page).getByTestId("add-task-form");
  await expect(taskForm.getByRole("button", { name: "Add task" })).toBeDisabled();
  await taskForm.getByLabel("Task").fill("Brief the partner team");
  await taskForm.getByLabel("Audience").selectOption("external");
  await taskForm.getByRole("button", { name: "Add task" }).click();
  await expect(tasks).toHaveCount(before + 1);
  await expect(tasks.last()).toContainText("Brief the partner team");
  await expect(tasks.last()).toHaveAttribute("data-status", "todo");
  await expect(inspector(page).getByTestId("launch-task-stat")).toContainText(String(before + 1));

  await inspector(page).getByTestId("add-note").click();
  const noteForm = inspector(page).getByTestId("add-note-form");
  await expect(noteForm.getByRole("button", { name: "Add note" })).toBeDisabled();
  await noteForm.getByLabel("Name").fill("Ops lead at a trial company");
  await noteForm.getByLabel("How to reach them").fill("asked on a sales call");
  await noteForm.getByLabel("What they asked").fill("Can the digest go out on Mondays?");
  await noteForm.getByRole("button", { name: "Add note" }).click();
  const note = inspector(page).getByTestId("launch-note").filter({ hasText: "Ops lead at a trial company" });
  await expect(note).toBeVisible();
  await expect(note).toContainText("asked on a sales call");
  await expect(note).toContainText("Can the digest go out on Mondays?");
  await expect(note).toHaveAttribute("data-status", "drafted");
});

test("344c: an approver writes a changelog entry with New entry, then edits and publishes it", async ({ page }) => {
  // protects=New entry (category, audience, release date, title, what changed), then the existing Edit and Publish;
  // fails_when=New entry is missing, a public entry saves without its date, or the entry lands in the wrong day or category;
  // no_claim=the export's format (12e).
  await start(page);
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
  await page.getByTestId("new-entry").click();
  const dialog = page.getByTestId("new-entry-dialog");
  await dialog.getByLabel("Category").selectOption("fixed");
  await dialog.getByLabel("Audience").selectOption("public");
  await dialog.getByLabel("Released on").fill("");
  await dialog.getByLabel("Title").fill("Digest times follow the time zone");
  await expect(dialog.getByRole("button", { name: "Add entry" })).toBeDisabled();
  await dialog.getByLabel("Released on").fill("2026-10-21");
  await dialog.getByLabel("What changed").fill("The weekly digest goes out at 9:00 local time.");
  await dialog.getByRole("button", { name: "Add entry" }).click();
  await expect(dialog).toBeHidden();
  const day = page.getByTestId("changelog-day").filter({ has: page.locator('time[datetime="2026-10-21"]') });
  const fixed = day.locator('[data-testid="changelog-category"][data-category="fixed"]');
  const entry = fixed.getByTestId("changelog-entry").filter({ hasText: "Digest times follow the time zone" });
  await expect(entry).toHaveAttribute("data-status", "draft");
  await expect(entry).toContainText("Public");

  await entry.getByRole("button", { name: "Edit" }).click();
  await entry.getByLabel("Title").fill("Digest times follow your time zone");
  await entry.getByRole("button", { name: "Save" }).click();
  const edited = page.getByTestId("changelog-entry").filter({ hasText: "Digest times follow your time zone" });
  await expect(edited).toBeVisible();
  await edited.getByRole("button", { name: "Publish" }).click();
  await expect(edited).toHaveAttribute("data-status", "published");
});

test("344d: a viewer sees New launch, Add task, Add note and New entry disabled, with the reason", async ({ page }) => {
  // protects=the approver gate on every new create control, shown rather than hidden;
  // fails_when=a viewer can open a create form, or the control gives no reason;
  // no_claim=the API's 403 (API tests).
  await start(page, "viewer");
  await openDigest(page);
  for (const id of ["new-launch", "add-task", "add-note"]) {
    const button = page.getByTestId(id).filter({ visible: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", "Approvers plan launches and add tasks, notes and changelog entries");
  }
  await expect(page.getByText("Approvers plan launches and add tasks, notes and changelog entries").first()).toBeVisible();
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("new-entry")).toBeDisabled();
  await expect(page.getByTestId("new-entry")).toHaveAttribute("title", "Approvers plan launches and add tasks, notes and changelog entries");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("344e: at 390 px New launch and New entry fit the screen and work", async ({ page }) => {
    // protects=the dialogs at phone width: no horizontal scroll, every field reachable;
    // fails_when=a dialog overflows 390 px or its submit cannot be pressed;
    // no_claim=colour contrast (the design system's tokens).
    await start(page);
    await openLaunches(page);
    await page.getByTestId("new-launch").click();
    const dialog = page.getByTestId("new-launch-dialog");
    await dialog.getByTestId("launch-item-option").nth(0).getByRole("checkbox").check();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await dialog.getByRole("button", { name: "Create launch" }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.goto("/roadmap/changelog");
    await page.getByTestId("new-entry").click();
    const entry = page.getByTestId("new-entry-dialog");
    await entry.getByLabel("Title").fill("Phone entry");
    const ebox = await entry.boundingBox();
    expect(ebox!.x + ebox!.width).toBeLessThanOrEqual(390);
    await entry.getByRole("button", { name: "Add entry" }).click();
    await expect(page.getByTestId("changelog-entry").filter({ hasText: "Phone entry" })).toBeVisible();
  });
});
