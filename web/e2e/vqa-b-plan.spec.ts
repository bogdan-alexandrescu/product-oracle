import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass B on Plan (B-07, B-08, B-11, B-12, B-24, B-25), on the mock layer, driven
 * as a person would. Each test's card: protects=...; fails_when=...
 */

const PHONE = { width: 390, height: 844 };
const LEAD = "commenter@example.com";

const scenario = (page: Page, s: string) => page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);
const store = (page: Page, key: string, v: string | null) =>
  page.evaluate(([k, x]) => (x === null ? localStorage.removeItem(k) : localStorage.setItem(k, x)), [key, v] as const);

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
  await expect(dateRow(page, "ENG-412").getByTestId("basis-title")).toHaveText("The whole PRD (ENG-412)");
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
  await expect(dateRow(page, "ENG-420").getByTestId("basis-title")).toHaveText("The whole PRD (ENG-420)");
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

// protects=B-08: when the documents fail to load, Plan › Documents shows one notice naming both
// lists, whose Try again reloads both; fails_when=two bare red bars show and nothing offers to
// try again.
test("B-08: Documents shows one load error with Try again that reloads both lists", async ({ page }) => {
  await login(page);
  await page.evaluate((k) => localStorage.setItem(k, "/v1/documents"), MOCK_FAIL_KEY);
  await page.goto("/plan/documents");
  const notice = page.getByTestId("load-error");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Couldn't load your roadmaps and approved PRDs.");
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

/*
 * PR 1285 review minors, each driven through the UI.
 */

async function addTrackerSource(page: Page, reference: string, day: string, key: string) {
  await page.getByRole("button", { name: "Add a date source" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  await dialog.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await dialog.getByLabel("Reference").fill(reference);
  await dialog.getByLabel("Date it supports").fill(day);
  await dialog.getByLabel("For").selectOption({ label: "Items of one tracker issue" });
  await dialog.getByLabel("Tracker issue key").fill(key);
  await dialog.getByRole("button", { name: "Record and verify" }).click();
  await expect(dialog).toHaveCount(0);
}

// protects=review 1: a date source for a tracker issue is named by the items it dates, and one
// whose items are not on the plan says "a tracker item", the key only behind Applies to's (i);
// fails_when=the row or Withdraw reads "Items of ENG-402" or "Items of ENG-999".
test("review 1: a tracker issue's date source names its item, never its bare key", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page);
  await openDates(page);
  await addTrackerSource(page, "EST-7", "2026-12-10", "ENG-402");
  await addTrackerSource(page, "EST-8", "2026-12-11", "ENG-999");
  await page.getByTestId("dates-filter").getByRole("button", { name: /^All/ }).click();
  const named = dateRow(page, "EST-7");
  await expect(named.getByTestId("basis-title")).toHaveText("Threshold alerts on spend (EST-7)");
  await expect(named).not.toContainText("ENG-402");
  await named.getByRole("button", { name: "About tracker issue" }).click();
  await expect(page.getByRole("tooltip").filter({ visible: true })).toContainText("ENG-402");
  const unknown = dateRow(page, "EST-8");
  await expect(unknown.getByTestId("basis-title")).toHaveText("A tracker item (EST-8)");
  await expect(unknown).not.toContainText("ENG-999");
  await unknown.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByRole("dialog", { name: "Withdraw the Dec 11 date for a tracker item" })).toBeVisible();
});

// protects=review 1: an item the page cannot name reads "An item"; fails_when=its key shows
// ("threshold-alerts (ENG-402)").
test("review 1: an item without a known title reads An item", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page);
  await store(page, MOCK_FAIL_KEY, "/v1/plan");
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: /^All/ }).click();
  const row = dateRow(page, "ENG-402");
  await expect(row.getByTestId("basis-title")).toHaveText("An item (ENG-402)");
  await expect(row).not.toContainText("threshold-alerts");
});

// protects=review 2: while the PRDs load, the group header shows the loading bar, and a PRD
// the list lacks is "a PRD"; fails_when=the header or Withdraw reads a bare "PRD".
test("review 2: a PRD name loading shows the loading bar; a missing one reads a PRD", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page);
  await store(page, MOCK_SLOW_KEY, "/v1/documents");
  await store(page, MOCK_SLOW_MS_KEY, "4000");
  await openDates(page);
  const table = page.getByTestId("dates-table").filter({ visible: true });
  const header = table.locator("[data-group]").first();
  await expect(header.getByTestId("name-loading")).toBeVisible();
  await expect(header).toHaveText("");
  await expect(header).toHaveText("Usage alerts PRD");
  await store(page, MOCK_SLOW_KEY, null);
  await store(page, MOCK_FAIL_KEY, "/v1/documents");
  await page.reload();
  await expect(table.locator("[data-group]").first()).toHaveText("A PRD");
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  await dateRow(page, "ENG-412").getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByRole("dialog", { name: "Withdraw the Nov 30 date for a PRD" })).toBeVisible();
});

// protects=review 3: each fact once per row: the date only in Date (once on a phone card), the
// PRD only in its group header; fails_when=the row reads "Nov 30 · Usage alerts PRD (ENG-412)".
test("review 3: a Dates row says its date and PRD once", async ({ page }) => {
  await scenario(page, DATE_BASES_SCENARIO);
  await login(page);
  await openDates(page);
  await page.getByTestId("dates-filter").getByRole("button", { name: "Verified" }).click();
  for (const size of [{ width: 1440, height: 900 }, PHONE]) {
    await page.setViewportSize(size);
    const row = dateRow(page, "ENG-412");
    await expect(row.getByTestId("basis-title")).toHaveText("The whole PRD (ENG-412)");
    expect((await row.innerText()).match(/Nov 30/g)).toHaveLength(1);
    await expect(row).not.toContainText("Usage alerts PRD");
    await expect(row).toContainText("Whole PRD");
  }
});

// protects=review 4: Push to tracker's reason shows in one tooltip, its (i)'s; fails_when=the
// wrapper's native title shows the same words a second time on hover.
test("review 4: Push to tracker's reason has one tooltip", async ({ page }) => {
  await scenario(page, "plan-decider");
  await login(page);
  await page.goto("/plan");
  const track = page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
  await expect(track.getByRole("button", { name: "Push to tracker" })).toBeDisabled();
  await expect(track.locator("[title*='Two-way tracker sync is off']")).toHaveCount(0);
});

// protects=review 5, 6: the notice names the list that failed, and a failed list's table has no
// empty line; fails_when=it says "Couldn't load your roadmaps." when the PRDs failed, or the
// table says "No approved PRDs yet".
test("review 5, 6: Documents names the list that failed and drops its empty line", async ({ page }) => {
  await login(page);
  await store(page, MOCK_FAIL_KEY, "/v1/documents?kind=prd");
  await page.goto("/plan/documents");
  const notice = page.getByTestId("load-error");
  await expect(notice).toContainText("Couldn't load your approved PRDs.");
  await expect(page.getByTestId("roadmap-row").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("approved-prds-table").filter({ visible: true })).not.toContainText("No approved PRDs yet");
  await store(page, MOCK_FAIL_KEY, "/v1/documents");
  await page.reload();
  await expect(notice).toContainText("Couldn't load your roadmaps and approved PRDs.");
  await expect(page.getByTestId("roadmaps-table").filter({ visible: true })).not.toContainText("No roadmaps yet");
  await expect(page.getByTestId("approved-prds-table").filter({ visible: true })).not.toContainText("No approved PRDs yet");
});

// protects=review 7: on a phone, following the same Inbox link again opens the sheet again;
// fails_when=the guard keyed on the launch id keeps it shut the second time.
test("review 7: on a phone, the same Inbox launch link opens the sheet each time", async ({ page }) => {
  await scenario(page, "oracle-did-launch-ritual");
  await login(page);
  await page.setViewportSize(PHONE);
  await page.goto("/inbox");
  const first = page.getByTestId("inbox-oracle-actions").filter({ visible: true }).getByRole("row").filter({ hasText: "Usage export launched" });
  await first.getByRole("link", { name: /^Usage export launched: Oracle published/ }).click();
  await expect(page).toHaveURL(/\/roadmap\/launches\?launch=[0-9a-f-]{36}$/);
  const sheet = page.getByTestId("launch-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /close/i }).first().click();
  await expect(sheet).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox/);
  // Opened once, the line is no longer new: it is under Seen.
  await page.getByRole("tab", { name: /^Seen/ }).click();
  const did = page.getByTestId("inbox-oracle-actions").filter({ visible: true }).getByRole("row").filter({ hasText: "Usage export launched" });
  await did.getByRole("link", { name: /^Usage export launched: Oracle published/ }).click();
  await expect(page).toHaveURL(/\/roadmap\/launches\?launch=/);
  await expect(sheet).toBeVisible();
});
