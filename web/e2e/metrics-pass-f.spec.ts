import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * Visual QA pass F, Company › Metrics (F-4, F-14, F-40, F-45, F-46), driven through the UI on
 * the mock layer's "metrics" scenario: Weekly active teams (412 teams in the week of Oct 12,
 * +37 on the week before), and Trial to paid rate (typed by hand, 13 weeks from Jul 20 to
 * Oct 12, linked to Grow paid conversion with a target of 12%). The mock clock is Mon
 * 2026-10-19. Each test's card: protects; fails_when; no_claim.
 */

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function openMetric(page: Page, title: string) {
  await page.clock.install({ time: new Date("2026-10-19T12:00:00Z") });
  await page.addInitScript((key) => localStorage.setItem(key, "metrics"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/company/metrics");
  await page.getByTestId("metric-row").filter({ hasText: title }).click();
}

// protects=F-4: on a phone, Edit in the metric sheet opens the form above the sheet, so its
// fields and Save are usable; fails_when=the form sits behind the sheet (the click is
// intercepted); no_claim=what Save sends.
test("pass F: phone, Edit from the metric sheet opens the form above it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMetric(page, "Weekly active teams");
  const sheet = page.getByTestId("metric-sheet");
  await sheet.getByRole("button", { name: "Edit" }).click();
  const form = page.getByRole("dialog", { name: "Edit metric" });
  await form.getByLabel("Title").fill("Weekly active teams (all)", { timeout: 3000 });
  await form.getByRole("button", { name: "Save" }).click({ timeout: 3000 });
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("metric-row").filter({ hasText: "Weekly active teams (all)" })).toHaveCount(1);
});

// protects=F-14: the chart has dates on its x axis, values on its y axis, the linked goal's
// target line and a value on hover or focus; the inspector lists the weekly values with Edit;
// fails_when=any of these is missing; no_claim=the band's arithmetic.
test("pass F: the metric chart reads its weeks, values and target, and lists each week", async ({ page }) => {
  await openMetric(page, "Trial to paid rate");
  const inspector = page.getByTestId("metric-inspector");
  const chart = inspector.getByTestId("metric-chart");
  await expect(chart.getByTestId("chart-x")).toHaveText(["Jul 20", "Aug 31", "Oct 12"]);
  await expect(chart.getByTestId("chart-y")).toHaveText(["12%", "8.9%"]);
  await expect(chart.getByTestId("chart-target")).toBeVisible();
  await chart.getByRole("button", { name: "Week of Oct 12: 9.5%" }).focus();
  await expect(chart.getByTestId("chart-point-label")).toHaveText("Oct 12: 9.5%");
  const weeks = inspector.getByTestId("metric-weeks").getByRole("listitem");
  await expect(weeks).toHaveCount(13);
  await expect(weeks.first()).toContainText("Oct 12");
  await expect(weeks.first()).toContainText("9.5%");
  await weeks.nth(1).getByRole("button", { name: "Change" }).click();
  await expect(inspector.getByRole("combobox", { name: /^Week/ })).toHaveValue("2026-10-05");
  await expect(inspector.getByLabel("Value", { exact: true })).toHaveValue("9.4");
});

// protects=F-46: a value that is not a number says so, a saved value is confirmed in a toast,
// and Archive offers Undo; fails_when=Record is greyed with no hint, nothing confirms the
// save, or Archive has no way back outside the panel; no_claim=the variance it may raise.
test("pass F: recording says Enter a number, confirms the save, and Archive can be undone", async ({ page }) => {
  await openMetric(page, "Trial to paid rate");
  const inspector = page.getByTestId("metric-inspector");
  await inspector.getByLabel("Value", { exact: true }).fill("abc");
  await expect(inspector.getByText("Enter a number")).toBeVisible();
  await inspector.getByLabel("Value", { exact: true }).fill("9.6");
  await inspector.getByRole("button", { name: "Record" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved week of Oct 12" })).toBeVisible();
  await expect(inspector.getByTestId("metric-weeks").getByRole("listitem").first()).toContainText("9.6%");
  await inspector.getByRole("button", { name: "Archive" }).click();
  const toast = page.getByRole("status").filter({ hasText: "Archived Trial to paid rate" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("metric-row").filter({ hasText: "Trial to paid rate" })).toContainText("Active");
});

// protects=F-40: with the inspector open the Change column shows the whole change beside its
// chip; fails_when="+37 (+9..." is cut; no_claim=a phone (the chip wraps there).
test("pass F: the Change column shows the whole change with the inspector open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMetric(page, "Weekly active teams");
  const change = page.getByTestId("metric-row").filter({ hasText: "Weekly active teams" }).getByTestId("change-value");
  await expect(change).toHaveText("+37 (+9.9%)");
  expect(await change.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
});

// protects=F-45: the chart and the form keep their explanations behind an (i), in plain words
// (Result / Driver, unusual week, alert size); fails_when=the sentences sit on the page or the
// jargon shows; no_claim=the (i) wording.
test("pass F: the chart and the form keep explanations behind an (i), in plain words", async ({ page }) => {
  await openMetric(page, "Weekly active teams");
  const inspector = page.getByTestId("metric-inspector");
  await expect(inspector.getByTestId("metric-chart").getByText("Shaded")).toBeHidden();
  await expect(inspector).toContainText("Unusual weeks");
  await expect(inspector).toContainText("Alert size");
  await inspector.getByRole("button", { name: "Edit" }).click();
  const form = page.getByRole("dialog", { name: "Edit metric" });
  await expect(form.getByLabel("Kind")).toContainText("Result");
  await expect(form).not.toContainText("An output is a result");
  await expect(form.getByTestId("metric-kind-help")).toBeHidden();
  await expect(form.getByText("A PostHog query that returns one number")).toBeHidden();
  await expect(form).not.toContainText("is a variance too");
  await expect(form.getByLabel("Alert size (%)")).toBeVisible();
  await expect(form.getByRole("button", { name: "About PostHog" })).toBeVisible();
});
