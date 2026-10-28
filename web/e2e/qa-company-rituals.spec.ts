import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { displayName } from "../lib/names";

import { ADMIN, login } from "./helpers";

/*
 * QA walk of Company › Rituals (qa-company-6..8, 22..29, 31), on the mock layer
 * (lib/api/mock/rituals.ts, "rituals" scenario). Today is Wed Oct 28 2026; the Company time
 * zone is not set, so Los Angeles is used. The Weekly goals check-in meets Mondays 9:00 AM:
 * last on Mon Oct 26 (held), next on Mon Nov 2 (after the change to standard time, PST).
 * The Monthly roadmap refresh's Tue Nov 3 pre-read was prepared early.
 */

const TODAY = new Date("2026-10-28T17:00:00Z");
const APPROVER = "approver@example.com";

test.use({ timezoneId: "America/Los_Angeles", locale: "en-US" });

async function withRituals(page: Page) {
  await page.clock.install({ time: TODAY });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
}

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });

async function openRituals(page: Page, email = ADMIN.email) {
  await withRituals(page);
  await login(page, email);
  await page.goto("/company/rituals");
  await expect(ritualRow(page, "Weekly goals check-in")).toBeVisible();
}

/** Every cell of the table shows its whole text: nothing is cut (truncate makes scrollWidth exceed clientWidth). */
async function expectNothingCut(page: Page) {
  const cut = await page
    .getByTestId("ritual-row")
    .locator("td")
    .evaluateAll((tds) =>
      tds
        .filter((td) => (td as HTMLElement).offsetParent !== null)
        .filter((td) => td.scrollWidth > td.clientWidth + 1)
        .map((td) => td.textContent),
    );
  expect(cut).toEqual([]);
}

test("qa-company-6: the check-in's pre-read gives paid conversion the current value Home shows", async ({ page }) => {
  // protects=qa-company-6, the goals block reads the same goals as Home; fails_when=it says
  // "No current value" for Grow paid conversion (9.4% of 12%); no_claim=the API (test_rituals.py).
  await openRituals(page);
  await ritualRow(page, "Weekly goals check-in").getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly goals check-in" })).toBeVisible();
  const goals = page.getByTestId("ritual-block").filter({ hasText: "Grow paid conversion" });
  await expect(goals).toContainText("Grow paid conversion: 9.4% of 12% · 2.6 pts to go");
  await expect(goals).not.toContainText("No current value");
});

test("qa-company-7: Prepare now keeps Mon Nov 2 as Next with its pre-read ready; Last stays the held Oct 26", async ({ page }) => {
  // protects=qa-company-7; fails_when=Next jumps to Nov 9 or Last names the meeting not yet
  // held (Nov 2); no_claim=the API (test_rituals.py).
  await openRituals(page);
  const row = ritualRow(page, "Weekly goals check-in");
  await expect(row.locator('[data-col="next"]')).toHaveText("Mon, Nov 2, 9:00 AM PST");
  await row.click();
  await inspector(page).getByRole("button", { name: "Prepare now" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("occurrence-meta")).toContainText("Mon, Nov 2, 9:00 AM PST");
  await page.getByRole("link", { name: "← Rituals" }).click();
  await expect(row.locator('[data-col="next"]')).toHaveText("Mon, Nov 2, 9:00 AM PST");
  await expect(row.getByTestId("next-pre-read")).toHaveText("Pre-read ready");
  await expect(row).toContainText("Oct 26, 2026");
  await expect(row).not.toContainText("Nov 2, 2026");
  await expect(row).not.toContainText("Nov 9");
});

test("qa-company-8: names, schedules and Next are shown whole, with the inspector open too", async ({ page }) => {
  // protects=qa-company-8; fails_when=a ritual's name, schedule or Next time is cut;
  // no_claim=other tables.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRituals(page);
  await expectNothingCut(page);
  await ritualRow(page, "Weekly goals check-in").click();
  await expect(inspector(page)).toBeVisible();
  await expectNothingCut(page);
  await expect(ritualRow(page, "Monthly roadmap refresh")).toContainText("First Tuesday of the month, 10:00 AM PT");
});

test("qa-company-8 (phone): at 390 px the rows wrap and nothing is cut or scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRituals(page);
  await expect(ritualRow(page, "Weekly goals check-in")).toContainText("Mondays 9:00 AM PT");
  await expectNothingCut(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("qa-company-23/24: the zone is named in words and said to be not set yet", async ({ page }) => {
  // protects=qa-company-23 (no raw "America/Los_Angeles") and qa-company-24 (unset reads as
  // Home's set-up says); fails_when=the IANA name shows or the zone reads as chosen.
  await openRituals(page);
  const row = ritualRow(page, "Weekly goals check-in");
  await expect(row.locator('[data-col="next"]')).toHaveAttribute("title", /\(Pacific Time \(Los Angeles\)\)$/);
  await row.click();
  const panel = inspector(page);
  await expect(panel.getByTestId("ritual-zone")).toHaveText("Company time zone · Not set · Pacific is used");
  await expect(page.locator("main")).not.toContainText("America/Los_Angeles");
});

test("qa-company-23: an approver's read-only inspector names the zone in words", async ({ page }) => {
  await openRituals(page, APPROVER);
  await ritualRow(page, "Weekly goals check-in").click();
  await expect(inspector(page).getByTestId("ritual-zone")).toHaveText("Pacific Time (Los Angeles)");
  await expect(inspector(page)).toContainText("Mondays 9:00 AM PT");
});

test("qa-company-25: one time format, with the zone, in the table, inspector and Time field", async ({ page }) => {
  // protects=qa-company-25; fails_when="Mondays 9:00" (24 h, no zone) or the Time field reads "09:00 AM".
  await openRituals(page);
  const row = ritualRow(page, "Weekly goals check-in");
  await expect(row).toContainText("Mondays 9:00 AM PT");
  await row.click();
  const time = inspector(page).getByLabel("Time", { exact: true });
  await expect(time.locator("option:checked")).toHaveText("9:00 AM");
  await time.selectOption({ label: "4:30 PM" });
  await inspector(page).getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Mondays 4:30 PM PT");
});

test("qa-company-26/28: names first in the Owner picker and attendees; Length and lead time inputs line up", async ({ page }) => {
  // protects=qa-company-26 and qa-company-28; fails_when=the picker or attendees show only
  // emails, or the lead time input sits lower than Length's.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRituals(page);
  await ritualRow(page, "Weekly goals check-in").click();
  const panel = inspector(page);
  const owner = displayName(ADMIN.email);
  await expect(ritualRow(page, "Weekly goals check-in")).toContainText(owner);
  await expect(panel.getByLabel("Owner").locator("option:checked")).toHaveText(`${owner} · ${ADMIN.email}`);
  await expect(panel.getByRole("group", { name: "Attendees" })).toContainText(displayName(APPROVER));
  const length = await panel.getByLabel("Length (minutes)").boundingBox();
  const lead = await panel.getByLabel("Pre-read lead time (hours)").boundingBox();
  expect(length && lead).toBeTruthy();
  expect(Math.abs(length!.y - lead!.y)).toBeLessThanOrEqual(1);
});

test("qa-company-27: the on-demand estimate says what Every pre-read would cost, in whole numbers", async ({ page }) => {
  // protects=qa-company-27; fails_when="If on: …" or "4.33 a month".
  await openRituals(page);
  const line = page.getByTestId("ritual-summaries");
  await expect(line.getByTestId("summaries-estimate")).toHaveText("Every pre-read would cost about $17 a month (about 6 summaries)");
  await line.getByRole("button", { name: "About the summaries estimate" }).click();
  const tip = line.getByRole("tooltip");
  await expect(tip).toContainText("Weekly goals check-in: about 4 a month");
  await expect(tip).not.toContainText(/\d\.\d+ a month/);
});

test("qa-company-29: Add ritual says what it starts with and where to change it", async ({ page }) => {
  await openRituals(page);
  await page.getByRole("button", { name: "Add ritual" }).click();
  const form = page.getByRole("form", { name: "Add ritual" });
  await expect(form.getByTestId("add-ritual-hint")).toContainText("every Monday at 9:00 AM for 30 minutes");
  await expect(form.getByTestId("add-ritual-hint")).toContainText("Change any of it in the panel");
});

test("qa-company-31: the Summary card says what Summarize with Oracle makes and what it costs", async ({ page }) => {
  // protects=qa-company-31; fails_when=only the button is shown.
  await openRituals(page, APPROVER);
  await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
  const card = page.getByTestId("occurrence-summary");
  await expect(card.getByRole("button", { name: "Summarize with Oracle" })).toBeVisible();
  await expect(card.getByTestId("summary-what")).toHaveText("Oracle reads this pre-read and writes a short summary of it for the attendees · one Oracle run, about $3.00.");
});

test("qa-company-22: pre-read dates are written as people read them, never ISO", async ({ page }) => {
  await openRituals(page);
  await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
  const slips = page.getByTestId("ritual-block").filter({ hasText: "Date slips" });
  await expect(slips).toContainText("Threshold alerts beta: Nov 10, 2026 → Nov 24, 2026");
  await expect(page.locator("main")).not.toContainText(/\d{4}-\d{2}-\d{2}/);
});
