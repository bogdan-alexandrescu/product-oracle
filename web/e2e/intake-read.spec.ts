import { expect, test, type Page } from "./test";

import { V2_IDS } from "../lib/api/mock/v2";
import { login } from "./helpers";

/*
 * INT2, the parts of Oracle's read of a brief that live outside the brief page (port of #632):
 * Settings › Company's switch "Oracle reads new briefs" (the company setting intake_ai_read,
 * owners only, as GET and PUT /v1/settings/{key} are), and the Inbox row "Oracle couldn't read
 * <title>" (InboxOut.intake_reads: an open brief of mine whose last two reads or more failed).
 * The "intake-read-failed-twice" mock scenario adds "Bulk order invoices", a brief by the
 * signed-in owner whose last two reads failed. All data is invented.
 *
 * Test cards:
 * - "switch": protects=an owner turns Oracle's read off and on from Settings › Company, the
 *   switch keeps the owner's choice while it saves, and a brief then says the read is off
 *   with no Analyse with Oracle; fails_when=no switch, it flips back while saving, the choice
 *   does not persist, or the brief still offers a read; no_claim=the API's 409 on ai-read
 *   (api/tests/test_intake_read*.py).
 * - "approver": protects=only owners see the switch; fails_when=an approver sees it;
 *   no_claim=the API's 403 (owner-only settings).
 * - "Inbox row": protects=two failed reads in a row raise one row that opens the brief, and a
 *   read that succeeds clears it; fails_when=the row is missing, opens elsewhere, or stays
 *   after Try again; no_claim=the API's failure count (oracle.intake.read).
 * - "phone": protects=the switch and the row at 390 px; fails_when=either is cut or the page
 *   scrolls sideways.
 */

const PHONE = { width: 390, height: 844 };
const SWITCH = "Oracle reads new briefs ($1.50 each)";
const FAILED_TITLE = "Bulk order invoices";
const FAILED_SCENARIO = "intake-read-failed-twice";

const toggle = (page: Page) => page.getByRole("switch", { name: SWITCH });
const panel = (page: Page) => page.getByTestId("intake-read-setting");
const readLine = (page: Page) => page.getByTestId("intake-read");
const failedRow = (page: Page) => page.getByTestId("inbox-intake-reads").locator("tr[data-row]").filter({ hasText: `Oracle couldn't read ${FAILED_TITLE}` });

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
}

async function openCompanySettings(page: Page) {
  await page.goto("/settings/company");
  await expect(page.getByRole("heading", { level: 1, name: "Company" })).toBeVisible();
}

test("switch: an owner turns Oracle's read off on Settings › Company; it shows the choice while saving, and a brief is not read", async ({ page }) => {
  await login(page);
  await openCompanySettings(page);
  await expect(toggle(page)).toBeChecked();
  await expect(toggle(page)).toBeEnabled();

  // The save answers late: the switch keeps the owner's choice meanwhile, waiting.
  await page.evaluate(() => {
    localStorage.setItem("po-mock-slow", "PUT /v1/settings/intake_ai_read");
    localStorage.setItem("po-mock-slow-ms", "2500");
  });
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(toggle(page)).toBeDisabled();
  await expect(panel(page).getByRole("status")).toHaveCount(0);
  await expect(panel(page).getByRole("status")).toContainText("Saved");
  await expect(toggle(page)).not.toBeChecked();
  await expect(toggle(page)).toBeEnabled();
  await page.evaluate(() => localStorage.removeItem("po-mock-slow"));

  // It holds across a reload: the mock API stored it.
  await page.reload();
  await expect(toggle(page)).not.toBeChecked();

  // The owner's brief: the read is off for the company, so nothing offers one.
  await page.goto(`/intakes/${V2_IDS.intake}`);
  await expect(page.getByRole("heading", { level: 1, name: "Saved addresses" })).toBeAttached();
  await expect(readLine(page)).toContainText("Oracle's read is off for this company.");
  await expect(page.getByRole("button", { name: "Analyse with Oracle" })).toHaveCount(0);

  // On again: the brief offers Analyse with Oracle.
  await openCompanySettings(page);
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(panel(page).getByRole("status")).toContainText("Saved");
  await page.goto(`/intakes/${V2_IDS.intake}`);
  await expect(readLine(page).getByRole("button", { name: "Analyse with Oracle" })).toBeVisible();
  await expect(readLine(page)).not.toContainText("off for this company");
});

test("approver: the switch is an owner's; an approver does not see it", async ({ page }) => {
  await login(page, "approver@example.com");
  await openCompanySettings(page);
  await expect(toggle(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test("Inbox row: two failed reads in a row raise one row that opens the brief, and a read that works clears it", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", key);
  }, FAILED_SCENARIO);
  await login(page);
  await page.goto("/inbox");
  await expect(failedRow(page)).toHaveCount(1);
  await expect(failedRow(page)).toContainText("2 failed reads in a row");
  const badge = page.getByTestId("nav-inbox-badge");
  const before = Number(await badge.innerText());

  await failedRow(page).getByRole("link", { name: `Open ${FAILED_TITLE}` }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: FAILED_TITLE })).toBeAttached();
  await expect(readLine(page)).toContainText("Oracle's read failed. The rules read stands.");

  // Acting clears it: Try again reads the brief, and the row goes.
  await readLine(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("intake-read-done")).toBeVisible();
  await expect(readLine(page)).not.toContainText("Oracle's read failed");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-intake-reads")).toHaveCount(0);
  await expect(badge).toHaveText(String(before - 1));
});

test("Inbox row: another member does not get the author's row", async ({ page }) => {
  await page.addInitScript((key) => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", key);
  }, FAILED_SCENARIO);
  await login(page, "approver@example.com");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
  await expect(page.getByTestId("inbox-intake-reads")).toHaveCount(0);
});

test("phone: the switch and the Inbox row fit 390 px with no sideways scroll", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.addInitScript((key) => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", key);
  }, FAILED_SCENARIO);
  await login(page);

  await openCompanySettings(page);
  await toggle(page).scrollIntoViewIfNeeded();
  await expect(toggle(page)).toBeVisible();
  const label = await panel(page).getByText(SWITCH).boundingBox();
  expect(label!.x + label!.width).toBeLessThanOrEqual(PHONE.width);
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(panel(page).getByRole("status")).toContainText("Saved");
  await noSideScroll(page);

  await page.goto("/inbox");
  await expect(failedRow(page)).toBeVisible();
  const row = await failedRow(page).boundingBox();
  expect(row!.x + row!.width).toBeLessThanOrEqual(PHONE.width);
  await noSideScroll(page);
  await failedRow(page).getByRole("link", { name: `Open ${FAILED_TITLE}` }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(readLine(page)).toContainText("Oracle's read failed. The rules read stands.");
});
