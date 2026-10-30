import { expect, test } from "@playwright/test";

import { confirmedEntity, login, openCompanyTab } from "./ui";

// H5 Metrics review (PR #541) against the real API: no PostHog connection, so the metric is
// typed by hand, and the form still saves with its goal.
test("metrics: an owner adds a metric linked to a goal and sees its row", async ({ page }) => {
  test.setTimeout(30_000);
  await login(page);
  const goal = await confirmedEntity(page, {
    type: "goal",
    key: "e2e-raise-activation",
    title: "Raise activation",
    attrs: { metric: "Activated teams", unit: "%", comparison: "at_least", target: 45 },
  });

  await openCompanyTab(page, "metrics");
  // qa-company-20: with no metric yet the header's Add metric gives way to the empty list's own button.
  await page.getByRole("button", { name: /^Add (metric|your first metric)$/ }).click();
  const sheet = page.getByRole("dialog", { name: "Add metric" });
  await sheet.getByLabel("Title").fill("Setup completion rate");
  await sheet.getByLabel("What it counts").fill("Accounts that finish setup within 7 days of signing up");
  await sheet.getByLabel("Kind").selectOption("output");
  await sheet.getByLabel("Unit", { exact: true }).fill("%");
  await sheet.getByLabel("Goal").selectOption({ label: goal.title });
  await sheet.getByLabel("Owner").selectOption({ index: 1 });
  await sheet.getByLabel("Source").selectOption("manual");
  await sheet.getByRole("button", { name: "Add metric" }).click();
  await expect(sheet).toBeHidden();

  const row = page.getByTestId("metric-row").filter({ hasText: "Setup completion rate" });
  await expect(row).toContainText("Output");
  await expect(row).toContainText("By hand");
  await row.click();
  await expect(page.getByRole("link", { name: goal.title })).toBeVisible();
});
