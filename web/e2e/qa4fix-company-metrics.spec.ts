import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Fourth QA pass on Company › Metrics, driven through the UI as a person would. The default
 * mock scenario has no metrics; Raise activation is a confirmed goal in % (target 45%, current
 * 38% measured Oct 1, so Home reads "7 pts to go"). The mock clock is Thu 2026-10-22, so the
 * last complete week, the one Record a value offers first, is the week of Oct 12. Each test
 * names the finding it protects.
 */

const metricRow = (page: Page, title: string) => page.getByTestId("metric-row").filter({ hasText: title });

async function openAddMetric(page: Page) {
  await page.goto("/company/metrics");
  await page.getByTestId("metrics-empty").filter({ visible: true }).getByRole("button", { name: "Add your first metric" }).click();
  const dialog = page.getByRole("dialog", { name: "Add metric" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Adds an output typed by hand, in %, owned by the first person offered; linked to `goal` when given. */
async function addMetric(page: Page, title: string, goal?: string) {
  const dialog = await openAddMetric(page);
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("What it counts").fill("New accounts that finish setup within 7 days");
  await dialog.getByLabel("Unit", { exact: true }).selectOption("%");
  if (goal) await dialog.getByLabel("Goal").selectOption({ label: goal });
  await dialog.getByLabel("Owner").selectOption({ index: 1 });
  await dialog.getByLabel("Source").selectOption("manual");
  await dialog.getByRole("button", { name: "Add metric" }).click();
  await expect(dialog).toBeHidden();
  await expect(metricRow(page, title)).toBeVisible();
}

async function recordValue(scope: Locator, value: string) {
  const field = scope.getByRole("textbox", { name: "Value" });
  await field.fill(value);
  await scope.getByRole("button", { name: "Record" }).click();
  await expect(field).toHaveValue("");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa4-company-3: the Metrics table shows a metric's whole name at 1440 wide", async ({ page }) => {
    await login(page);
    await addMetric(page, "Activation rate");
    const name = metricRow(page, "Activation rate").getByRole("gridcell").first();
    await expect(name).toHaveText("Activation rate");
    const [shown, needed] = await name.evaluate((el) => [el.clientWidth, el.scrollWidth]);
    expect(shown).toBeGreaterThanOrEqual(200);
    expect(needed).toBeLessThanOrEqual(shown);
  });

  test("qa4-company-4: a recorded weekly value becomes the linked goal's current value, in the inspector and on Home", async ({ page }) => {
    await login(page);
    await expect(page.getByTestId("home-goal-G1").getByTestId("goal-to-go")).toHaveText("7 pts to go");
    const dialog = await openAddMetric(page);
    await dialog.getByLabel("Unit", { exact: true }).selectOption("%");
    await expect(dialog.getByTestId("metric-goal-help")).toHaveText("Confirmed goals measured in the same unit. The latest weekly value becomes the goal’s current value.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await addMetric(page, "Activation rate", "Raise activation");
    const inspector = page.getByTestId("metric-inspector").filter({ visible: true });
    await expect(inspector).toContainText("Activation rate");
    await expect(inspector.getByRole("link", { name: "Raise activation" })).toBeVisible();
    await expect(inspector).toContainText("7 pts to go");
    await expect(inspector.getByRole("combobox", { name: "Week" })).toHaveValue("2026-10-12");
    await recordValue(inspector, "41");
    await expect(metricRow(page, "Activation rate").locator('[data-col="last"]')).toHaveText("41%");
    await expect(inspector).toContainText("4 pts to go");
    await expect(inspector).not.toContainText("7 pts to go");

    await page.goto("/home");
    await expect(page.getByTestId("home-goal-G1").getByTestId("goal-to-go")).toHaveText("4 pts to go");
  });

  test("qa4-company-38: Add metric says once that a unit comes first", async ({ page }) => {
    await login(page);
    const dialog = await openAddMetric(page);
    const goal = dialog.getByLabel("Goal");
    await expect(goal.locator("option")).toHaveText(["No goal"]);
    await expect(dialog.getByTestId("metric-goal-help")).toHaveText("Pick a unit to see goals measured in it.");
    await expect(goal).not.toContainText("Pick a unit");
  });

  test("qa4-company-39: Add metric's Unit is a select like Kind and Good direction, with Count of… for a counted noun", async ({ page }) => {
    await login(page);
    const dialog = await openAddMetric(page);
    const unit = dialog.getByRole("combobox", { name: "Unit", exact: true });
    for (const select of [unit, dialog.getByLabel("Kind"), dialog.getByLabel("Good direction")]) {
      await expect(select).toHaveJSProperty("tagName", "SELECT");
    }
    await expect(dialog.getByLabel("Counted noun")).toHaveCount(0);
    await unit.selectOption({ label: "Count of…" });
    await dialog.getByLabel("Counted noun").fill("teams");
    await expect(dialog.getByTestId("metric-goal-help")).toHaveText("No confirmed goal is measured in teams yet.");
    await unit.selectOption("%");
    await expect(dialog.getByLabel("Counted noun")).toHaveCount(0);
    await expect(dialog.getByTestId("metric-goal-help")).toContainText("Confirmed goals measured in the same unit.");
  });

  test("qa4-company-40: the inspector names the default threshold", async ({ page }) => {
    await login(page);
    await addMetric(page, "Activation rate");
    const inspector = page.getByTestId("metric-inspector").filter({ visible: true });
    await expect(inspector).toContainText("Activation rate");
    await expect(inspector).toContainText("Default (10%)");
  });

  test("qa4-company-41: with one weekly value the inspector shows it in words, not a lone dot", async ({ page }) => {
    await login(page);
    await addMetric(page, "Activation rate");
    const inspector = page.getByTestId("metric-inspector").filter({ visible: true });
    await expect(inspector).toContainText("No weekly values yet");
    await recordValue(inspector, "41");
    const one = inspector.getByTestId("metric-chart-one");
    await expect(one).toContainText("Week of Oct 12: 41%");
    await expect(one).toContainText("The chart starts once there are two weeks.");
    await expect(inspector.getByTestId("metric-chart")).toHaveCount(0);
    await expect(inspector).not.toContainText("to week of Oct 12");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa4-company-42: on a phone a metric with one value says No change yet, not a bare dash", async ({ page }) => {
    await login(page);
    await addMetric(page, "Activation rate");
    await metricRow(page, "Activation rate").click();
    const inspector = page.getByTestId("metric-sheet").getByTestId("metric-inspector");
    await expect(inspector).toBeVisible();
    await recordValue(inspector, "41");
    await page.goto("/company/metrics");
    const row = metricRow(page, "Activation rate");
    await expect(row.locator('[data-col="last"]')).toHaveText("41%");
    const change = row.locator('[data-col="change"]');
    await expect(change).toHaveText("No change yet", { useInnerText: true });
    await expect(row).not.toContainText(/41%\s*—/, { useInnerText: true });
  });
});
