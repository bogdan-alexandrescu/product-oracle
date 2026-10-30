import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";

/**
 * F3 Date bases: the engineering lead records and verifies the estimates dates rest on, and
 * every withdrawn date is marked. On the mock layer, driven as a person would. The
 * "date-bases" scenario names commenter@example.com engineering lead; ENG-412 (verified)
 * supports the Beta date 2026-11-30, the GA date 2026-12-15 has no basis, and the
 * approver's ENG-420 waits as Proposed. Each test states its card.
 */

const LEAD = "commenter@example.com";
const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";

async function asScenario(page: Page, email?: string) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, DATE_BASES_SCENARIO]);
  await login(page, email);
}

async function openDates(page: Page) {
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Dates" }).click();
  await expect(page).toHaveURL(/\/plan\/dates$/);
}

const row = (page: Page, reference: string) => page.getByTestId("dates-table").locator(`[data-basis="${reference}"]`).filter({ visible: true });

async function openItem(page: Page) {
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
  return openSection(page, "item-behaviour");
}

test("lead: Plan › Dates shows the proposed basis; Verify turns it Verified and the Inbox row goes", async ({ page }) => {
  // protects=AC11; fails_when=the proposed row is missing, Verify leaves it proposed, or the
  // Inbox keeps the row; no_claim=the API's rights (api/tests/test_schedule_bases_verify.py).
  await asScenario(page, LEAD);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-date").filter({ visible: true })).toContainText("ENG-420 supports Jan 15");
  await openDates(page);
  await expect(page.getByTestId("dates-filter").getByRole("button", { name: /Proposed/ })).toHaveAttribute("aria-pressed", "true");
  const proposed = row(page, "ENG-420");
  await expect(proposed).toContainText("Proposed by Approver");
  await proposed.getByRole("button", { name: "Verify" }).click();
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await expect(row(page, "ENG-420")).toHaveAttribute("data-status", "verified");
  await expect(row(page, "ENG-420")).toContainText("Verified by Commenter");
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-date")).toHaveCount(0);
});

test("approver with a lead named: Add a date source proposes, and the row shows Proposed", async ({ page }) => {
  // protects=AC12; fails_when=the submit says Verify for an approver while a lead is named,
  // or the row is verified at once; no_claim=the lead's Inbox (AC11).
  await asScenario(page, APPROVER);
  await openDates(page);
  await page.getByRole("button", { name: "Add a date source" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  await dialog.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await dialog.getByLabel("Reference").fill("CAP-7");
  await dialog.getByLabel("Date it supports").fill("2027-02-01");
  await expect(dialog).toContainText("The engineering lead verifies it before any date rests on it.");
  await dialog.getByRole("button", { name: "Propose for verification" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "CAP-7")).toHaveAttribute("data-status", "proposed");
  // An approver neither verifies nor rejects.
  await expect(row(page, "CAP-7").getByRole("button", { name: "Verify" })).toHaveCount(0);
});

test("withdraw: the impact sentence comes first; afterwards the roadmap marks the date withdrawn with the reason", async ({ page }) => {
  // protects=AC13 (the document half); fails_when=Withdraw needs no reason, shows no impact,
  // or the marker does not say who withdrew it and why; no_claim=the Plan inspector line
  // (the Plan inspector tests below).
  await asScenario(page);
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await row(page, "ENG-412").getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByTestId("withdraw-basis-dialog");
  await expect(dialog.getByTestId("withdraw-impact")).toContainText("This removes Nov 30 from:");
  await expect(dialog.getByTestId("withdraw-impact")).toContainText("place will show 'date withdrawn'");
  const confirm = dialog.getByRole("button", { name: "Withdraw date basis" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason").fill("The team re-estimated");
  await confirm.click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("dates-filter").getByRole("button", { name: "Withdrawn" }).click();
  await expect(row(page, "ENG-412")).toContainText("Withdrawn by Admin");
  await expect(row(page, "ENG-412")).not.toContainText("Verified by");
  await expect(page.getByTestId("dates-table").locator('[data-reason-for="ENG-412"]').filter({ visible: true })).toContainText("The team re-estimated");

  const item = await openItem(page);
  const mark = item.locator('[data-date-mark="withdrawn"]');
  await expect(mark).toHaveText("date withdrawn");
  await mark.click();
  const popover = page.getByTestId("date-mark-popover");
  await expect(popover).toContainText("ENG-412 was withdrawn by Admin");
  await expect(popover).toContainText("The team re-estimated");
  await expect(popover.getByRole("button", { name: "Add a new date source" })).toBeVisible();
});

test("an unverified marker opens the popover; Add a date source is pre-filled and verifying removes the marker", async ({ page }) => {
  // protects=AC14; fails_when=the marker is not a button, the dialog is not pre-filled with
  // the date and the reference the text names, or the marker stays after verifying;
  // no_claim=the run's import of the marker (API).
  await asScenario(page);
  const item = await openItem(page);
  const mark = item.locator('[data-date-mark="unverified"]');
  await expect(mark).toHaveText("unverified");
  await mark.click();
  const popover = page.getByTestId("date-mark-popover");
  // qa-plan-21: the popover says what the button beside it says: a date source, not a "basis".
  await expect(popover).toContainText("No date source backs this date yet.");
  await expect(popover).not.toContainText("basis");
  await popover.getByRole("button", { name: "Add a date source" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-12-15");
  await expect(dialog.getByLabel("Reference")).toHaveValue("ENG-413");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(item.locator("[data-date-mark]")).toHaveCount(0);
});

test("viewer: markers open the popover without buttons, and the Dates tab has no actions", async ({ page }) => {
  // protects=AC15; fails_when=a viewer is offered Add a date source, Verify, Reject or Withdraw;
  // no_claim=the API's 403s (pytest).
  await asScenario(page, VIEWER);
  const item = await openItem(page);
  await item.locator('[data-date-mark="unverified"]').click();
  const popover = page.getByTestId("date-mark-popover");
  await expect(popover).toContainText("The engineering lead verifies dates");
  await expect(popover.getByRole("button")).toHaveCount(0);
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: "All" }).click();
  await expect(row(page, "ENG-420")).toBeVisible();
  const table = page.getByTestId("dates-table");
  await expect(table.getByRole("button", { name: /Verify|Reject|Withdraw/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a date source" })).toHaveCount(0);
});

test("phone: at 390 px the Dates tab renders rows as cards and the dialog fits the screen", async ({ page }) => {
  // protects=AC16; fails_when=the page scrolls sideways or the dialog is wider than the
  // screen; no_claim=a real phone's browser.
  await page.setViewportSize({ width: 390, height: 844 });
  await asScenario(page, LEAD);
  await page.goto("/plan/dates");
  const card = row(page, "ENG-420");
  await expect(card).toBeVisible();
  // B1 phone frames (components/ds/DataTable.tsx): a DataTable row on a phone is a stacked,
  // wrapping flex block (title, action, meta), no longer a table row.
  expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Add a date source" }).click();
  const box = await page.getByTestId("date-basis-dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });

async function selectPlanItem(page: Page, title: string) {
  await page.goto("/plan");
  await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
  return inspector(page).getByTestId("plan-date");
}

test("plan inspector: a withdrawn date is struck through with its reason, and Re-verify date records a new basis", async ({ page }) => {
  // protects=AC13 (the Plan half); fails_when=the inspector's date line does not name the
  // basis and who verified it, stays verified after Withdraw, shows no reason, offers no
  // Re-verify date, or a basis the roadmap's date does not name verifies it or is shown as
  // the one it rests on (the API's schedule.supporting: the reference must appear in the
  // date's source, here ENG-412, and the plan's engineering.basis_ids lists those bases);
  // no_claim=the API's plan rules (api/tests/test_plan.py).
  await asScenario(page);
  let line = await selectPlanItem(page, "Daily alert digest email");
  await expect(line).toContainText("Nov 30 ✓ ENG-412, verified by Admin");

  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await row(page, "ENG-412").getByRole("button", { name: "Withdraw" }).click();
  const withdraw = page.getByTestId("withdraw-basis-dialog");
  await withdraw.getByLabel("Reason").fill("The team re-estimated");
  await withdraw.getByRole("button", { name: "Withdraw date basis" }).click();
  await expect(withdraw).toBeHidden();

  line = await selectPlanItem(page, "Daily alert digest email");
  await expect(line.locator("s")).toHaveText("Nov 30");
  await expect(line).toContainText("date withdrawn");
  await expect(line).toContainText("The team re-estimated");
  await line.getByRole("button", { name: "Re-verify date" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-11-30");
  await expect(dialog.getByLabel("Item")).toHaveValue("alert-digest");
  // ENG-450 supports Nov 30 for this item, but the roadmap's date names ENG-412: still withdrawn.
  await dialog.getByLabel("Reference").fill("ENG-450");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toBeHidden();
  line = await selectPlanItem(page, "Daily alert digest email");
  await expect(line).toContainText("date withdrawn");
  await expect(line).not.toContainText("✓");
  // A new basis under the reference the date names verifies it again.
  await line.getByRole("button", { name: "Re-verify date" }).click();
  await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-11-30");
  await dialog.getByLabel("Reference").fill("ENG-412");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(line).toContainText("Nov 30 ✓ ENG-412, verified by Admin");
  // A later basis on the same date and item that the date does not name is not what it rests on.
  await openDates(page);
  await page.getByRole("button", { name: "Add a date source" }).click();
  await dialog.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await dialog.getByLabel("Reference").fill("CAP-9");
  await dialog.getByLabel("Date it supports").fill("2026-11-30");
  await dialog.getByLabel("For").selectOption("item");
  await dialog.getByLabel("Item").selectOption("alert-digest");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await expect(row(page, "CAP-9")).toHaveAttribute("data-status", "verified");
  line = await selectPlanItem(page, "Daily alert digest email");
  await expect(line).toContainText("Nov 30 ✓ ENG-412, verified by Admin");
  await expect(line).not.toContainText("CAP-9");
});

test("plan inspector: an unverified date offers Verify date; the dialog picks the item and the tracker record", async ({ page }) => {
  // protects=AC13 (unverified line) and the Add a date source dialog's pickers (§2); fails_when=
  // One item is a free-text key, there is no tracker-record picker, the record does not fill
  // Reference and Date, its id is not sent (the API then cannot check the record's target), or
  // a basis the date does not name (CAP-9; the date's source is ENG-431) verifies it;
  // no_claim=the API's record checks (api/tests/test_schedule_bases_verify.py).
  await asScenario(page);
  let line = await selectPlanItem(page, "Alerts in the team chat");
  await expect(line).toContainText("Dec 15 · unverified");
  await line.getByRole("button", { name: "Verify date" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  await dialog.getByLabel("Reference").fill("CAP-9");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toBeHidden();
  line = await selectPlanItem(page, "Alerts in the team chat");
  await expect(line).toContainText("Dec 15 · unverified");
  await expect(line).not.toContainText("✓");
  await line.getByRole("button", { name: "Verify date" }).click();
  await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-12-15");
  await expect(dialog.getByLabel("For")).toHaveValue("item");
  const itemPicker = dialog.getByLabel("Item");
  await expect(itemPicker).toHaveValue("slack-alerts");
  await expect(itemPicker.locator("option", { hasText: "Daily alert digest email" })).toHaveCount(1);

  await dialog.getByLabel("From a tracker record (optional)").selectOption({ label: "ENG-431 · Alerts in the team chat · Dec 15" });
  await expect(dialog.getByLabel("Reference")).toHaveValue("ENG-431");
  await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-12-15");
  // The record's own target is the date: another date is refused because the record is sent.
  await dialog.getByLabel("Date it supports").fill("2026-12-20");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toContainText(/tracker record ENG-431 targets 2026-12-15, not 2026-12-20/i);
  await dialog.getByLabel("Date it supports").fill("2026-12-15");
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(line).toContainText("Dec 15 ✓ ENG-431, verified by Admin");
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await expect(row(page, "ENG-431")).toContainText("Item: Alerts in the team chat");
});
