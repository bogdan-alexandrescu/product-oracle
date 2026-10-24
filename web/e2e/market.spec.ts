import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * H7 Competitive digest (#518 lane 3): Company › Market (Alternatives, Change log with From
 * the web, Positioning), the diff view, the digest occurrence's cards with Promote and
 * Dismiss, driven through the UI as a person would on the mock layer
 * (lib/api/mock/market.ts). The "market" scenario seeds made-up alternatives (Competitor A,
 * direct; Competitor B, indirect; Spreadsheets, the status quo), a page change on Competitor
 * A's pricing page, three not-vetted web findings on .example hosts (one whose summary holds
 * an HTML link and a Markdown link), two positioning suggestions, and the Monthly competitive
 * digest's pre-read prepared early for Thu Nov 5 (the owner and the approver attend). The
 * mock clock is Fri Oct 23 2026 12:00 UTC; the Company time zone is America/Los_Angeles.
 * Each test states its card. The mock layer stands in for the API: the API's own rules are
 * pytest's (test_market*.py), and a real model's digest is not exercised.
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
const START = new Date("2026-10-23T12:00:00Z");

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function withMarket(page: Page) {
  await page.clock.install({ time: START });
  await page.addInitScript((key) => localStorage.setItem(key, "market"), MOCK_SCENARIO_KEY);
}

async function openMarket(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId("company-tab-market").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/market$/);
  await expect(page.getByTestId("company-tab-market").filter({ visible: true })).toHaveAttribute("aria-current", "page");
}

const subTab = (page: Page, name: string) => page.getByRole("group", { name: "Market" }).getByRole("button", { name });
const alternativeRow = (page: Page, name: string) => page.getByTestId("alternative-row").filter({ hasText: name });
const inspector = (page: Page) => page.getByTestId("alternative-inspector").filter({ visible: true });
const findings = (page: Page) => page.getByTestId("web-finding").filter({ visible: true });

/** The page scrolls sideways when its content is wider than the viewport. */
async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

test("15a: an approver adds Competitor C as Direct, watches its pricing page and sees First read Oct 23", async ({ page }) => {
  // protects=AC15a, the Market tab (last of the Company tabs), Add alternative and Watch a
  // page, the first read's date in the Company time zone; fails_when=the tab is missing, the
  // alternative is not added with its kind, the page is not listed with its host, or the
  // first read is missing or shown in another zone; no_claim=the real fetcher, robots.txt or
  // the 10-page and 60-page limits (test_market.py, test_market_watch.py).
  await withMarket(page);
  await login(page, APPROVER);
  await openMarket(page);
  await expect(page.getByRole("navigation", { name: "Company" }).filter({ visible: true }).getByRole("link")).toHaveText([
    "Strategy",
    "Decisions",
    "Rituals",
    "Updates",
    "Market",
  ]);
  await expect(alternativeRow(page, "Competitor A")).toContainText("Direct");
  await expect(alternativeRow(page, "Spreadsheets")).toContainText("Status quo");
  await page.getByRole("button", { name: "Add alternative" }).click();
  const dialog = page.getByRole("dialog", { name: "Add alternative" });
  await dialog.getByLabel("Name").fill("Competitor C");
  await dialog.getByLabel("Kind").selectOption("direct");
  await dialog.getByLabel("Website").fill("https://competitor-c.example");
  await dialog.getByLabel("Aliases").fill("CompC");
  await dialog.getByRole("button", { name: "Add alternative" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(alternativeRow(page, "Competitor C")).toContainText("Direct");
  const panel = inspector(page);
  await expect(panel).toContainText("Competitor C");
  await panel.getByRole("button", { name: "Watch a page" }).click();
  await panel.getByLabel("Page URL").fill("https://competitor-c.example/pricing");
  await panel.getByLabel("Label").selectOption("pricing");
  await panel.getByRole("button", { name: "Watch", exact: true }).click();
  const watched = panel.getByTestId("watched-page").filter({ hasText: "competitor-c.example" });
  await expect(watched).toContainText("Pricing");
  await expect(watched).toContainText("First read Oct 23");
  await expect(alternativeRow(page, "Competitor C")).toContainText("1");
  // Oracle's words: a company, never a workspace or tenant.
  // (Next keeps visited pages mounted but hidden, so only the Market's own panels are read.)
  for (const part of [page.getByRole("region", { name: "Alternatives" }), panel]) await expect(part).not.toContainText(/workspace|tenant/i);
});

test("15b: the approver opens a change in Competitor A's log and sees removed and added lines in plain text, with no live links", async ({ page }) => {
  // protects=AC15b, the diff view: removed lines struck through, added lines highlighted,
  // both as plain text; fails_when=a line is missing, the ops are swapped, or a URL in the
  // page's text renders as a link; no_claim=difflib's diff itself (test_market_watch.py).
  await withMarket(page);
  await login(page, APPROVER);
  await openMarket(page);
  await alternativeRow(page, "Competitor A").click();
  const panel = inspector(page);
  await panel.getByTestId("change-row").filter({ hasText: "Pricing" }).first().click();
  const diff = page.getByTestId("change-diff").filter({ visible: true });
  await expect(diff.locator('[data-op="-"]')).toContainText(["Pro: $20 per seat"]);
  await expect(diff.locator('[data-op="+"]').first()).toContainText("Team: $400 a month");
  await expect(diff.locator('[data-op="-"] del')).toHaveCount(await diff.locator('[data-op="-"]').count());
  await expect(diff.locator('[data-op="+"] ins')).toHaveCount(await diff.locator('[data-op="+"]').count());
  await expect(diff).toContainText("https://competitor-a.example/signup");
  await expect(diff.locator("a")).toHaveCount(0);
});

test("15c: the approver follows the Inbox row to the digest, writes it with Oracle and sees Battlecard inputs and From the web", async ({ page }) => {
  // protects=AC15c, the Inbox's Pre-read ready row for the digest, the four blocks as cards,
  // the digest card's "Write the digest with Oracle" then "Written by Oracle"; fails_when=the
  // row is missing, the button reads Summarize, the written digest lacks its Battlecard
  // inputs, or the From the web card is missing; no_claim=the digest run, its $7.00 estimate
  // or its importer (test_market_digest.py), or a real model's text.
  await withMarket(page);
  await login(page, APPROVER);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-rituals").locator("tr[data-row]").filter({ hasText: "Pre-read ready · Monthly competitive digest" });
  await expect(row).toHaveCount(1);
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Monthly competitive digest" })).toBeVisible();
  const blocks = page.getByTestId("ritual-block");
  await expect(blocks).toHaveCount(4);
  await expect(blocks.filter({ hasText: "Changes" }).first()).toContainText("Competitor A");
  const summary = page.getByTestId("occurrence-summary");
  await summary.getByRole("button", { name: "Write the digest with Oracle" }).click();
  await expect(summary).toContainText("Written by Oracle");
  await expect(summary.getByRole("heading", { name: "Battlecard inputs" })).toBeVisible();
  const web = page.getByTestId("ritual-block").filter({ has: page.getByRole("heading", { name: "From the web" }) });
  await expect(web).toHaveCount(1);
  await expect(web.getByTestId("web-finding").first()).toContainText("Not vetted");
});

test("15d: each finding shows Not vetted, its host and date; a promoted one joins the Change log, a dismissed one is gone after a reload", async ({ page }) => {
  // protects=AC15d, From the web on Company › Market › Change log: the Not vetted chip, the
  // source host and date, Promote to change log (the change reads "From the web ·
  // reviews.example") and Dismiss with a reason; fails_when=a chip, host or date is missing,
  // the promoted finding is not in the change log, or the dismissed one comes back after a
  // reload; no_claim=the 180-day rule in the next import (test_market_web_findings.py).
  await withMarket(page);
  await login(page, APPROVER);
  await openMarket(page);
  await subTab(page, "Change log").click();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: /^From the web/ }).click();
  await expect(findings(page)).toHaveCount(3);
  for (const card of await findings(page).all()) await expect(card).toContainText("Not vetted");
  const review = findings(page).filter({ hasText: "Review: setup takes too long" });
  await expect(review).toContainText("reviews.example");
  await expect(review).toContainText("Oct 18");
  await expect(review.getByRole("link", { name: /Open page/ })).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(review.getByRole("link", { name: /Open page/ })).toHaveAttribute("target", "_blank");
  await review.getByRole("button", { name: "Promote to change log" }).click();
  await expect(findings(page).filter({ hasText: "Review: setup takes too long" })).toHaveCount(0);
  const news = findings(page).filter({ hasText: "Competitor B raises its prices" });
  await news.getByRole("button", { name: "Dismiss" }).click();
  await news.getByLabel("Why dismiss (optional)").fill("Old news");
  await news.getByRole("button", { name: "Dismiss finding" }).click();
  await expect(findings(page).filter({ hasText: "Competitor B raises its prices" })).toHaveCount(0);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Changes", exact: true }).click();
  await expect(page.getByTestId("change-row").filter({ hasText: "From the web · reviews.example" })).toContainText("Review: setup takes too long");
  await page.reload();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: /^From the web/ }).click();
  await expect(findings(page)).toHaveCount(1);
  await expect(findings(page).filter({ hasText: "Competitor B raises its prices" })).toHaveCount(0);
});

test("15e: a finding's summary with an HTML link and a Markdown link shows them as plain text, with no extra link", async ({ page }) => {
  // protects=AC15e, findings' title and summary drawn as plain text; fails_when=the HTML or
  // Markdown link in a finding's text renders as a link anywhere on the page;
  // no_claim=the importer's own cleaning of titles and summaries (test_market_digest.py).
  await withMarket(page);
  await login(page, APPROVER);
  await page.goto("/company/market?tab=changes&view=web");
  const card = findings(page).filter({ hasText: "Competitor A opens a free plan" });
  await expect(card).toContainText('<a href="https://evil.example">click</a>');
  await expect(card).toContainText("[the details](https://evil.example/plan)");
  await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0);
  await expect(card.getByRole("link")).toHaveCount(1);
});

test("15f: on Positioning the approver accepts a suggestion (its web evidence Not vetted) and dismisses another; after a reload both are gone", async ({ page }) => {
  // protects=AC15f, the six fields with their open suggestions, Accept and Dismiss, a web
  // ref's Not vetted chip; fails_when=the accepted item is not in its field after a reload,
  // a decided suggestion is still shown, or the web evidence is not marked Not vetted;
  // no_claim=the audit event or the removed-items rule (test_positioning.py).
  await withMarket(page);
  await login(page, APPROVER);
  await openMarket(page);
  await subTab(page, "Positioning").click();
  const fields = page.getByTestId("positioning-field");
  await expect(fields).toHaveCount(6);
  const unique = fields.filter({ has: page.getByRole("heading", { name: "Unique attributes" }) });
  const accept = unique.getByTestId("positioning-suggestion").filter({ hasText: "Set up in one afternoon" });
  await expect(accept.getByTestId("suggestion-ref").filter({ hasText: "Review: setup takes too long" })).toContainText("Not vetted");
  await accept.getByRole("button", { name: "Accept" }).click();
  await expect(unique.getByTestId("positioning-item").filter({ hasText: "Set up in one afternoon" })).toHaveCount(1);
  const trends = fields.filter({ has: page.getByRole("heading", { name: "Relevant trends" }) });
  await trends.getByTestId("positioning-suggestion").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("positioning-suggestion")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("positioning-field")).toHaveCount(6);
  await expect(unique.getByTestId("positioning-item").filter({ hasText: "Set up in one afternoon" })).toHaveCount(1);
  await expect(page.getByTestId("positioning-suggestion")).toHaveCount(0);
});

test("15g: a viewer sees Market read-only: no Add, Watch, Check now, Promote, Accept or Dismiss, and View only", async ({ page }) => {
  // protects=AC15g, #370 for Market: the controls a viewer can never use are absent, not
  // disabled, and the header says View only; fails_when=any write control is drawn, or View
  // only is missing; no_claim=the API's 403s (test_market.py).
  await withMarket(page);
  await login(page, VIEWER);
  await openMarket(page);
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
  await alternativeRow(page, "Competitor A").click();
  await expect(inspector(page)).toContainText("competitor-a.example");
  const none = ["Add alternative", "Watch a page", "Check now", "Pause", "Remove", "Promote to change log", "Accept", "Dismiss"];
  for (const name of none) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(inspector(page).getByTestId("web-finding").first()).toContainText("Not vetted");
  await subTab(page, "Change log").click();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: /^From the web/ }).click();
  await expect(findings(page)).toHaveCount(3);
  for (const name of none) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await subTab(page, "Positioning").click();
  await expect(page.getByTestId("positioning-suggestion").first()).toBeVisible();
  for (const name of [...none, "Edit"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
});

test("15h: at 390 px the change log, a diff and the From the web card have no horizontal scroll", async ({ page }) => {
  // protects=AC15h, the phone layout: tables collapse to Alternative and Last change, the
  // diff and findings wrap; fails_when=the page scrolls sideways on any of the three, or the
  // alternatives table shows its desktop columns; no_claim=other phone widths.
  await page.setViewportSize({ width: 390, height: 844 });
  await withMarket(page);
  await login(page, APPROVER);
  await page.goto("/company/market");
  await expect(alternativeRow(page, "Competitor A")).toBeVisible();
  await expect(alternativeRow(page, "Competitor A").locator('[data-col="pages"]')).toBeHidden();
  expect(await scrollsSideways(page)).toBe(false);
  await page.goto("/company/market?tab=changes");
  await expect(page.getByTestId("change-row").first()).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await page.getByTestId("change-row").filter({ hasText: "Pricing" }).first().click();
  await expect(page.getByTestId("change-diff").filter({ visible: true })).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await page.goto("/company/market?tab=changes&view=web");
  await expect(findings(page).first()).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-rituals").locator("[data-row]").filter({ hasText: "Monthly competitive digest" }).first();
  await row.getByRole("link", { name: "Open" }).click();
  const web = page.getByTestId("ritual-block").filter({ has: page.getByRole("heading", { name: "From the web" }) });
  await expect(web.getByTestId("web-finding").first()).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
});

test("Positioning check on a tier-1 launch links to Company › Market › Positioning", async ({ page }) => {
  // protects=the H6 Positioning check task's "Open positioning" link (#518 Positioning);
  // fails_when=the link is missing or opens another page; no_claim=a draft for the task
  // (there is none).
  await page.clock.install({ time: START });
  await page.addInitScript((key) => localStorage.setItem(key, "launches"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/plan/documents");
  await page.getByTestId("roadmap-launches-link").click();
  await page.getByTestId("launch-row").filter({ hasText: "Hard budget caps" }).click();
  const task = page.getByTestId("launch-inspector").filter({ visible: true }).locator('[data-testid="launch-task"][data-key="positioning_check"]');
  await expect(task).toHaveCount(1);
  await task.getByRole("link", { name: "Open positioning" }).click();
  await expect(page).toHaveURL(/\/company\/market\?tab=positioning$/);
  await expect(page.getByTestId("positioning-field")).toHaveCount(6);
});
