import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * F7 Link tracker issues, driven through the Plan's UI on the mock layer (NEXT_PUBLIC_API_MOCKS=1).
 *
 * The synced GitHub issues are mock rows (lib/api/mock/roadmap.ts, SYNCED_ISSUES): acme/app#412
 * "Saved cards checkout" (open, milestone Beta due 2026-11-30) and acme/app#418, already linked to
 * "Spend forecast for the month". GitHub is never called. The API's rules (state mapping, scoping,
 * refresh on sync) are proven by api/tests/test_tracker_links.py; these tests prove what a person
 * sees and does. Each test gets a fresh browser context, hence a freshly seeded mock.
 */

async function asRole(page: Page, role: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const cell = (page: Page, title: string) => row(page, title).getByTestId("plan-engineering");
const dialog = (page: Page) => page.getByRole("dialog", { name: /^Link a GitHub issue to / });
const results = (page: Page) => dialog(page).getByTestId("link-issue-result");

/** The Plan with only approved items, where an untracked Now item reads "Untracked". */
async function openApprovedPlan(page: Page) {
  await login(page);
  await page.goto("/plan");
  await expect(rows(page).first()).toBeVisible();
  await page.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved only" }).click();
  await expect(rows(page)).toHaveCount(7);
}

// protects = 11: an untracked Now item's Link issue opens the dialog, "#412" finds the issue
// with its state and milestone, the sharing line shows, and Link puts it in the Engineering
// cell with its milestone date; fails_when = the button is missing, the search misses "#412",
// the sharing line is gone, or the cell keeps "Untracked"; no_claim = GitHub sync or the API's
// state and date parsing (synced issues are mock rows; GitHub is not called).
test("Link issue on an untracked Now item links #412 and the cell reads its date", async ({ page }) => {
  await openApprovedPlan(page);
  await expect(cell(page, "Usage dashboard")).toHaveText("Untracked");
  await row(page, "Usage dashboard").getByRole("button", { name: "Link issue" }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading")).toHaveText("Link a GitHub issue to Usage dashboard");
  await dialog(page).getByRole("searchbox", { name: "Search your GitHub issues" }).fill("#412");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page)).toHaveText("acme/app#412 · Saved cards checkout · Open · milestone Beta (Nov 30)");
  await expect(dialog(page).getByTestId("link-issue-sharing")).toHaveText(
    "Everyone who can see the Plan will see this issue's number, title, state and link.",
  );
  await results(page).click();
  await dialog(page).getByRole("button", { name: "Link", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(cell(page, "Usage dashboard")).toHaveText("Issue 412 · Nov 30 ✓");
  // An issue that is not among the synced ones says where to add it.
  await row(page, "Usage dashboard").click();
  await page.getByTestId("plan-inspector").filter({ visible: true }).getByRole("button", { name: "+ Link issue" }).click();
  await dialog(page).getByRole("searchbox").fill("other/repo#9");
  await expect(dialog(page).getByTestId("link-issue-none")).toHaveText("Add its repository as a GitHub source in Settings › Sources first.");
});

// protects = 12: linking an issue linked to another item names that item and asks "Move it
// from <item>?" first; confirming moves it (the old item reads Untracked again); fails_when =
// the issue is linked twice, moved without asking, or the question names the wrong item;
// no_claim = the API's 409 and audit (api/tests/test_tracker_links.py).
test("linking an issue linked elsewhere asks to move it; confirming moves it", async ({ page }) => {
  await openApprovedPlan(page);
  await expect(cell(page, "Spend forecast for the month")).toHaveText("Issue 418 · Nov 30 ✓");
  await row(page, "Usage dashboard").getByRole("button", { name: "Link issue" }).click();
  await dialog(page).getByRole("searchbox").fill("forecast");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).getByTestId("link-issue-linked")).toHaveText("Linked to Spend forecast for the month (Usage alerts PRD)");
  await results(page).click();
  await dialog(page).getByRole("button", { name: "Link", exact: true }).click();
  const ask = page.getByRole("alertdialog", { name: "Move" });
  await expect(ask).toContainText("Move it from Spend forecast for the month?");
  await ask.getByRole("button", { name: "Move" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(cell(page, "Usage dashboard")).toHaveText("Issue 418 · Nov 30 ✓");
  await expect(cell(page, "Spend forecast for the month")).toHaveText("Untracked");
});

// protects = 13: each linked issue is its own line in the inspector with Unlink, and Unlink
// returns the item's cell to "Untracked"; fails_when = Unlink is missing or the cell keeps the
// issue; no_claim = the record kept for its history (API).
test("Unlink from the inspector returns the cell to Untracked", async ({ page }) => {
  await openApprovedPlan(page);
  await row(page, "Spend forecast for the month").click();
  const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
  await expect(inspector.getByRole("heading", { name: "Spend forecast for the month" })).toBeVisible();
  const line = inspector.getByTestId("plan-record");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("acme/app#418 · Open · due Nov 30 in the tracker");
  await line.getByRole("button", { name: "Unlink" }).click();
  await expect(cell(page, "Spend forecast for the month")).toHaveText("Untracked");
  await expect(inspector.getByTestId("plan-record")).toHaveCount(0);
  await expect(row(page, "Spend forecast for the month").getByTestId("plan-next")).toHaveText("Link issue");
});

// protects = 14: a commenter sees the linked issue in the inspector but no Link issue or Unlink
// anywhere on the Plan; fails_when = a commenter is offered either; no_claim = the API's 403
// (api/tests/test_tracker_links.py).
test("a commenter sees the linked issue with no Link or Unlink buttons", async ({ page }) => {
  await asRole(page, "commenter");
  await openApprovedPlan(page);
  await row(page, "Spend forecast for the month").click();
  const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
  await expect(inspector.getByTestId("plan-record")).toContainText("acme/app#418 · Open · due Nov 30 in the tracker");
  await expect(inspector.getByRole("link", { name: "acme/app#418" })).toHaveAttribute("href", "https://github.com/acme/app/issues/418");
  await expect(inspector.getByRole("button", { name: "Unlink" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "+ Link issue" })).toHaveCount(0);
  await expect(row(page, "Usage dashboard").getByTestId("plan-next")).toHaveText("Approvers link a tracker issue");
  await expect(page.getByRole("button", { name: "Link issue" })).toHaveCount(0);
});

// protects = 15: at 390 px the dialog fits the screen and its results are full-width tappable
// rows (44 px at least) that pick an issue; fails_when = the dialog is wider than the screen or scrolls sideways,
// or a row is too small to tap; no_claim = a real phone's browser.
test("phone: the dialog fits 390 px and its results are tappable rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/plan");
  // A tap on the title (a tap on the goal chip opens the goal's card instead).
  await row(page, "Usage dashboard").getByTestId("plan-title").click();
  const sheet = page.getByTestId("sheet-plan-item");
  await sheet.getByRole("button", { name: "+ Link issue" }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(results(page)).toHaveCount(4);
  const box = (await dialog(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const list = (await dialog(page).getByRole("list", { name: "Your GitHub issues" }).boundingBox())!;
  for (const r of await results(page).all()) {
    const b = (await r.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(Math.round(b.width)).toBeGreaterThanOrEqual(Math.floor(list.width) - 2);
  }
  // Nothing in the dialog scrolls sideways.
  expect(await dialog(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await results(page).filter({ hasText: "acme/app#425" }).click();
  await expect(results(page).filter({ hasText: "acme/app#425" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog(page).getByRole("button", { name: "Link", exact: true })).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Link", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(cell(page, "Usage dashboard")).toHaveText(/^Issue 425/);
});
