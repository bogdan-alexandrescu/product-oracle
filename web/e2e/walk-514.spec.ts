import { expect, test, type Page } from "@playwright/test";

import { TRACK_ALERTS_MANY_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSeeded, seedRoadmapReview } from "./helpers";

/*
 * #514, the production walk of 2026-10-23: one waiting count on the rail, Home and the Inbox;
 * the Baseline run banner names what is closed; an unset Company time zone says which zone is
 * used. Driven through the UI on the mock layer.
 */

const badge = (page: Page) => page.getByTestId("nav-inbox-badge");
/** The header's "{n} waiting" chip (Home and /inbox). */
const waiting = (page: Page) => page.getByRole("main").getByText(/^\d+ waiting$/).first();
const number = async (l: ReturnType<typeof badge>) => Number((await l.innerText()).replace(/\D+/g, ""));

// Card one-count: protects = #514 finding 1, the rail badge, Home's Needs you and the Inbox
// header show the same number with a Roadmap items checkpoint of many items (10 need you) and
// a track with three open alerts: each counts once, as one row; fails_when = the badge counts
// a row's children (the checkpoint's items or the track's alerts) or anything the Inbox does
// not show; no_claim = the API's total (api/tests/test_inbox_total_rows.py).
test("the rail badge, Home and the Inbox count the same with a checkpoint of many items and a track of many alerts", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, TRACK_ALERTS_MANY_SCENARIO] as const);
  await login(page);
  await openSeeded(page, seedRoadmapReview, "/inbox");
  const rows = page.locator("tr[data-row]").filter({ visible: true });
  await expect(rows.filter({ hasText: "Roadmap items · 10 need you" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Usage alerts PRD · At risk · 3 need you" })).toHaveCount(1);
  await expect(waiting(page)).toBeVisible();
  const inbox = await number(waiting(page));
  expect(inbox).toBeGreaterThan(1);
  await expect(badge(page)).toHaveText(String(inbox));

  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-home").click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(waiting(page)).toHaveText(`${inbox} waiting`);
  await expect(badge(page)).toHaveText(String(inbox));
});

const BASELINE_RUN = "7a11c0de-0000-4000-8000-0000000000b2";

// Card run-review-closed: protects = #514 finding 2, once the run's review is decided the
// Baseline banner says the run's review is closed, not "View only", while the page still
// offers decisions on proposals; fails_when = "View only" shows beside live actions;
// no_claim = which proposals stay decidable (baseline-review.spec.ts).
test("Baseline from a decided run says the run's review is closed, not View only", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "baseline-review"] as const);
  await login(page);
  await page.goto(`/baseline?run=${BASELINE_RUN}`);
  const band = page.getByTestId("from-run-band");
  await expect(band).toContainText("From run · Build the baseline");
  const row = page.getByTestId("from-run-row").filter({ hasText: "Gift notes" });
  await row.getByRole("button", { name: "More actions for Gift notes" }).click();
  await row.getByRole("button", { name: "Look again…" }).click();
  await row.getByLabel("What should the agents look at").fill("looks like an older idea");
  await row.getByRole("button", { name: "Look again", exact: true }).click();
  await page.getByTestId("from-run-bar").getByRole("button", { name: "Send back to agents" }).click();
  await expect(page.getByTestId("band-decided")).toContainText("Sent back by");
  await expect(band).toContainText("Run review closed");
  await expect(band.getByText("View only", { exact: true })).toHaveCount(0);
});

// Card zone-fallback: protects = #514 finding 3, with no Company time zone stored, Home's Set
// up list and Settings › Notifications both say it is not set and that Pacific is used;
// fails_when = one says "Not set" while the other shows a zone as if chosen; no_claim = the
// zone's use on dates (company-timezone*.spec.ts).
test("an unset time zone reads 'Not set · Pacific is used' on Home and in Notifications", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("setup-row-timezone")).toContainText("Not set · Pacific is used");
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("report-schedule").getByTestId("report-zone")).toHaveText("Not set · Pacific is used");
});
