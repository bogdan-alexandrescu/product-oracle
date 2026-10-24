import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { displayName } from "../lib/names";

import { ADMIN, login } from "./helpers";

/*
 * H2 Cadence engine: Company › Rituals and the occurrence page, driven through the UI as a
 * person would, on the mock layer (lib/api/mock/rituals.ts). The "rituals" scenario seeds
 * the company's built-in rituals (Weekly goals check-in, Monthly roadmap refresh and
 * Quarterly goals review on; Investor update paused), a Monthly roadmap refresh pre-read
 * prepared early for Tue Nov 3 10:00 UTC (the owner and the approver attend), and last
 * week's goals check-in, held, whose summary run failed. Every ritual is in the Company
 * time zone, America/Los_Angeles unless an owner set another. The mock clock starts on Fri
 * Oct 23 2026 12:00 UTC and the browser shows New York time. Each test states its card.
 */

const APPROVER = "approver@example.com";
const START = new Date("2026-10-23T12:00:00Z");

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function withRituals(page: Page, at: Date = START) {
  await page.clock.install({ time: at });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
}

const badge = (page: Page) => page.getByTestId("app-nav").getByTestId("nav-inbox-badge");
const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });
const summaries = (page: Page) => page.getByTestId("ritual-summaries");
const tab = (page: Page, name: string) => page.getByTestId("inbox-state-tabs").getByRole("tab", { name: new RegExp(`^${name}`) });
const ritualNeed = (page: Page, text: string) => page.getByTestId("inbox-rituals").locator("tr[data-row]").filter({ hasText: text });

async function badgeCount(page: Page): Promise<number> {
  await expect(badge(page)).toHaveText(/^\d+$/);
  return Number(await badge(page).innerText());
}

async function openRituals(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId("company-tab-rituals").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/rituals$/);
  await expect(page.getByTestId("company-tab-rituals").filter({ visible: true })).toHaveAttribute("aria-current", "page");
}

/** Opens a ritual's last pre-read from its Last pre-read link. */
async function openLastPreRead(page: Page, title: string) {
  await ritualRow(page, title).getByRole("link").click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

test("12a: an owner moves the roadmap refresh to the last Friday at 16:00 and Next shows it in the Company time zone", async ({ page }) => {
  // protects=AC12a, Company › Rituals as the Rituals tab of the Company rail item, the
  // inspector's schedule picker and the Next column in the Company time zone (#447), even with
  // the browser in New York; fails_when=the tab is missing or not third, the schedule is not
  // saved, or Next keeps the old date or shows New York time (7:00 PM) instead of the
  // Company's (Oct 30 16:00 in Los Angeles, PDT); no_claim=the API's DST
  // maths (test_rituals_schedule.py).
  await withRituals(page);
  await login(page);
  await openRituals(page);
  await expect(page.getByRole("navigation", { name: "Company" }).filter({ visible: true }).getByRole("link")).toHaveText(["Strategy", "Decisions", "Rituals", "Updates"]);
  const row = ritualRow(page, "Monthly roadmap refresh");
  await expect(row).toContainText("First Tuesday of the month, 10:00");
  await row.click();
  const panel = inspector(page);
  await expect(panel).toContainText("Monthly roadmap refresh");
  await panel.getByLabel("Repeats").selectOption("monthly");
  await panel.getByLabel("Week of the month").selectOption("-1");
  await panel.getByLabel("Day").selectOption("4");
  await panel.getByLabel("Time", { exact: true }).fill("16:00");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Last Friday of the month, 16:00");
  await expect(row.locator('[data-col="next"]')).toHaveText("Fri, Oct 30, 4:00 PM PDT");
  // Oracle's words: a company, never a workspace or tenant.
  await expect(page.getByTestId("rituals-panel")).not.toContainText(/workspace|tenant/i);
  await expect(panel).not.toContainText(/workspace|tenant/i);
});

test("12b: an attendee follows Pre-read ready to the occurrence; Tracks and Date slips show and the badge drops by 1", async ({ page }) => {
  // protects=AC12b, the attendee's counted Pre-read ready row, the occurrence page in the
  // Company shell and its read mark; fails_when=the row is missing, Open goes elsewhere, the
  // Rituals tab is not selected, the cards are missing, or the badge still counts the row;
  // no_claim=the API's Inbox maths (test_rituals.py).
  await withRituals(page);
  await login(page, APPROVER);
  await page.goto("/inbox");
  const row = ritualNeed(page, "Pre-read ready · Monthly roadmap refresh");
  await expect(row).toHaveCount(1);
  const before = await badgeCount(page);
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("company-tab-rituals").filter({ visible: true })).toHaveAttribute("aria-current", "page");
  const blocks = page.getByTestId("ritual-block");
  await expect(blocks.filter({ hasText: "Tracks" }).first()).toContainText("Usage alerts PRD");
  await expect(blocks.filter({ hasText: "Date slips" })).toContainText("Threshold alerts beta");
  await expect(blocks.first()).toContainText("Data as of");
  await expect(page.getByTestId("occurrence-state")).toHaveText("Ready");
  await expect(badge(page)).toHaveText(String(before - 1));
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-tab-new").getByTestId("inbox-rituals")).toHaveCount(0);
});

test("12c: after the end time the owner records notes and marks it held; the Record notes row is gone", async ({ page }) => {
  // protects=AC12c, the owner's Record notes row after the end and Mark held; fails_when=no
  // Record notes row after the end, the notes are not saved, the chip does not read Held, or
  // the row stays; no_claim=Record decision (H1's form).
  await withRituals(page);
  await login(page);
  await page.goto("/inbox");
  await expect(ritualNeed(page, "Pre-read ready · Monthly roadmap refresh")).toHaveCount(1);
  await expect(ritualNeed(page, "Record notes")).toHaveCount(0);
  // The meeting ends Tue Nov 3 11:00 UTC; a day later:
  await page.clock.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  await page.goto("/inbox");
  await tab(page, "Open").click();
  const notes = ritualNeed(page, "Record notes · Monthly roadmap refresh");
  await expect(notes).toHaveCount(1);
  await notes.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await page.getByLabel("Notes").fill("Agreed to move threshold alerts to December.");
  await page.getByRole("button", { name: "Mark held" }).click();
  await expect(page.getByTestId("occurrence-state")).toHaveText("Held");
  await expect(page.getByTestId("occurrence-notes")).toContainText("Agreed to move threshold alerts to December.");
  await page.goto("/inbox");
  await tab(page, "Open").click();
  await expect(page.getByTestId("inbox-tab-open")).toBeVisible();
  await expect(ritualNeed(page, "Record notes")).toHaveCount(0);
});

test("12d: an approver sees the table and the Summaries choice without edit controls", async ({ page }) => {
  // protects=AC12d, owners edit and everyone else sees; fails_when=an approver gets Add
  // ritual, the Summaries switch, Save, Pause or Prepare now, or does not see the table;
  // no_claim=the API's 403s (test_rituals.py).
  await withRituals(page);
  await login(page, APPROVER);
  await openRituals(page);
  await expect(page.getByTestId("ritual-row")).toHaveCount(4);
  await expect(ritualRow(page, "Investor update")).toContainText("Paused");
  await expect(summaries(page)).toContainText("Summaries: On demand");
  await expect(summaries(page).getByRole("group", { name: "Summaries" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add ritual" })).toHaveCount(0);
  await ritualRow(page, "Weekly goals check-in").click();
  const panel = inspector(page);
  await expect(panel).toContainText("Mondays 9:00");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.getByRole("combobox")).toHaveCount(0);
});

test("12e: at 390 px the occurrence page stacks its blocks with no horizontal scroll", async ({ page }) => {
  // protects=AC12e, the phone layout; fails_when=cards sit side by side or the page scrolls
  // sideways; no_claim=other widths.
  await page.setViewportSize({ width: 390, height: 844 });
  await withRituals(page);
  await login(page);
  await page.goto("/company/rituals");
  await ritualRow(page, "Monthly roadmap refresh").getByRole("link").click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  const blocks = page.getByTestId("ritual-block");
  await expect(blocks.first()).toBeVisible();
  const boxes = await blocks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width })));
  expect(boxes.length).toBeGreaterThan(2);
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].x).toBe(boxes[0].x);
    expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("12f: the owner turns summaries to Every pre-read; the estimate follows, survives a reload, and drops when the check-in pauses", async ({ page }) => {
  // protects=AC12f, the summaries setting and its live monthly estimate; fails_when=the
  // estimate is missing or wrong under either mode, the choice is lost on reload, or pausing
  // the weekly check-in leaves the figure unchanged; no_claim=the run the ticker then starts.
  await withRituals(page);
  await login(page);
  await openRituals(page);
  const line = summaries(page);
  const mode = line.getByRole("group", { name: "Summaries" });
  await expect(mode.getByRole("button", { name: "On demand" })).toHaveAttribute("aria-pressed", "true");
  await expect(line.getByTestId("summaries-estimate")).toHaveText("If on: about $17 a month");
  await mode.getByRole("button", { name: "Every pre-read" }).click();
  await expect(line.getByTestId("summaries-estimate")).toHaveText("About $17 a month (6 summaries)");
  await line.getByRole("button", { name: "About the summaries estimate" }).click();
  await expect(line.getByRole("tooltip")).toContainText("Weekly goals check-in: 4.33 a month");
  await page.reload();
  await expect(mode.getByRole("button", { name: "Every pre-read" })).toHaveAttribute("aria-pressed", "true");
  await expect(line.getByTestId("summaries-estimate")).toHaveText("About $17 a month (6 summaries)");
  await ritualRow(page, "Weekly goals check-in").click();
  await inspector(page).getByRole("button", { name: "Pause" }).click();
  await expect(ritualRow(page, "Weekly goals check-in")).toContainText("Paused");
  await expect(line.getByTestId("summaries-estimate")).toHaveText("About $4 a month (1 summary)");
});

test("12g: an approver asks Oracle for a summary and sees it written; a failed summary says so", async ({ page }) => {
  // protects=AC12g, Summarize with Oracle and the summary states; fails_when=the button is
  // missing for an approver, no 'Writing the summary…' while the run is active, the summary
  // is not shown marked Written by Oracle, or the failed state is not said; no_claim=the
  // ritual_summary run itself (test_rituals.py, fake runtime).
  await withRituals(page);
  await login(page, APPROVER);
  await page.goto("/company/rituals");
  await openLastPreRead(page, "Monthly roadmap refresh");
  const card = page.getByTestId("occurrence-summary");
  await card.getByRole("button", { name: "Summarize with Oracle" }).click();
  await expect(card).toContainText("Writing the summary…");
  await expect(card).toContainText("Written by Oracle", { timeout: 15_000 });
  await expect(card).toContainText("One track is at risk");
  await page.goto("/company/rituals");
  await openLastPreRead(page, "Weekly goals check-in");
  await expect(page.getByTestId("occurrence-summary")).toContainText("Summary failed · Summarize with Oracle to retry");
  await expect(page.getByTestId("occurrence-state")).toHaveText("Held");
});

test("12h: there is no Rituals item under Settings", async ({ page }) => {
  // protects=AC12h, rituals live on Company only; fails_when=Settings lists Rituals;
  // no_claim=other Settings items.
  await withRituals(page);
  await login(page);
  await page.goto("/settings/members");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Rituals/ })).toHaveCount(0);
});

test("H2 review: an approver sees each ritual's owner by name", async ({ page }) => {
  // protects=the Owner column and the inspector's Owner name the ritual's owner for every
  // member who may see the table (the member directory, GET /v1/people); fails_when=a
  // non-owner sees "Someone" (the owner-only member list was read); no_claim=the owner's
  // member picker.
  await withRituals(page);
  await login(page, APPROVER);
  await openRituals(page);
  const owner = displayName(ADMIN.email);
  await expect(ritualRow(page, "Weekly goals check-in")).toContainText(owner);
  await expect(page.getByTestId("ritual-row").filter({ hasText: "Someone" })).toHaveCount(0);
  await ritualRow(page, "Weekly goals check-in").click();
  await expect(inspector(page)).toContainText(owner);
});

test("H2 review: a held occurrence lists the decisions recorded with it, each opening on Company › Decisions", async ({ page }) => {
  // protects="Held occurrences list the decisions recorded with them" (number and title),
  // and the link opens that decision; fails_when=the held page lists none, or the link
  // opens a page that does not show the decision; no_claim=recording a decision (H1's form).
  await withRituals(page);
  await login(page, APPROVER);
  await page.goto("/company/rituals");
  await openLastPreRead(page, "Weekly goals check-in");
  await expect(page.getByTestId("occurrence-state")).toHaveText("Held");
  const listed = page.getByTestId("occurrence-decisions").getByRole("link");
  await expect(listed).toHaveCount(1);
  await expect(listed).toHaveText(/^D-\d+ Ship usage caps before anomaly detection$/);
  await listed.click();
  await expect(page).toHaveURL(/\/company\/decisions\?d=\d+$/);
  await expect(page.getByTestId("decision-inspector").filter({ visible: true })).toContainText("Ship usage caps before anomaly detection");
});

test("H2 review: the rituals follow a change of the Company time zone", async ({ page }) => {
  // protects=rituals on the Company time zone move with it (owner decision 2026-10-22), in
  // the mock as in the API; fails_when=the inspector keeps Los Angeles after the owner picked
  // Tokyo; no_claim=the API's next dates (test_company_timezone.py).
  await withRituals(page);
  await login(page);
  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption("Asia/Tokyo");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await openRituals(page);
  await ritualRow(page, "Weekly goals check-in").click();
  await expect(inspector(page).getByTestId("ritual-zone")).toContainText("Asia/Tokyo");
});

test("One zone: a ritual has no Time zone field; the inspector names the Company time zone", async ({ page }) => {
  // protects=owner decision 2026-10-22: every ritual is in the Company time zone, so the
  // owner's inspector has no Time zone field, says the ritual runs in the Company time zone
  // and links to where it is set; a ritual the owner adds is in it too; fails_when=the
  // inspector still offers a zone, or a new ritual takes the browser's zone (New York);
  // no_claim=the API refusing a zone (test_rituals.py).
  await withRituals(page);
  await login(page);
  await openRituals(page);
  await ritualRow(page, "Monthly roadmap refresh").click();
  const panel = inspector(page);
  await expect(panel.getByLabel("Repeats")).toBeVisible();
  await expect(panel.getByLabel("Time zone")).toHaveCount(0);
  await expect(panel.getByTestId("ritual-zone")).toHaveText("Company time zone · America/Los_Angeles");
  await expect(panel.getByRole("link", { name: "Change" })).toHaveAttribute("href", "/settings/company#timezone");
  await page.getByRole("button", { name: "Add ritual" }).click();
  const form = page.getByRole("form", { name: "Add ritual" });
  await form.getByLabel("Title").fill("Pricing sync");
  await form.getByRole("button", { name: "Add" }).click();
  await ritualRow(page, "Pricing sync").click();
  await expect(inspector(page).getByTestId("ritual-zone")).toHaveText("Company time zone · America/Los_Angeles");
});
