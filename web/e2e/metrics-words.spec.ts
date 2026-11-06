import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner's metric words everywhere (Nov 5, 'Everywhere'): what Company › Metrics calls an
 * unusual week is called so in the Inbox's metric rows and the Weekly metrics review, never a
 * variance. The "metrics" scenario (lib/api/mock/metrics.ts) seeds Weekly active teams and
 * Invites sent per team, both owned by commenter@example.com, each with an open unusual week
 * in the week of Oct 12. The mock clock is Mon 2026-10-19 12:00 UTC.
 */

const APPROVER = "approver@example.com";
const METRIC_OWNER = "commenter@example.com";

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function withMetrics(page: Page) {
  await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  await page.addInitScript((key) => localStorage.setItem(key, "metrics"), MOCK_SCENARIO_KEY);
}

async function openReview(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await page.getByTestId("company-tab-rituals").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/rituals$/);
  await page.getByTestId("ritual-row").filter({ hasText: "Weekly metrics review" }).getByTestId("last-pre-read").click();
  await expect(page.getByRole("heading", { level: 2, name: "Weekly metrics review" })).toBeVisible();
}

test("metric-words: the Inbox asks the metric's owner to explain an unusual week", async ({ page }) => {
  // protects=the Inbox's metric row in the owner's words; fails_when=it reads "Explain a
  // variance"; no_claim=the 'N waiting' line (another PR's).
  await withMetrics(page);
  await login(page, METRIC_OWNER);
  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  const rows = page.getByTestId("inbox-metrics").locator("tr[data-row]");
  await expect(rows.filter({ hasText: "Explain an unusual week · Weekly active teams · week of Oct 12" })).toHaveCount(1);
  await expect(page.getByTestId("inbox-metrics")).not.toContainText(/variance/i);
});

test("metric-words: the Weekly metrics review lists Unusual weeks and Oracle explains each one", async ({ page }) => {
  // protects=the review's block title and Explain with Oracle's note; fails_when=either says
  // Variances or variance; no_claim=the pre-read.md export (test_metrics_review.py).
  await withMetrics(page);
  await login(page, APPROVER);
  await openReview(page);
  await expect(page.getByRole("heading", { level: 2, name: "Unusual weeks", exact: true })).toBeVisible();
  await expect(page.getByTestId("variance-card")).toHaveCount(2);
  await expect(page.getByTestId("occurrence-summary")).toContainText("Oracle drafts an explanation for each open unusual week below");
  await expect(page.locator("main")).not.toContainText(/variance/i);
});
