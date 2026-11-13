import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * QA findings, Nov 12 2026 (lane b, Company › Rituals), on the mock layer
 * (lib/api/mock/rituals.ts, "rituals" scenario). Driven through the UI as a person would.
 * Invented example data only.
 */

const START = new Date("2026-10-23T12:00:00Z");

test.use({ timezoneId: "America/Los_Angeles", locale: "en-US" });

async function withRituals(page: Page) {
  await page.clock.install({ time: START });
  await page.addInitScript((key) => localStorage.setItem(key, "rituals"), MOCK_SCENARIO_KEY);
}

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });

async function openRituals(page: Page) {
  await withRituals(page);
  await login(page);
  await page.goto("/company/rituals");
  await expect(ritualRow(page, "Weekly goals check-in")).toBeVisible();
}

/** Opens a ritual's latest pre-read from its "Latest pre-read" link. */
async function openLastPreRead(page: Page, title: string) {
  await ritualRow(page, title).getByTestId("last-pre-read").click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
}

test("detailed-b 7: the roadmap refresh's tracks, stale items and priority change link out, and the feature's code shows with its name", async ({ page }) => {
  // protects=detailed-b 7; fails_when=a track's "N at risk" is not its own link, a stale item
  // is not linked, or a priority change shows the feature's name with no code; no_claim=the
  // API's own ritual pre-read schema (api/oracle/rituals/blocks.py).
  await openRituals(page);
  await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);

  const tracks = page.getByTestId("ritual-tracks");
  const trackLink = tracks.getByRole("link", { name: "Usage alerts PRD" });
  await expect(trackLink).toHaveAttribute("href", /^\/roadmap\?track=/);
  const atRisk = tracks.getByTestId("track-at-risk");
  await expect(atRisk).toHaveText("2 at risk");
  await expect(atRisk).toHaveAttribute("href", /^\/roadmap\?track=/);

  const stale = page.getByTestId("ritual-stale-items");
  await expect(stale.getByRole("link", { name: "Digest emails" })).toHaveAttribute("href", "/roadmap?item=usage-alerts:digest-emails");

  const changes = page.getByTestId("ritual-priority-changes");
  await expect(changes.getByRole("link", { name: "F-21 Usage alerts: #5 → #2" })).toHaveAttribute("href", "/priorities");
});

test("detailed-b 8: a Weekly goals check-in's summary heads with its own title, not the roadmap refresh's", async ({ page }) => {
  // protects=detailed-b 8; fails_when=the summary reads "Monthly roadmap refresh — summary"
  // for a kind that is not the roadmap refresh.
  await openRituals(page);
  await openLastPreRead(page, "Weekly goals check-in");
  const summary = page.getByTestId("occurrence-summary");
  await expect(summary).toContainText("Summary failed");
  await summary.getByRole("button", { name: "Summarize with Oracle" }).click();
  await expect(summary).toContainText("Written by Oracle", { timeout: 15_000 });
  await expect(summary.getByRole("heading", { name: "Weekly goals check-in — summary" })).toBeVisible();
  await expect(summary.getByRole("heading", { name: "Monthly roadmap refresh — summary" })).toHaveCount(0);
});

test("detailed-b 16: with a ritual selected, the company time zone's Set it link shows once, above the table", async ({ page }) => {
  // protects=detailed-b 16; fails_when=Set it appears twice (above the table and again in the
  // selected ritual's schedule form).
  await openRituals(page);
  // Desktop always has a selected ritual beside the table (the first row).
  await expect(page.getByTestId("ritual-inspector").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Set it" })).toHaveCount(1);
  await expect(page.getByTestId("rituals-zone").getByRole("link", { name: "Set it" })).toBeVisible();
});

test("detailed-b 17: Add ritual's defaults sentence sits behind an (i), not as a second line of prose", async ({ page }) => {
  // protects=detailed-b 17; fails_when=the defaults sentence is visible on the page before the
  // (i) is opened.
  await openRituals(page);
  await page.getByRole("button", { name: "Add ritual" }).click();
  const form = page.getByRole("form", { name: "Add ritual" });
  await expect(form.getByText("It starts every Monday", { exact: false }).filter({ visible: true })).toHaveCount(0);
  const info = form.getByRole("button", { name: "About this ritual's defaults" });
  await expect(info).toBeVisible();
  await info.click();
  const tip = form.getByRole("tooltip");
  await expect(tip).toContainText("It starts every Monday at 9:00 AM for 30 minutes");
  await expect(tip).toContainText("Change any of it in the panel once it is added.");
});

test("detailed-b 18: the occurrence page's back link reads Rituals with the Runs page's icon and a gap", async ({ page }) => {
  // protects=detailed-b 18; fails_when=the link reads "← Rituals" with no icon and no gap.
  await openRituals(page);
  await ritualRow(page, "Monthly roadmap refresh").getByTestId("next-pre-read").click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  const back = page.getByTestId("occurrence-heading").getByRole("link", { name: "Rituals" });
  await expect(back).toBeVisible();
  await expect(back).toHaveClass(/gap-1/);
  await expect(back.locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("occurrence-heading").getByText("←Rituals")).toHaveCount(0);
});
