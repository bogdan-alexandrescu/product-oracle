import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass B on Plan (B-07, B-08, B-11, B-12, B-24, B-25), on the mock layer, driven
 * as a person would. Each test's card: protects=...; fails_when=...
 */

const PHONE = { width: 390, height: 844 };
const LEAD = "commenter@example.com";

const scenario = (page: Page, s: string) => page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);

async function openDates(page: Page) {
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Dates" }).click();
  await expect(page).toHaveURL(/\/plan\/dates$/);
}

const dateRow = (page: Page, reference: string) => page.getByTestId("dates-table").locator(`[data-basis="${reference}"]`).filter({ visible: true });

// protects=B-07: a date source's row and its Withdraw dialog say the date and what it is for,
// the reference second, and the button says "date source"; fails_when=the row or the dialog
// is titled by the reference alone ("Withdraw ENG-412") or the button says "date basis".
test("B-07: Dates rows and Withdraw name the date and what it is for", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page);
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await expect(dateRow(page, "ENG-412").getByTestId("basis-title")).toHaveText("Nov 30 · Usage alerts PRD (ENG-412)");
  await dateRow(page, "ENG-412").getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByRole("dialog", { name: "Withdraw the Nov 30 date for Usage alerts PRD" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Withdraw date source" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /date basis/ })).toHaveCount(0);
});

// protects=B-07: Reject names the date too; fails_when=its title is "Reject ENG-420".
test("B-07: Reject names the date and what it is for", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page, LEAD);
  await openDates(page);
  await expect(dateRow(page, "ENG-420").getByTestId("basis-title")).toHaveText("Jan 15 · Usage alerts PRD (ENG-420)");
  await dateRow(page, "ENG-420").getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("dialog", { name: "Reject the Jan 15 date for Usage alerts PRD" })).toBeVisible();
});

// protects=B-12: an empty Dates table reads "No date sources yet." and is labelled Date
// sources; fails_when=it says "date bases".
test("B-12: an empty Dates table says No date sources yet", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page);
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: /^Withdrawn/ }).click();
  const table = page.getByTestId("dates-table").filter({ visible: true });
  await expect(table).toContainText("No date sources yet.");
  await expect(table.getByLabel("Date sources")).toBeAttached();
  await expect(page.locator("main")).not.toContainText(/date bas[ie]s/i);
});

// protects=B-08: when the documents fail to load, Plan › Documents shows one notice, "Couldn't
// load your roadmaps.", whose Try again reloads both lists; fails_when=two bare red bars show
// and nothing offers to try again.
test("B-08: Documents shows one load error with Try again that reloads both lists", async ({ page }) => {
  await login(page);
  await page.evaluate((k) => localStorage.setItem(k, "/v1/documents"), MOCK_FAIL_KEY);
  await page.goto("/plan/documents");
  const notice = page.getByTestId("load-error");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Couldn't load your roadmaps.");
  await page.evaluate((k) => localStorage.removeItem(k), MOCK_FAIL_KEY);
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("roadmap-row").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("approved-prds-table").filter({ visible: true })).toBeVisible();
});

// protects=B-11: on a phone, a launch link from the Inbox opens that launch's sheet on load;
// fails_when=the row is highlighted but the sheet stays shut.
test("B-11: on a phone, a launch named in the URL opens its sheet", async ({ page }) => {
  await scenario(page, "oracle-did-launch-ritual");
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Usage export launched" });
  await did.getByRole("link", { name: /^Usage export launched: Oracle published/ }).click();
  await expect(page).toHaveURL(/\/roadmap\/launches\?launch=[0-9a-f-]{36}$/);
  await page.setViewportSize(PHONE);
  await page.reload();
  const sheet = page.getByTestId("launch-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("launch-inspector")).toContainText("Usage export");
  // Closed, it stays closed.
  await sheet.getByRole("button", { name: /close/i }).first().click();
  await expect(sheet).toBeHidden();
});

// protects=B-24: with two-way sync off, Push to tracker stays disabled with its reason in its
// (i), not as an inline sentence; fails_when=the card shows "Two-way tracker sync is off: …".
test("B-24: Push to tracker keeps its reason behind an (i)", async ({ page }) => {
  await scenario(page, "plan-decider");
  await login(page);
  await page.goto("/plan");
  const track = page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
  const push = track.getByRole("button", { name: "Push to tracker" });
  await expect(push).toBeDisabled();
  await expect(push).toHaveAccessibleDescription(/Two-way tracker sync is off/);
  // Only the screen-reader copy (1 px) carries the words on the card; no sentence shows.
  const widths = await track.getByText(/Two-way tracker sync is off/).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(widths.every((w) => w <= 1)).toBe(true);
  await track.getByRole("button", { name: "About two-way sync" }).click();
  await expect(track.getByRole("tooltip").filter({ visible: true })).toContainText("Two-way tracker sync is off");
});

// protects=B-25: the inspector's Engineering block says the tracker has no due date and no
// more; fails_when=it repeats the Date block ("The roadmap shows Nov 20 ✓, …").
test("B-25: Engineering says only that the tracker has no due date", async ({ page }) => {
  await scenario(page, "roadmap-diff");
  await login(page);
  await page.goto("/plan");
  const row = page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Threshold alerts on spend" });
  await row.click();
  const eng = page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-item-engineering");
  await expect(eng.getByTestId("plan-record")).toContainText("ENG-402 · In progress · no due date in the tracker");
  await expect(eng).not.toContainText("The roadmap shows");
  await expect(eng).not.toContainText("see Date");
});
