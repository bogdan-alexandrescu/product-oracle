import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * One Company time zone (owner decision 2026-10-22) and the company's goal horizons (B5
 * review finding), driven through Settings, Home and the goal form as a person would, on
 * the mock layer.
 */

// protects: an owner sets the Company time zone on Settings › Company (America/Los_Angeles
// until then, owner decision 2026-10-22), the
// Set up checklist's Time zone step opens it and shows the zone, and the weekly alignment
// report says it runs in that zone instead of asking for its own.
// fails_when: there is no Company time zone, it reads UTC before an owner sets it, it does
// not stick, or the report still has its own Time zone field.
// no_claim: the API's use of the zone (pytest covers goals' today, the report and rituals).
test("Company time zone: set on Settings › Company, read by the weekly report", async ({ page }) => {
  await login(page);
  const step = page.getByTestId("setup-row-timezone");
  await expect(step).toContainText("Time zone");
  await expect(step).toContainText("Not set");
  await step.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/company/);
  const zone = page.getByLabel("Company time zone");
  await expect(zone).toHaveValue("America/Los_Angeles");
  await zone.selectOption("Asia/Tokyo");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByLabel("Company time zone")).toHaveValue("Asia/Tokyo");

  await page.goto("/settings/notifications");
  const report = page.getByTestId("report-schedule");
  await expect(report).toBeVisible();
  await expect(report.getByLabel("Time zone")).toHaveCount(0);
  await expect(report.getByTestId("report-zone")).toHaveText("Asia/Tokyo");
  await expect(report.getByRole("link", { name: "Change" })).toHaveAttribute("href", "/settings/company#timezone");

  await page.goto("/home");
  await expect(page.getByTestId("setup-row-timezone")).toContainText("Asia/Tokyo");
});

// protects: the goal form's Horizon tip gives the company's horizons from Settings ›
// Company, so a person picks the horizon by what Now, Next and Later mean here.
// fails_when: the tip keeps B2's defaults after an owner widened Now and moved Later.
// no_claim: the API's horizon checks (pytest).
test("goal form: the Horizon tip reads the company's horizons", async ({ page }) => {
  await login(page);
  await page.goto("/settings/company");
  await page.getByLabel("Now").selectOption("2");
  await page.getByLabel("Next").selectOption("3");
  await page.getByLabel("From").fill("24");
  await page.getByLabel("To").fill("36");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();

  await page.goto("/baseline");
  await page.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation" }).click();
  const d = page.getByRole("dialog", { name: "Raise activation" });
  await d.getByRole("button", { name: "Edit" }).click();
  const tip = d.getByRole("form", { name: "Edit" }).getByRole("button", { name: "About horizons" });
  await tip.hover();
  await expect(d.getByRole("form", { name: "Edit" }).getByRole("tooltip")).toHaveText(
    "Short: this quarter and the next · Medium: the next three quarters · Long: 24–36 months",
  );
});
