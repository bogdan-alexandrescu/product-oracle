import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA findings on the Plan's tracks and Edit plan (group "plantracks"), driven through the UI
 * on the mock layer (NEXT_PUBLIC_API_MOCKS=1): Push to tracker while two-way sync is off
 * (qa-plan-8), Escape on inline editors (qa-plan-30), closing a track (qa-plan-31), roadmap
 * names (qa-plan-21), the approval state Edit plan states (qa-plan-17) and the Edit plan rows'
 * layout on a desktop and a phone (qa-plan-15, qa-plan-34).
 */


// qa4-plan-3: the Plan reads the roadmap document's approval; "plan-decider" has usage-alerts-roadmap v1
// approved (by default it is in review, so the Plan's rows are a draft's).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "plan-decider"] as const);
});

const track = (page: Page) => page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
const editor = (page: Page) => page.getByTestId("plan-milestone").filter({ visible: true });
const changes = (page: Page) => page.getByTestId("plan-changes").filter({ visible: true });
const editItem = (page: Page, title: string) => changes(page).getByTestId("edit-item").filter({ hasText: title });

async function openPlan(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(track(page)).toBeVisible();
}

async function openEditPlan(page: Page) {
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(editItem(page, "Budgets per team")).toBeVisible();
}

const box = async (l: Locator) => (await l.boundingBox())!;

// protects = qa-plan-8: with two-way tracker sync off, Push to tracker is disabled with the
// reason, and no HTTP status shows anywhere; fails_when = the button is offered and answers
// with an error such as "... (409)".
test("Push to tracker is disabled with the reason while two-way sync is off", async ({ page }) => {
  await openPlan(page);
  const push = track(page).getByRole("button", { name: "Push to tracker" });
  await expect(push).toBeDisabled();
  await expect(push).toHaveAccessibleDescription("Two-way tracker sync is off: Oracle makes no tracker writes. Use the read-only alignment report.");
  await expect(track(page)).not.toContainText(/\(\d{3}\)/);
});

// protects = qa-plan-30: Escape cancels Rename track and the milestone editor (Add milestone);
// fails_when = Escape leaves the inline editor open or keeps the typed title.
test("Escape cancels Rename track and Add milestone", async ({ page }) => {
  await openPlan(page);
  const t = track(page);
  await t.getByRole("button", { name: "Rename" }).click();
  await t.getByLabel("Track title").fill("Something else");
  await t.getByLabel("Track title").press("Escape");
  await expect(t.getByLabel("Track title")).toHaveCount(0);
  await expect(t.getByTestId("track-title")).toHaveText("Usage alerts PRD");
  await t.getByRole("button", { name: "Rename" }).click();
  await expect(t.getByLabel("Track title")).toHaveValue("Usage alerts PRD");
  await t.getByRole("button", { name: "Cancel" }).click();

  await t.getByRole("button", { name: "Add milestone" }).click();
  await expect(editor(page)).toContainText("New milestone");
  await editor(page).getByLabel("Name").fill("Weekly digest");
  await editor(page).getByLabel("Name").press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await expect(t.getByTestId("track-milestone").filter({ hasText: "Weekly digest" })).toHaveCount(0);
  // Cancel does the same.
  await t.getByRole("button", { name: "Add milestone" }).click();
  await editor(page).getByRole("button", { name: "Cancel" }).click();
  await expect(editor(page)).toHaveCount(0);
});

// protects = qa-plan-31: Closed asks first and says what closing does; Back keeps the track
// active; fails_when = one click closes the track with no word of what it does.
test("closing a track asks first and says what it does", async ({ page }) => {
  await openPlan(page);
  const t = track(page);
  const status = t.getByRole("group", { name: "Track status" });
  await status.getByRole("button", { name: "Closed" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Close track");
  await expect(dialog).toContainText("stops checking this track");
  await expect(dialog).toContainText("weekly alignment report leaves it out");
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(t.getByTestId("track-health")).toHaveText("At risk");

  await status.getByRole("button", { name: "Closed" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Close track" }).click();
  await expect(t.getByTestId("track-health")).toHaveText("Closed");
});

// protects = qa-plan-21 and qa-plan-17: the Roadmap header and Edit plan name the roadmap by its
// title, and Edit plan states the roadmap document's real approval state (approved in
// "plan-decider"); fails_when = the slug shows, or Edit plan calls an unapproved version approved.
test("Edit plan names the roadmap by its title and states its approval as the document does", async ({ page }) => {
  await openEditPlan(page);
  await expect(page.getByTestId("plan-live-version")).toHaveText("Usage alerts roadmap v1");
  await expect(changes(page)).toContainText("Changes to approved version 1 of Usage alerts roadmap");
  await expect(changes(page)).toContainText("Against approved version 1");
  await expect(changes(page)).not.toContainText("usage-alerts-roadmap");
});

// protects = qa-plan-34: every row's controls sit in fixed slots (Later's missing Defer keeps its
// slot), and a disabled Up/Down reads as disabled; fails_when = Up/Down/Cut shift right in Later,
// or a disabled Up looks like an enabled one.
test("Edit plan: the controls line up from row to row and disabled ones look disabled", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditPlan(page);
  const now = editItem(page, "Threshold alerts on spend");
  const later = editItem(page, "Budgets per team");
  for (const name of [/^Move .* up$/, /^Move .* down$/, /^Cut$/]) {
    const a = await box(now.getByRole("button", { name }));
    const b = await box(later.getByRole("button", { name }));
    expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
  }
  await expect(later.getByRole("button", { name: "Defer" })).toHaveCount(0);
  const up = now.getByRole("button", { name: "Move Threshold alerts on spend up" });
  await expect(up).toBeDisabled();
  expect(Number(await up.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.5);
  const down = now.getByRole("button", { name: "Move Threshold alerts on spend down" });
  await expect(down).toBeEnabled();
  expect(Number(await down.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
});

// protects = qa-plan-15: on a phone each Edit plan row has its title on its own line, whole,
// and its controls in one row below it; fails_when = the title is cut to a few letters or Cut
// wraps onto a line of its own.
test("phone: Edit plan rows put the title on its own line and the controls in one row", async ({ page }) => {
  await openEditPlan(page);
  // Edit plan opens on a wider screen; a draft stays open on the phone.
  await page.setViewportSize({ width: 390, height: 844 });
  const rows = changes(page).getByTestId("edit-item");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    const title = row.getByTestId("edit-item-title");
    const t = await box(title);
    const r = await box(row);
    // Whole title: nothing hidden by an ellipsis.
    expect(await title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const controls = [row.getByRole("combobox"), row.getByRole("button", { name: /up$/ }), row.getByRole("button", { name: /down$/ }), row.getByRole("button", { name: "Cut", exact: true })];
    const tops = await Promise.all(controls.map(async (c) => (await box(c)).y));
    for (const top of tops) {
      expect(Math.abs(top - tops[0]!)).toBeLessThanOrEqual(1);
      expect(top).toBeGreaterThanOrEqual(t.y + t.height - 1);
    }
    const cut = await box(row.getByRole("button", { name: "Cut", exact: true }));
    expect(cut.x + cut.width).toBeLessThanOrEqual(r.x + r.width);
  }
  expect(await changes(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
