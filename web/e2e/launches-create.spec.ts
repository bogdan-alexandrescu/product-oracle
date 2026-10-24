import { expect, test, type Page } from "./test";

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

test("344d: a viewer, who can never create, does not see New launch, Add task, Add note or New entry", async ({ page }) => {
  // protects=the owner rule (#370): a control a role can never use is hidden, not disabled;
  // fails_when=a viewer sees any of the four create controls, disabled or not, or the approvers-only reason;
  // no_claim=the API's 403 (API tests); the View only label (#370).
  await start(page, "viewer");
  await openDigest(page);
  await expect(page.getByTestId("launch-row").first()).toBeVisible();
  for (const id of ["new-launch", "add-task", "add-note"]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  await expect(page.getByText("Approvers plan launches and add tasks, notes and changelog entries")).toHaveCount(0);
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
  await expect(page.getByTestId("new-entry")).toHaveCount(0);
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


/** WCAG contrast of an element's text on the first opaque background behind it. */
async function contrastOf(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    let bg: number[] | null = null;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length === 3 || c[3] > 0.9)) {
        bg = c;
        break;
      }
    }
    const fg = lum(rgb(getComputedStyle(el).color));
    const back = lum(bg ?? [255, 255, 255]);
    return { ratio: (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05), dark: back < 0.2 };
  });
}

test("344f: in the dark theme New launch, Add task, Add note and New entry read well", async ({ page }) => {
  // protects=the four create forms in the dark theme, picked from the user menu as a person would: dark surfaces,
  // labels, fields and buttons at WCAG AA (4.5:1) or better;
  // fails_when=a form keeps a light surface, or any of its text drops below 4.5:1 on its background;
  // no_claim=pixel-level design review; the light theme's contrast (the design system's tokens).
  await page.emulateMedia({ colorScheme: "light" });
  await start(page);
  await page.getByTestId("user-menu").click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");

  const readsWell = async (form: ReturnType<Page["locator"]>, what: string) => {
    await expect(form).toBeVisible();
    expect((await contrastOf(form)).dark, `${what}: the form sits on a dark surface`).toBe(true);
    const texts = form
      .locator("h2, legend, label, p, input:not([type=checkbox]), select, textarea, button")
      .filter({ visible: true });
    const n = await texts.count();
    expect(n, `${what}: has fields`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const el = texts.nth(i);
      const { ratio } = await contrastOf(el);
      const name = await el.evaluate((e) => `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 40)}"`);
      expect(ratio, `${what}: ${name} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  };

  await openLaunches(page);
  await page.getByTestId("new-launch").click();
  const launch = page.getByTestId("new-launch-dialog");
  await launch.getByTestId("launch-item-option").nth(0).getByRole("checkbox").check();
  await readsWell(launch, "New launch");
  await launch.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeHidden();

  await page.getByTestId("launch-filters").getByRole("button", { name: /^Planned/ }).click();
  await page.getByTestId("launch-row").filter({ hasText: "Weekly usage digest" }).click();
  await inspector(page).getByTestId("add-task").click();
  await readsWell(inspector(page).getByTestId("add-task-form"), "Add task");
  await inspector(page).getByTestId("add-note").click();
  await readsWell(inspector(page).getByTestId("add-note-form"), "Add note");

  await page.goto("/roadmap/changelog");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("new-entry").click();
  const entry = page.getByTestId("new-entry-dialog");
  await entry.getByLabel("Title").fill("Dark theme entry");
  await readsWell(entry, "New entry");
  await entry.getByRole("button", { name: "Add entry" }).click();
  await expect(page.getByTestId("changelog-entry").filter({ hasText: "Dark theme entry" })).toBeVisible();
});
