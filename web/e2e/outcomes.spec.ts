import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * H3 Predicted versus actual, driven through the UI as a person would, on the mock API
 * ("outcomes" scenario, synthetic: Saved payment methods is due for its check, 38% → 42%
 * and now 41%; Guided setup checklist needs a prediction; Order status emails is measuring;
 * six earlier predictions on Raise activation were assessed, 3 held).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page, role?: "viewer" | "approver") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
}

/** From Plan's tab strip, as a person gets there. */
async function openOutcomes(page: Page) {
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(/\/plan\/outcomes$/);
  await expect(page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("outcomes-table")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });

test("an approver confirms Oracle's proposal and the Inbox badge drops", async ({ page }) => {
  // protects=criterion 9a: Check due row, prediction and now, Oracle's proposal, Confirm sets
  // the chip and the badge drops by one; fails_when=the proposal is missing, Confirm records
  // another verdict, or the badge does not move; no_claim=the API's verdict rule.
  await start(page);
  const badge = page.getByTestId("nav-inbox-badge").first();
  await expect(badge).toBeVisible();
  const before = Number(await badge.innerText());
  await openOutcomes(page);
  const filters = page.getByTestId("outcome-filters");
  await filters.getByRole("button", { name: /^Check due/ }).click();
  await expect(filters.getByRole("button", { name: /^Check due/ })).toHaveAttribute("aria-pressed", "true");
  await row(page, "Saved payment methods").click();
  await expect(inspector(page)).toContainText("Predicted 38% → 42% · Now 41%");
  await expect(inspector(page).getByTestId("outcome-proposal")).toContainText("Partly held");
  await expect(inspector(page)).toContainText("it does not prove the item caused it");
  await inspector(page).getByTestId("outcome-confirm").click();
  await expect(inspector(page).getByTestId("outcome-state").first()).toHaveText("Partly held");
  await expect(badge).toHaveText(String(before - 1));
});

test("an approver adds a prediction to a Needs prediction row", async ({ page }) => {
  // protects=criterion 9b: baseline, predicted, partly-held line, unit and date turn the row
  // Predicted; fails_when=the chip stays Needs prediction or the values are lost;
  // no_claim=the API's 422 rule (tests/test_outcome_capture.py).
  await start(page);
  await openOutcomes(page);
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^Needs prediction/ }).click();
  await row(page, "Guided setup checklist").click();
  const form = inspector(page).getByTestId("prediction-form");
  await form.getByLabel("Baseline").fill("38");
  await form.getByLabel("Predicted").fill("42");
  await form.getByLabel("Partly held at").fill("40");
  await form.getByLabel("Unit").fill("%");
  await form.getByLabel("By").fill("2027-03-31");
  await form.getByRole("button", { name: "Save prediction" }).click();
  await expect(inspector(page).getByTestId("outcome-state").first()).toHaveText("Predicted");
  await expect(inspector(page)).toContainText("Predicted 38% → 42%");
});

test("Priorities shows the track record and each feature's factor line", async ({ page }) => {
  // protects=criterion 9c: the card reads ×0.77 · 3 of 6 held and a feature's explanation
  // shows the factor; fails_when=the card is missing or the score ignores the factor;
  // no_claim=the API's formula (tests/test_calibration.py).
  await start(page);
  await page.goto("/priorities");
  await expect(page.getByTestId("track-record")).toContainText("Track record ×0.77 · 3 of 6 held");
  await page.getByTestId("priority-row-F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const ex = page.getByTestId("explanation-F-1");
  await expect(ex.getByTestId("track-record-line")).toContainText("×0.77");
  await expect(ex.getByRole("list", { name: "Steps" })).toContainText("track record 0.77");
});

test("a viewer reads outcomes without Confirm or Edit", async ({ page }) => {
  // protects=criterion 9d: viewers see the table and the inspector, no Confirm or Edit;
  // fails_when=either button shows for a viewer; no_claim=the API's role checks.
  await start(page, "viewer");
  await openOutcomes(page);
  await row(page, "Saved payment methods").click();
  await expect(inspector(page)).toContainText("Saved payment methods");
  await expect(inspector(page).getByTestId("outcome-confirm")).toHaveCount(0);
  await expect(inspector(page).getByTestId("outcome-edit")).toHaveCount(0);
});

test("at 390 px the table keeps Item, State and Due with no horizontal scroll", async ({ page }) => {
  // protects=criterion 9e: the phone layout; fails_when=the page scrolls sideways or a kept
  // column is missing; no_claim=other phone sizes.
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.goto("/plan/outcomes");
  const table = page.getByTestId("outcomes-table");
  await expect(table).toBeVisible();
  const first = row(page, "Saved payment methods");
  await expect(first).toContainText("Saved payment methods");
  await expect(first.getByTestId("outcome-state")).toBeVisible();
  await expect(first.getByTestId("outcome-due")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await first.click();
  await expect(page.getByTestId("outcome-sheet")).toBeVisible();
});
