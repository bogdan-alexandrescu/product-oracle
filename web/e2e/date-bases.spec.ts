import { expect, test, type Page } from "@playwright/test";

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

test("approver with a lead named: Record basis proposes, and the row shows Proposed", async ({ page }) => {
  // protects=AC12; fails_when=the submit says Verify for an approver while a lead is named,
  // or the row is verified at once; no_claim=the lead's Inbox (AC11).
  await asScenario(page, APPROVER);
  await openDates(page);
  await page.getByRole("button", { name: "Record basis" }).click();
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
  // (not built in this change).
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
  await expect(row(page, "ENG-412").getByTestId("withdrawn-reason")).toContainText("Withdrawn by Admin");
  await expect(row(page, "ENG-412").getByTestId("withdrawn-reason")).toContainText("The team re-estimated");

  const item = await openItem(page);
  const mark = item.locator('[data-date-mark="withdrawn"]');
  await expect(mark).toHaveText("date withdrawn");
  await mark.click();
  const popover = page.getByTestId("date-mark-popover");
  await expect(popover).toContainText("ENG-412 was withdrawn by Admin");
  await expect(popover).toContainText("The team re-estimated");
  await expect(popover.getByRole("button", { name: "Record a new basis" })).toBeVisible();
});

test("an unverified marker opens the popover; Record basis is pre-filled and verifying removes the marker", async ({ page }) => {
  // protects=AC14; fails_when=the marker is not a button, the dialog is not pre-filled with
  // the date and the reference the text names, or the marker stays after verifying;
  // no_claim=the run's import of the marker (API).
  await asScenario(page);
  const item = await openItem(page);
  const mark = item.locator('[data-date-mark="unverified"]');
  await expect(mark).toHaveText("unverified");
  await mark.click();
  const popover = page.getByTestId("date-mark-popover");
  await expect(popover).toContainText("No verified basis supports this date.");
  await popover.getByRole("button", { name: "Record basis" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  await expect(dialog.getByLabel("Date it supports")).toHaveValue("2026-12-15");
  await expect(dialog.getByLabel("Reference")).toHaveValue("ENG-413");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(item.locator("[data-date-mark]")).toHaveCount(0);
});

test("viewer: markers open the popover without buttons, and the Dates tab has no actions", async ({ page }) => {
  // protects=AC15; fails_when=a viewer is offered Record basis, Verify, Reject or Withdraw;
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
  await expect(page.getByRole("button", { name: "Record basis" })).toHaveCount(0);
});

test("phone: at 390 px the Dates tab renders rows as cards and the dialog fits the screen", async ({ page }) => {
  // protects=AC16; fails_when=the page scrolls sideways or the dialog is wider than the
  // screen; no_claim=a real phone's browser.
  await page.setViewportSize({ width: 390, height: 844 });
  await asScenario(page, LEAD);
  await page.goto("/plan/dates");
  const card = row(page, "ENG-420");
  await expect(card).toBeVisible();
  expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe("block");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Record basis" }).click();
  const box = await page.getByTestId("date-basis-dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
