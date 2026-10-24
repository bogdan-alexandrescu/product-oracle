import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * H6 Launches and changelog, driven through the UI as a person would, on the mock API
 * ("launches" scenario: Hard budget caps is Ready with Oracle's kit drafted and two people
 * who asked, Weekly usage digest is Planned, Usage export is Launched).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page, role?: "viewer" | "approver") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "launches"));
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
}

/** From the Roadmap documents page header (Plan › Roadmap documents), as a person gets there. */
async function openLaunches(page: Page) {
  await page.goto("/plan/documents");
  await page.getByTestId("roadmap-launches-link").click();
  await expect(page).toHaveURL(/\/roadmap\/launches$/);
  await expect(page.getByTestId("launches-table")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("launch-inspector").filter({ visible: true });
const task = (page: Page, key: string) => inspector(page).locator(`[data-testid="launch-task"][data-key="${key}"]`);

async function openCaps(page: Page) {
  await openLaunches(page);
  // Ready is the default filter while a launch is ready.
  await expect(page.getByTestId("launch-filters").getByRole("button", { name: /^Ready/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("launch-row").filter({ hasText: "Hard budget caps" }).click();
  await expect(inspector(page)).toContainText("Hard budget caps");
}

async function setTier1(page: Page) {
  await inspector(page).getByTestId("tier-1").click();
  await inspector(page).getByTestId("set-tier").click();
  await expect(inspector(page).getByTestId("launch-tier")).toHaveText("Tier 1");
}

/** The text of the Inbox's "Notes to send" row, whichever state tab (New or Open) it is under. */
async function notesToSend(page: Page): Promise<string> {
  await page.getByTestId("nav-inbox").first().click();
  await expect(page).toHaveURL(/\/inbox$/);
  let text = "";
  await expect
    .poll(async () => {
      for (const name of ["New", "Open"]) {
        await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: new RegExp(`^${name}`) }).click();
        const panel = page.getByTestId(`inbox-tab-${name.toLowerCase()}`);
        await expect(panel).toBeVisible();
        const row = panel.getByTestId("launch-need").filter({ hasText: "Notes to send" });
        if (await row.count()) {
          text = (await row.first().innerText()).trim();
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return text;
}

test("12a: an approver filters Ready, sees Oracle's suggested tier and sets Tier 1: 12 tasks", async ({ page }) => {
  // protects=the Ready filter, the "Tier 1 suggested" line with its reason, Set tier, the Tier 1 checklist;
  // fails_when=the suggestion or its reason is missing, Set tier does not stick, or the checklist is not 12 tasks;
  // no_claim=the tier matrix itself (API unit tests).
  await start(page);
  await openLaunches(page);
  await page.getByTestId("launch-filters").getByRole("button", { name: /^All/ }).click();
  await expect(page.getByTestId("launch-row")).toHaveCount(3);
  await page.getByTestId("launch-filters").getByRole("button", { name: /^Ready/ }).click();
  await expect(page.getByTestId("launch-row")).toHaveCount(1);
  await page.getByTestId("launch-row").filter({ hasText: "Hard budget caps" }).click();
  await expect(inspector(page).getByTestId("launch-tier")).toHaveText(/^Tier 1 suggested · New feature serving a top goal/);
  await setTier1(page);
  await expect(inspector(page).getByTestId("launch-task")).toHaveCount(12);
  await expect(page.getByTestId("launch-row").first().getByTestId("launch-tier-chip")).toHaveText("Tier 1");
});

test("12b: the approver edits Oracle's support notes and marks the task done: 1 of 12", async ({ page }) => {
  // protects=Open draft (an editable text), Save, Done, the task count; fails_when=the edit is lost, Done does not
  // close the task, or the count does not move; no_claim=what Oracle's kit run writes (API kit tests).
  await start(page);
  await openCaps(page);
  await setTier1(page);
  const support = task(page, "support_notes");
  await expect(support).toHaveAttribute("data-status", "drafted");
  await support.getByRole("button", { name: "Open draft" }).click();
  const text = support.getByRole("textbox", { name: /Draft of Support notes/ });
  await expect(text).toHaveValue(/^What changed: projects can have a hard monthly cap/);
  await text.fill("What changed: each project can have a hard monthly cap.\nKnown limits: one cap per project.");
  await support.getByRole("button", { name: "Save draft" }).click();
  await expect(support.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await support.getByRole("button", { name: "Done" }).click();
  await expect(support).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("launch-row").filter({ hasText: "Hard budget caps" }).getByTestId("launch-tasks-count")).toHaveText("1 of 12");
  // The edit stuck: after a reload, the draft holds the edited text.
  await page.reload();
  await page.getByTestId("launch-row").filter({ hasText: "Hard budget caps" }).click();
  await task(page, "support_notes").getByRole("button", { name: "Open draft" }).click();
  await expect(task(page, "support_notes").getByRole("textbox")).toHaveValue(/each project can have a hard monthly cap/);
});

test("12c: Mark launched lists the open tasks; confirming sets Launched and the notes list two people", async ({ page }) => {
  // protects=the advisory confirm dialog naming open tasks (and the Tier 1 pre-mortem line), the Launched chip, the
  // requesters; fails_when=the dialog does not list open tasks, Back still launches, or the notes are missing;
  // no_claim=the ship signal to H3 (API test).
  await start(page);
  await openCaps(page);
  await setTier1(page);
  await inspector(page).getByTestId("mark-launched").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Release notes");
  await expect(dialog).toContainText("Positioning check");
  await expect(dialog).toContainText("The pre-mortem has not been done");
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(inspector(page).getByTestId("launch-state")).toHaveText("Ready");

  await inspector(page).getByTestId("mark-launched").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Mark launched" }).click();
  await expect(inspector(page).getByTestId("launch-state")).toHaveText("Launched");
  await expect(inspector(page).getByTestId("mark-launched")).toHaveCount(0);
  const notes = inspector(page).getByTestId("launch-note");
  await expect(notes).toHaveCount(2);
  await expect(notes.first()).toContainText("commenter@example.com");
  await expect(notes.nth(1)).toContainText("Pilot customer contact");
});

test("12d: the approver copies a note, marks it sent by email, and the Inbox count drops by one", async ({ page, context }) => {
  // protects=Copy puts the draft on the clipboard, Mark sent by email, the Inbox "Notes to send" count;
  // fails_when=the clipboard is empty or holds something else, the note stays To send, or the count does not drop;
  // no_claim=that the person really sent it (Oracle never sends).
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(page);
  await openCaps(page);
  await inspector(page).getByTestId("mark-launched").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Mark launched" }).click();
  await expect(inspector(page).getByTestId("launch-state")).toHaveText("Launched");

  expect(await notesToSend(page)).toBe("Notes to send · Hard budget caps · 2");
  await page.getByTestId("launch-need").filter({ hasText: "Notes to send" }).locator("xpath=ancestor::tr").getByRole("link", { name: "Open" }).click();
  await expect(inspector(page)).toContainText("Hard budget caps");

  const note = inspector(page).getByTestId("launch-note").filter({ hasText: "Pilot customer contact" });
  const draft = (await note.getByTestId("note-draft").innerText()).trim();
  await note.getByRole("button", { name: "Copy" }).click();
  await expect(note.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(draft);

  await note.getByRole("button", { name: "Mark sent" }).click();
  await note.getByTestId("mark-sent-form").getByLabel("Sent by").selectOption("email");
  await note.getByRole("button", { name: "Save as sent" }).click();
  await expect(note).toHaveAttribute("data-status", "sent");
  await expect(note).toContainText("Email");

  expect(await notesToSend(page)).toBe("Notes to send · Hard budget caps · 1");
});

test("12e: the changelog shows the launch's entry under Added; Publish and Export Markdown carry it", async ({ page }) => {
  // protects=grouping by date then category, Publish, the Markdown export of published public entries;
  // fails_when=the entry is not under Added, stays Draft, or the export misses it (or carries a draft);
  // no_claim=posting it anywhere (a person does).
  await start(page);
  await page.goto("/plan/documents");
  await page.getByTestId("roadmap-changelog-link").click();
  await expect(page).toHaveURL(/\/roadmap\/changelog$/);
  const added = page.getByTestId("changelog-category").filter({ has: page.getByRole("heading", { name: "Added" }) });
  const entry = added.getByTestId("changelog-entry").filter({ hasText: "Hard budget caps" });
  await expect(entry).toBeVisible();
  await expect(entry.getByTestId("entry-status")).toHaveText("Draft");
  // Newest day first.
  await expect(page.getByTestId("changelog-day").first().locator("time")).toHaveText("2026-10-20");

  await entry.getByRole("button", { name: "Publish" }).click();
  await expect(entry.getByTestId("entry-status")).toHaveText("Published");

  const download = page.waitForEvent("download");
  await page.getByTestId("export-md").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("changelog.md");
  const md = await readFile((await file.path())!, "utf8");
  expect(md).toContain("## 2026-10-20");
  expect(md).toContain("### Added");
  expect(md).toContain("- **Hard budget caps**");
  expect(md.indexOf("## 2026-10-20")).toBeLessThan(md.indexOf("## 2026-10-10"));
  // Internal and draft entries never leave Oracle.
  expect(md).not.toContain("Usage page loads from the new store");
});

test("12f: a viewer sees no Set tier, Mark launched or Publish", async ({ page }) => {
  // protects=the role gates in the UI; fails_when=a viewer is offered an approver's control;
  // no_claim=the API's own 403s (API tests).
  await start(page, "viewer");
  await openCaps(page);
  await expect(inspector(page).getByTestId("launch-tier")).toContainText("Tier 1 suggested");
  await expect(inspector(page).getByTestId("set-tier")).toHaveCount(0);
  await expect(inspector(page).getByTestId("mark-launched")).toHaveCount(0);
  await expect(inspector(page).getByRole("button", { name: "Done" })).toHaveCount(0);
  await page.goto("/roadmap/changelog");
  await expect(page.getByTestId("changelog-entry").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("12g: at 390 px the table keeps Launch, Tier and State with no horizontal scroll", async ({ page }) => {
    // protects=the phone layout of the launch table and the inspector as a sheet; fails_when=the page scrolls
    // sideways, a kept column is hidden or a dropped one shows; no_claim=every phone width.
    await start(page);
    await page.goto("/roadmap/launches");
    const row = page.getByTestId("launch-row").first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Hard budget caps");
    await expect(row.getByTestId("launch-tier-chip")).toBeVisible();
    await expect(row.getByTestId("launch-state")).toBeVisible();
    await expect(row.getByTestId("launch-tasks-count")).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The inspector opens as a sheet; copying a note is one tap.
    await row.click();
    const sheet = page.getByTestId("launch-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("launch-inspector")).toContainText("Hard budget caps");
    await expect(sheet.getByTestId("launch-note").first().getByRole("button", { name: "Copy" })).toBeVisible();
  });
});
