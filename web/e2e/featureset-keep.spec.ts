import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { SCOPE_CONSOLE_RUN, SCOPE_REVIEW_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * A feature-set call keeps every reason it was asked for. The "scope-review" scenario's
 * saved-addresses run (web/lib/api/mock/runs.ts seedScopeReviewRuns): Pick address in one step
 * needs a call for two reasons, "Low confidence" and "New, not in the baseline"; five of the
 * eight features are handled, so the bar starts at "5 of 8 handled". In the address-book run,
 * Bulk edit is blocked by its left-out dependency and its two reasons to confirm are kept by one
 * older call that answers both.
 */

const PICK = "Pick address in one step";

async function openReview(page: Page, run = SCOPE_REVIEW_RUN) {
  await page.addInitScript((key) => localStorage.setItem(key, "scope-review"), MOCK_SCENARIO_KEY);
  await login(page, "approver@example.com");
  await page.goto(`/runs/${run}`);
  await page.getByTestId("checkpoint-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Feature set" })).toBeAttached();
}

const row = (page: Page, title: string) =>
  page.getByTestId("scope-row").filter({
    has: page.getByTestId("feature-title").filter({ hasText: title }),
  });
const bar = (page: Page) => page.getByTestId("decision-bar");
const needsYou = (page: Page) => page.getByRole("button", { name: /^Needs you/ });

// Card keep-1: protects = each reason of a feature keeps its own call (the row's Keep, twice),
// the feature leaves Needs you once both are answered, the bar's tally moves and the tray
// lists each call; fails_when = the second Keep un-keeps the first (the row asks again), the
// count or the tally stays put, or the tray shows one chip; no_claim = waivers.
test("keeping both reasons of a feature keeps both, and the tally and tray follow", async ({ page }) => {
  await openReview(page);
  await expect(bar(page).getByTestId("decision-tally")).toContainText("5 of 8 handled");
  const pick = row(page, PICK);
  await expect(pick.getByTestId("row-reasons")).toContainText("Low confidence");
  await expect(pick.getByTestId("row-reasons")).toContainText("New, not in the baseline");

  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-reasons")).not.toContainText("Low confidence");
  await expect(
    bar(page)
      .getByTestId("staged-chip")
      .filter({ hasText: `${PICK}: included · low confidence` }),
  ).toBeVisible();
  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-done")).toContainText("✓ Included");
  await expect(needsYou(page)).toContainText("2");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("6 of 8 handled");
  const chips = bar(page).getByTestId("staged-chip").filter({ hasText: PICK });
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: "included · low confidence" })).toHaveCount(1);
  await expect(chips.filter({ hasText: "included · new, not in the baseline" })).toHaveCount(1);
});

// Card keep-2: protects = the side panel keeps each reason's call too, its Undo takes back one
// call only, and its Decision "Include" on a feature proposed as include answers what is left
// and shows as chosen; fails_when = the panel's Include un-keeps the reason kept before (the
// feature stays undecided, nothing chosen) or Undo drops both calls; no_claim = Leave out.
test("the side panel's Include answers what is left and shows as chosen", async ({ page }) => {
  await openReview(page);
  const pick = row(page, PICK);
  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-reasons")).not.toContainText("Low confidence");
  await pick.getByTestId("feature-title").click();
  const inspector = page.getByTestId("scope-inspector");
  await expect(inspector).toContainText(PICK);
  const include = inspector.getByRole("group", { name: "Decision" }).getByRole("button", { name: "Include" });
  await expect(include).toHaveAttribute("aria-pressed", "false");
  await include.click();
  await expect(include).toHaveAttribute("aria-pressed", "true");
  await expect(inspector.getByTestId("reason-low_confidence")).toContainText("✓ Included");
  await expect(inspector.getByTestId("reason-new_feature")).toContainText("✓ Included");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("6 of 8 handled");

  await inspector.getByTestId("reason-new_feature").getByRole("button", { name: "Undo" }).click();
  await expect(inspector.getByTestId("reason-new_feature")).not.toContainText("✓ Included");
  await expect(inspector.getByTestId("reason-low_confidence")).toContainText("✓ Included");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("5 of 8 handled");
});

// Card keep-3: protects = the same on a phone: the card's Include twice, the Decide sheet's
// tally and tray; fails_when = the card asks again after the second Include, or the sheet
// shows one call; no_claim = the desktop table (keep-1).
test("on a phone both calls are kept and the Decide sheet lists each", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReview(page);
  const pick = row(page, PICK);
  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-reasons")).not.toContainText("Low confidence");
  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-done")).toContainText("✓ Included");
  await bar(page).getByRole("button").click();
  const sheet = page.getByTestId("sheet-decide");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("decision-tally")).toContainText("6 of 8 handled");
  await expect(sheet.getByTestId("staged-chip").filter({ hasText: PICK })).toHaveCount(2);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

// Card review-1: protects = a feature kept for every reason to confirm reads as included in the
// side panel while a blocking reason is still open; fails_when = the panel shows "Oracle
// proposes" with nothing chosen; no_claim = the blocking reason's own fixes.
test("a feature kept for every reason to confirm shows Include chosen while it is still blocked", async ({ page }) => {
  await openReview(page, SCOPE_CONSOLE_RUN);
  await row(page, "Bulk edit").getByTestId("feature-title").click();
  const inspector = page.getByTestId("scope-inspector");
  await expect(inspector).toContainText("Bulk edit");
  await expect(inspector.getByTestId("reason-new_feature")).toContainText("✓ Included");
  await expect(inspector.getByTestId("reason-low_confidence")).toContainText("✓ Included");
  await expect(inspector.getByText("Blocking", { exact: true })).toBeVisible();
  const include = inspector.getByRole("group", { name: "Decision" }).getByRole("button", { name: "Include" });
  await expect(include).toHaveAttribute("aria-pressed", "true");
  await expect(inspector.getByTestId("proposed-decision")).toHaveCount(0);
});

// Card review-2: protects = the row's Undo of a feature kept with two calls takes back both
// at once: the row asks again, the tray drops both chips and the tally goes back; fails_when =
// a call stays staged after Undo; no_claim = the side panel's Undo of one call (keep-2).
test("the row's Undo takes back both calls of a feature", async ({ page }) => {
  await openReview(page);
  const pick = row(page, PICK);
  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-reasons")).not.toContainText("Low confidence");
  await pick.getByRole("button", { name: "Include", exact: true }).click();
  await expect(pick.getByTestId("row-done")).toContainText("✓ Included");
  await expect(bar(page).getByTestId("staged-chip").filter({ hasText: PICK })).toHaveCount(2);

  await pick.getByTestId("row-done").getByRole("button", { name: "Undo" }).click();
  await expect(pick.getByTestId("row-reasons")).toContainText("Low confidence");
  await expect(pick.getByTestId("row-reasons")).toContainText("New, not in the baseline");
  await expect(bar(page).getByTestId("staged-chip").filter({ hasText: PICK })).toHaveCount(0);
  await expect(bar(page).getByTestId("decision-tally")).toContainText("5 of 8 handled");
});

// Card review-3: protects = the side panel's Include on a feature the set includes but only a
// blocking reason holds says what to do instead of doing nothing; fails_when = no visible
// response; no_claim = the blocking reason's fixes themselves.
test("the side panel's Include on a blocked feature says to fix what blocks it", async ({ page }) => {
  await openReview(page);
  await row(page, "Bulk edit").getByTestId("feature-title").click();
  const inspector = page.getByTestId("scope-inspector");
  await expect(inspector).toContainText("Bulk edit");
  await inspector.getByRole("group", { name: "Decision" }).getByRole("button", { name: "Include" }).click();
  await expect(inspector.getByTestId("include-blocked")).toHaveText("Fix what blocks it first, above.");
});

// Card review-4: protects = Undo of one reason kept by an older call that answers two takes
// back that reason only; fails_when = Undo un-keeps both reasons; no_claim = calls made now,
// which are one per reason (keep-2).
test("Undo of one reason kept by an older call for two keeps the other", async ({ page }) => {
  await openReview(page, SCOPE_CONSOLE_RUN);
  await row(page, "Bulk edit").getByTestId("feature-title").click();
  const inspector = page.getByTestId("scope-inspector");
  await expect(inspector.getByTestId("reason-new_feature")).toContainText("✓ Included");
  await inspector.getByTestId("reason-new_feature").getByRole("button", { name: "Undo" }).click();
  await expect(inspector.getByTestId("reason-new_feature")).not.toContainText("✓ Included");
  await expect(inspector.getByTestId("reason-low_confidence")).toContainText("✓ Included");
  const chips = bar(page).getByTestId("staged-chip").filter({ hasText: "Bulk edit" });
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText("included · low confidence");
});
