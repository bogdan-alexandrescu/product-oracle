import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * Second QA walk of Company › Rituals (qa-company-1..3, 6, 21..24, 34, 35), on the mock layer
 * (lib/api/mock/rituals.ts, "rituals" scenario), driven through the UI as a person would.
 * Today is Wed Oct 28 2026; the Company time zone is not set, so Los Angeles is used. The
 * Baseline rebuild and the Investor update are paused; both meet the first Monday of the
 * month at 9:00 AM, next on Mon Nov 2. The Baseline rebuild's build is estimated at $7.00.
 */

const TODAY = new Date("2026-10-28T17:00:00Z");
const APPROVER = "approver@example.com";
const PHONE = { width: 390, height: 844 };

test.use({ timezoneId: "America/Los_Angeles", locale: "en-US" });

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });

async function openRituals(page: Page, email?: string) {
  await page.clock.install({ time: TODAY });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
  await login(page, email);
  await page.goto("/company/rituals");
  await expect(ritualRow(page, "Weekly goals check-in")).toBeVisible();
}

/** Selects a ritual and waits until the inspector shows it. */
async function pick(page: Page, title: string) {
  await ritualRow(page, title).click();
  await expect(inspector(page)).toContainText(title);
}

test("qa-company-1: Prepare now on the paused Baseline rebuild asks first, naming the pause and the $7.00 cost", async ({ page }) => {
  // protects=qa-company-1; fails_when=Prepare now starts the paid build at once, or the
  // question does not say the ritual is paused or what it costs; no_claim=the build itself.
  await openRituals(page);
  await pick(page, "Baseline rebuild");
  await inspector(page).getByRole("button", { name: "Prepare now" }).click();
  const ask = page.getByRole("alertdialog", { name: "Prepare now" });
  await expect(ask).toContainText("Baseline rebuild is paused; it stays paused.");
  await expect(ask).toContainText("starts the baseline build: one Oracle run of about $7.00");
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page).toHaveURL(/\/company\/rituals$/);
  await expect(ritualRow(page, "Baseline rebuild").getByTestId("last-pre-read")).toHaveCount(0);
  await inspector(page).getByRole("button", { name: "Prepare now" }).click();
  await ask.getByRole("button", { name: "Prepare now" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
});

test("qa-company-1: Prepare now that spends nothing on an active ritual does not ask", async ({ page }) => {
  await openRituals(page);
  await pick(page, "Weekly goals check-in");
  await inspector(page).getByRole("button", { name: "Prepare now" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
});

test("qa-company-2/3: after Prepare now the paused ritual's Last pre-read is Nov 2, and the occurrence says one thing about the build", async ({ page }) => {
  // protects=qa-company-2 (Last pre-read names and links the new pre-read) and qa-company-3
  // (the pre-read's card no longer says the build has not started); fails_when=Last stays
  // empty, or the page says both "Oracle started the baseline build" and "Oracle starts the build".
  await openRituals(page);
  await pick(page, "Baseline rebuild");
  await inspector(page).getByRole("button", { name: "Prepare now" }).click();
  await page.getByRole("alertdialog", { name: "Prepare now" }).getByRole("button", { name: "Prepare now" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  const occurrence = new URL(page.url()).pathname;

  const card = page.getByTestId("occurrence-rebuild");
  await expect(card).toContainText("Oracle started the baseline build");
  await expect(card.getByRole("link", { name: "Open run" })).toBeVisible();
  const block = page.getByTestId("ritual-block").filter({ hasText: "Estimate $7.00" });
  await expect(block).toBeVisible();
  await expect(block).not.toContainText("Oracle starts the build");
  await expect(block).not.toContainText("No baseline build yet");

  await page.getByRole("link", { name: "← Rituals" }).click();
  const last = ritualRow(page, "Baseline rebuild").getByTestId("last-pre-read");
  await expect(last).toHaveText("Nov 2, 2026");
  await last.click();
  await expect(page).toHaveURL(new RegExp(`${occurrence}$`));
});

test("qa-company-6 (phone): tapping a ritual opens it in a sheet", async ({ page }) => {
  // protects=qa-company-6; fails_when=the editor is drawn below the list and the tab bar.
  await page.setViewportSize(PHONE);
  await openRituals(page);
  await ritualRow(page, "Investor update").click();
  const sheet = page.getByTestId("ritual-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("ritual-inspector")).toContainText("Investor update");
  const box = await sheet.getByRole("button", { name: "Resume" }).boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("qa-company-21: the zone is named once, one way, and no time carries its own zone", async ({ page }) => {
  // protects=qa-company-21; fails_when="PT", "PST" or "PDT" follow a time, or the owner's and
  // the approver's pages name the zone differently.
  await openRituals(page);
  const row = ritualRow(page, "Weekly goals check-in");
  await expect(row).toContainText("Mondays 9:00 AM");
  await expect(row.locator('[data-col="next"]')).toHaveText("Mon, Nov 2, 9:00 AM");
  await expect(page.getByTestId("rituals-zone")).toHaveText("Times are in Pacific Time (Los Angeles), not set yet");
  await pick(page, "Weekly goals check-in");
  await expect(inspector(page).getByTestId("ritual-zone")).toHaveText("Pacific Time (Los Angeles), not set yet");
  await expect(page.locator("main")).not.toContainText(/\b(PT|PST|PDT)\b/);

  await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
  await expect(page.getByTestId("occurrence-zone")).toHaveText("Times are in Pacific Time (Los Angeles)");
  await expect(page.getByTestId("ritual-block").first()).toContainText("Data as of");
  await expect(page.locator("main")).not.toContainText(/\b(PT|PST|PDT)\b/);
});

test("qa-company-21: an approver sees the zone named the same way", async ({ page }) => {
  await openRituals(page, APPROVER);
  await expect(page.getByTestId("rituals-zone")).toHaveText("Times are in Pacific Time (Los Angeles)");
  await pick(page, "Weekly goals check-in");
  await expect(inspector(page).getByTestId("ritual-zone")).toHaveText("Pacific Time (Los Angeles)");
  await expect(page.locator("main")).not.toContainText(/\b(PT|PST|PDT)\b/);
});

test("qa-company-22: at 1440 with the inspector open, When holds Next, names keep to two lines and the state chip sits inside the card", async ({ page }) => {
  // protects=qa-company-22; fails_when=a separate Next column squeezes names onto 3-4 lines or
  // the Paused chip reaches the card's edge.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRituals(page);
  await pick(page, "Weekly goals check-in");
  const headers = page.getByTestId("rituals-table").getByRole("columnheader");
  await expect(headers.filter({ hasText: /^Next$/ })).toHaveCount(0);
  const lines = await page
    .getByTestId("ritual-row")
    .locator("span.font-medium")
    .evaluateAll((els) => els.map((e) => e.getClientRects().length));
  expect(Math.max(...lines)).toBeLessThanOrEqual(2);
  const chip = await ritualRow(page, "Investor update").getByText("Paused", { exact: true }).boundingBox();
  const panel = await page.getByTestId("rituals-panel").boundingBox();
  expect(chip && panel).toBeTruthy();
  expect(panel!.x + panel!.width - (chip!.x + chip!.width)).toBeGreaterThanOrEqual(8);
});

test("qa-company-23: Every pre-read asks first with its monthly cost, then says what was saved", async ({ page }) => {
  // protects=qa-company-23; fails_when=one click turns on a recurring cost with no question,
  // or nothing says it was saved.
  await openRituals(page);
  const line = page.getByTestId("ritual-summaries");
  const mode = line.getByRole("group", { name: "Summaries" });
  await mode.getByRole("button", { name: "Every pre-read" }).click();
  const ask = page.getByRole("alertdialog", { name: "Summarize every pre-read" });
  await expect(ask).toContainText("about $17 a month (about 6 summaries)");
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(mode.getByRole("button", { name: "On demand" })).toHaveAttribute("aria-pressed", "true");
  await mode.getByRole("button", { name: "Every pre-read" }).click();
  await ask.getByRole("button", { name: "Summarize every pre-read" }).click();
  await expect(mode.getByRole("button", { name: "Every pre-read" })).toHaveAttribute("aria-pressed", "true");
  await expect(line.getByTestId("summaries-saved")).toHaveText("Saved · Oracle now summarizes every pre-read, about $17 a month (about 6 summaries)");
  await expect(line.getByTestId("summaries-estimate")).toHaveText("Every pre-read costs about $17 a month (about 6 summaries)");
});

test("qa-company-24: Add ritual focuses Title and says a title is needed while Add is off", async ({ page }) => {
  // protects=qa-company-24; fails_when=the field is not focused or the grey Add gives no hint.
  await openRituals(page);
  await page.getByRole("button", { name: "Add ritual" }).click();
  const form = page.getByRole("form", { name: "Add ritual" });
  await expect(form.getByLabel("Title")).toBeFocused();
  await expect(form.getByRole("button", { name: "Add" })).toBeDisabled();
  await expect(form.getByTestId("add-ritual-needs")).toHaveText("Type a title to add the ritual.");
  await page.keyboard.type("Pricing sync");
  await expect(form.getByTestId("add-ritual-needs")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Add" })).toBeEnabled();
});

test("qa-company-34 (phone): the (i) sits beside the cost text and each row's When and Last pre-read keep lines of their own", async ({ page }) => {
  // protects=qa-company-34; fails_when=the (i) drops to its own line, or a paused ritual's
  // "Next —" and "Last —" share and break a line.
  await page.setViewportSize(PHONE);
  await openRituals(page);
  const line = page.getByTestId("ritual-summaries");
  const text = await line.getByTestId("summaries-estimate").boundingBox();
  const tip = await line.getByRole("button", { name: "About the summaries estimate" }).boundingBox();
  expect(text && tip).toBeTruthy();
  expect(tip!.y).toBeLessThan(text!.y + text!.height);
  expect(tip!.x).toBeGreaterThan(text!.x);
  for (const title of ["Investor update", "Weekly goals check-in"]) {
    const row = ritualRow(page, title);
    await expect(row).not.toContainText("Next —");
    const when = await row.locator("td", { hasText: /^(Mondays|First)/ }).first().boundingBox();
    const last = await row.locator("td", { hasText: "Last pre-read" }).boundingBox();
    expect(when && last).toBeTruthy();
    expect(Math.abs(when!.x - last!.x)).toBeLessThanOrEqual(1);
    expect(last!.y).toBeGreaterThanOrEqual(when!.y + when!.height - 1);
  }
});

test("qa-company-35 (phone): the occurrence's name and state are its heading together", async ({ page }) => {
  // protects=qa-company-35; fails_when=the Ready chip floats alone under "← Rituals" with the
  // name only in the top bar.
  await page.setViewportSize(PHONE);
  await openRituals(page);
  await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
  const heading = page.getByRole("heading", { level: 1, name: "Monthly roadmap refresh" });
  const h = await heading.boundingBox();
  const chip = await page.getByTestId("occurrence-state").boundingBox();
  expect(h && chip).toBeTruthy();
  expect(h!.height).toBeGreaterThan(20);
  expect(h!.width).toBeGreaterThan(100);
  // The chip follows the name: beside it, or on the line just under it.
  expect(chip!.y).toBeLessThanOrEqual(h!.y + h!.height + 12);
});
