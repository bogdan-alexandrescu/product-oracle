import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * H5 Metrics review (#517, criterion 13): Settings › Analytics, Company › Metrics, the
 * metrics review occurrence and the Inbox's metric rows, driven through the UI as a person
 * would on the mock layer (lib/api/mock/metrics.ts). The "metrics" scenario seeds synthetic
 * metrics only: Weekly active teams (an output read from PostHog) and Invites sent per team
 * (an input that drives it, written by API), both owned by commenter@example.com, each with
 * an open variance in the week of Oct 12; Trial to paid rate (typed by hand, the approver's,
 * linked to Grow paid conversion). PostHog is connected, and the Weekly metrics review has
 * replaced the goals check-in: this Monday's occurrence is ready. The mock clock is Mon
 * 2026-10-19 12:00 UTC, the browser shows New York time and the Company time zone is
 * America/Los_Angeles. Each test states its card.
 */

const OWNER = "admin@example.com";
const APPROVER = "approver@example.com";
const METRIC_OWNER = "commenter@example.com";
const VIEWER = "viewer@example.com";
const START = new Date("2026-10-19T12:00:00Z");

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function withMetrics(page: Page) {
  await page.clock.install({ time: START });
  await page.addInitScript((key) => localStorage.setItem(key, "metrics"), MOCK_SCENARIO_KEY);
}

const badge = (page: Page) => page.getByTestId("app-nav").getByTestId("nav-inbox-badge");
const metricNeed = (page: Page, text: string) => page.getByTestId("inbox-metrics").locator("tr[data-row]").filter({ hasText: text });
const card = (page: Page, metric: string) => page.getByTestId("variance-card").filter({ hasText: metric });
const metricRow = (page: Page, title: string) => page.getByTestId("metric-row").filter({ hasText: title });
// Next keeps visited pages mounted but hidden: only what is on screen counts.
const viewOnly = (page: Page) => page.getByTestId("view-only").filter({ visible: true });

async function badgeCount(page: Page): Promise<number> {
  await expect(badge(page)).toHaveText(/^\d+$/);
  return Number(await badge(page).innerText());
}

async function openMetrics(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId("company-tab-metrics").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/metrics$/);
  await expect(page.getByTestId("company-tab-metrics").filter({ visible: true })).toHaveAttribute("aria-current", "page");
}

/** Opens this Monday's metrics review from Company › Rituals. */
async function openReview(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId("company-tab-rituals").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/rituals$/);
  await page.getByTestId("ritual-row").filter({ hasText: "Weekly metrics review" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly metrics review" })).toBeVisible();
}

test("13a: an owner connects PostHog in Settings › Analytics and the key is never shown again", async ({ page }) => {
  // protects=AC13a, Settings › Analytics for owners: the connection state, Disconnect with a
  // confirmation naming how many metrics pause, and Save (connect) with a write-only key;
  // fails_when=the tab is missing for an owner, the state does not read "Connected to PostHog"
  // with the project and host, the confirmation does not name the paused metric, or the key
  // field is filled after a reload; no_claim=the API's key test and encryption
  // (test_metrics_posthog.py), nor the real PostHog API (the mock accepts any key).
  await withMetrics(page);
  await login(page, OWNER);
  await page.getByTestId("app-nav").getByTestId("nav-settings").click();
  await page.getByTestId("nav-analytics").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/settings\/analytics$/);
  const state = page.getByTestId("analytics-state");
  await expect(state).toHaveText("Connected to PostHog · project 12345 · EU cloud");
  await page.getByRole("button", { name: "Disconnect" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("1 PostHog metric pauses");
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(state).toHaveText("Not connected");

  await page.getByLabel("Host").selectOption("us");
  await page.getByLabel("Project id").fill("67890");
  await page.getByLabel("Personal API key").fill("phx_example_key_for_tests");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(state).toHaveText("Connected to PostHog · project 67890 · US cloud");
  await expect(page.getByLabel("Personal API key")).toHaveValue("");

  await page.reload();
  await expect(state).toHaveText("Connected to PostHog · project 67890 · US cloud");
  await expect(page.getByLabel("Personal API key")).toHaveValue("");
  await expect(page.getByLabel("Personal API key")).toHaveAttribute("placeholder", "Replace key");
  // Oracle's words: a company, never a workspace or tenant.
  await expect(page.locator("main")).not.toContainText(/workspace|tenant/i);
});

test("13b: an approver adds an output metric linked to a goal, tests its query and sees its row", async ({ page }) => {
  // protects=AC13b, Company › Metrics' Add metric sheet: kind, unit, goal (confirmed goals
  // with the same unit), owner, PostHog query with Test (the last 4 weeks), and the new row
  // with its last week and 12-week sparkline; fails_when=Add metric is missing for an
  // approver, Test does not show four weekly values, the goal list offers a goal of another
  // unit, or the saved row lacks its last week or sparkline; no_claim=the API's backfill
  // (test_metrics.py) or the real PostHog query.
  await withMetrics(page);
  await login(page, APPROVER);
  await openMetrics(page);
  await expect(page.getByRole("navigation", { name: "Company" }).filter({ visible: true }).getByRole("link")).toHaveText([
    "Strategy",
    "Decisions",
    "Rituals",
    "Updates",
    "Metrics",
  ]);
  await expect(viewOnly(page)).toHaveCount(0);
  await expect(metricRow(page, "Weekly active teams")).toContainText("Commenter");
  await page.getByRole("button", { name: "Add metric" }).click();
  const sheet = page.getByRole("dialog", { name: "Add metric" });
  await sheet.getByLabel("Title").fill("Setup completion rate");
  await sheet.getByLabel("What it counts").fill("Accounts that finish setup within 7 days of signing up");
  await sheet.getByLabel("Kind").selectOption("output");
  await sheet.getByLabel("Unit", { exact: true }).fill("%");
  await sheet.getByLabel("Good direction").selectOption("up");
  // Grow paid conversion already has a metric; Raise activation is free and in %.
  await expect(sheet.getByLabel("Goal").locator("option")).toHaveText(["No goal", "Raise activation"]);
  await sheet.getByLabel("Goal").selectOption({ label: "Raise activation" });
  await sheet.getByLabel("Owner").selectOption({ label: "Approver" });
  await sheet.getByLabel("Source").selectOption("posthog");
  await sheet.getByLabel("Query").fill("select countIf(finished_setup) / count() * 100 from accounts where created_at between {period_start} and {period_end}");
  await sheet.getByRole("button", { name: "Test" }).click();
  await expect(sheet.getByTestId("metric-test-values").getByRole("listitem")).toHaveCount(4);
  await sheet.getByRole("button", { name: "Add metric" }).click();
  await expect(sheet).toBeHidden();
  const row = metricRow(page, "Setup completion rate");
  await expect(row).toContainText("Output");
  await expect(row).toContainText("PostHog");
  await expect(row.locator('[data-col="last"]')).toHaveText(/\d/);
  await expect(row.getByRole("img", { name: /^Trend / })).toBeVisible();
});

test("13c: the metric's owner explains a variance from the Inbox and the badge drops by one", async ({ page }) => {
  // protects=AC13c, the Inbox's "Explain a variance" row for the metric's owner (a
  // commenter), the occurrence's variance card (Better, two possible causes, Oracle's draft
  // marked "Drafted by Oracle") and Explain; fails_when=the row is missing or not worded "week
  // of Oct 12", Open does not reach the review, the card lacks its causes or draft, a
  // commenter who owns the metric gets no Explain, or the badge does not drop by 1;
  // no_claim=the API's owner check (test_metrics.py) or Oracle's real draft.
  await withMetrics(page);
  await login(page, METRIC_OWNER);
  const before = await badgeCount(page);
  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  const row = metricNeed(page, "Explain a variance · Weekly active teams · week of Oct 12");
  await expect(row).toHaveCount(1);
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Weekly metrics review" })).toBeVisible();
  const c = card(page, "Weekly active teams");
  await expect(c.getByTestId("variance-direction")).toHaveText("Better");
  await expect(c.getByTestId("variance-cause")).toHaveCount(2);
  await expect(c).toContainText("Drafted by Oracle");
  const box = c.getByLabel("Explanation");
  await expect(box).toHaveValue(/team-invite launch/);
  await box.fill("The team-invite launch on Oct 14 brought in teams that had been waiting for it.");
  await expect(c).not.toContainText("Drafted by Oracle");
  await c.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(c.getByTestId("variance-status")).toHaveText("Explained");
  await expect(c).toContainText("The team-invite launch on Oct 14 brought in teams");
  await expect.poll(() => badgeCount(page)).toBe(before - 1);
});

test("13d: the metric's owner picks Don't know yet and the card shows the day in the Company time zone", async ({ page }) => {
  // protects=AC13d, Don't know yet with a day to find out by (default 7 days, at most 28),
  // shown as "Finding out by Oct 26" from the Company's today (Oct 19 in Los Angeles);
  // fails_when=the control is missing for the owner, the day is not saved, or the card
  // shows another day; no_claim=the Find out Inbox row once the day passes
  // (test_metrics_review.py).
  await withMetrics(page);
  await login(page, METRIC_OWNER);
  await openReview(page);
  const c = card(page, "Invites sent per team");
  await expect(c.getByTestId("variance-direction")).toHaveText("Worse");
  await c.getByRole("button", { name: "Don't know yet" }).click();
  const day = c.getByLabel("Find out by");
  await expect(day).toHaveValue("2026-10-26");
  await expect(day).toHaveAttribute("max", "2026-11-16");
  await c.getByRole("button", { name: "Save" }).click();
  await expect(c.getByTestId("variance-status")).toHaveText("Finding out by Oct 26");
});

test("13e: a viewer reads Metrics and the review without any control, as View only", async ({ page }) => {
  // protects=AC13e and #370 (hidden, not disabled): a viewer sees the Metrics tab, the table
  // and the occurrence's variance cards with no Add metric, Explain, Don't know yet or Noise;
  // fails_when=a control is drawn (even disabled) or View only is missing; no_claim=the
  // API's 403s (test_metrics.py).
  await withMetrics(page);
  await login(page, VIEWER);
  await openMetrics(page);
  await expect(viewOnly(page).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add metric" })).toHaveCount(0);
  await expect(metricRow(page, "Weekly active teams")).toBeVisible();
  await openReview(page);
  await expect(viewOnly(page).first()).toBeVisible();
  await expect(page.getByTestId("variance-card")).toHaveCount(2);
  for (const name of ["Explain", "Don't know yet", "Noise", "Explain with Oracle"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
});

test("13f: a commenter has no Analytics tab under Settings", async ({ page }) => {
  // protects=AC13f, Settings › Analytics is the owners' (#370: the tab whose read the role
  // cannot call is not drawn); fails_when=a commenter sees the tab; no_claim=the API's 403
  // (test_metrics_posthog.py).
  await withMetrics(page);
  await login(page, METRIC_OWNER);
  await page.getByTestId("app-nav").getByTestId("nav-settings").click();
  await expect(page.getByTestId("nav-members").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("nav-analytics")).toHaveCount(0);
});

test("13g: an approver clicks Explain with Oracle and the summary arrives marked Written by Oracle", async ({ page }) => {
  // protects=AC13g, the metrics review's summary card: Explain with Oracle (not Summarize),
  // Writing… while the run works, then the run's summary marked "Written by Oracle";
  // fails_when=the label is Summarize with Oracle, no Writing… state, or the summary is not
  // shown; no_claim=the metrics_variance flow or its importer (test_metrics_review.py).
  await withMetrics(page);
  await login(page, APPROVER);
  await openReview(page);
  const summary = page.getByTestId("occurrence-summary");
  await expect(summary.getByRole("button", { name: "Summarize with Oracle" })).toHaveCount(0);
  await summary.getByRole("button", { name: "Explain with Oracle" }).click();
  await expect(summary).toContainText("Writing…");
  await expect(summary).toContainText("Written by Oracle");
  await expect(summary).toContainText("Weekly active teams");
});

test("13h: at 390 px the Metrics table and the variance cards have no horizontal scroll", async ({ page }) => {
  // protects=AC13h, the phone layout: the table stacks to Metric, Last week and Change, and
  // the variance cards wrap; fails_when=the page scrolls sideways on either screen;
  // no_claim=other phone sizes.
  await page.setViewportSize({ width: 390, height: 844 });
  await withMetrics(page);
  await login(page, METRIC_OWNER);
  await page.goto("/company/metrics");
  await expect(metricRow(page, "Weekly active teams")).toBeVisible();
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await wide()).toBeLessThanOrEqual(0);
  await page.goto("/company/rituals");
  await page.getByTestId("ritual-row").filter({ hasText: "Weekly metrics review" }).getByRole("link").click();
  await expect(page.getByTestId("variance-card")).toHaveCount(2);
  expect(await wide()).toBeLessThanOrEqual(0);
});
