import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { SCOPE_REVIEW_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * A feature-set call keeps every reason it was asked for. The "scope-review" scenario's
 * saved-addresses run (web/lib/api/mock/runs.ts seedScopeReviewRuns): Pick address in one step
 * needs a call for two reasons, "Low confidence" and "New, not in the baseline"; five of the
 * eight features are handled, so the bar starts at "5 of 8 handled".
 */

const PICK = "Pick address in one step";

async function openReview(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "scope-review"), MOCK_SCENARIO_KEY);
  await login(page, "approver@example.com");
  await page.goto(`/runs/${SCOPE_REVIEW_RUN}`);
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
