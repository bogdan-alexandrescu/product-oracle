import { expect, test, type Page } from "./test";

import { login } from "./helpers";

async function rankedKeys(page: Page) {
  const rows = page.locator('tr[data-testid^="priority-row-"]');
  await expect(rows.first()).toBeVisible();
  return (await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("priority-row-", ""))));
}

test("priorities: method switch changes the ranking and the formula", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await expect(page.getByRole("heading", { level: 1, name: "Priorities" })).toBeVisible();

  const methods = page.getByRole("radiogroup", { name: "Ranking method" });
  await expect(methods.getByRole("radio", { name: "Goal-weighted" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("formula")).toContainText("goal weight × contribution");
  // F-2 is the best score but needs F-5 first, so F-5 is moved up.
  expect(await rankedKeys(page)).toEqual(["F-5", "F-2", "F-1", "F-7", "F-8", "F-4", "F-3", "F-6"]);
  await expect(page.getByTestId("priority-row-F-2").getByTestId("score")).toHaveText("8.10");

  await methods.getByRole("radio", { name: "WSJF" }).click();
  await expect(page.getByTestId("formula")).toContainText("business value + time criticality + risk reduction");
  await expect(page.getByTestId("priority-row-F-2").getByTestId("score")).toHaveText("7.50");
  expect(await rankedKeys(page)).toEqual(["F-5", "F-2", "F-4", "F-1", "F-7", "F-8", "F-3", "F-6"]);

  await methods.getByRole("radio", { name: "RICE" }).click();
  await expect(page.getByTestId("formula")).toContainText("reach × impact × confidence");
  await expect(page.getByTestId("priority-row-F-2").getByTestId("score")).toHaveText("5,400.00");
  // F-4 has no reach: unscored and flagged.
  await expect(page.getByTestId("priority-row-F-4")).toContainText("Not scored: no Reach");
  await expect(page.getByTestId("priority-row-F-4").getByTestId("score")).toHaveText("—");
});

test("priorities: flags, cycles and the explanation of a row", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");

  await expect(page.getByTestId("cycles-banner")).toContainText("Bulk export → Scheduled exports");
  await expect(page.getByTestId("cycles-banner")).not.toContainText("F-7");
  const noGoal = page.getByTestId("priority-row-F-6");
  await expect(noGoal).toContainText("Serves no confirmed goal");
  await expect(page.getByTestId("priority-row-F-7")).toContainText("Dependency cycle");
  await expect(page.getByTestId("priority-row-F-5")).toContainText("Ranked higher: Shipping cost shown in the cart depends on it");
  await expect(page.getByTestId("priority-row-F-4")).toContainText("Low confidence");

  // Select: the inspector shows steps, inputs, confidence and goals.
  const toggle = page.getByTestId("priority-row-F-1").getByRole("button", { name: /Saved addresses at checkout/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const ex = page.getByTestId("explanation-F-1");
  await expect(ex.getByRole("list", { name: "Steps" })).toContainText("Goal value = 3×2 (Raise activation) = 6");
  await expect(ex.getByRole("list", { name: "Steps" })).toContainText("Score = 6 × 75% ÷ 2 = 2.25");
  await expect(ex).toContainText("from evidence");
  await expect(ex).toContainText("Interview 07");
  await expect(ex.getByRole("cell", { name: "Effort (from the feature)" })).toBeVisible();

  // Assumed goal weight, and an order note.
  await page.getByTestId("priority-row-F-3").getByRole("button", { name: "Shared projects" }).click();
  await expect(page.getByTestId("explanation-F-3")).toContainText("assumed");
  await page.getByTestId("priority-row-F-5").getByRole("button", { name: "Address lookup service" }).click();
  await expect(page.getByTestId("explanation-F-5").locator("li", { hasText: "Moved for" })).toContainText(
    "Shipping cost shown in the cart",
  );
  await expect(page.getByTestId("explanation-F-5").locator("li", { hasText: "Moved for" })).not.toContainText("F-2");
  await expect(page.getByTestId("explanation-F-5")).not.toContainText("depend(s)");

  // The inspector shows one feature at a time: F-1's explanation has gone.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("explanation-F-1")).toHaveCount(0);
});

test("priorities: save a snapshot", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await expect(page.getByText("No snapshots yet.")).toBeVisible();

  await page.getByRole("radio", { name: "MoSCoW" }).click();
  await expect(page.getByTestId("formula")).toContainText("Must have (4)");
  await page.getByLabel("Snapshot note").fill("Before planning");
  await page.getByRole("button", { name: "Save snapshot" }).click();
  await expect(page.getByRole("status")).toContainText("Snapshot saved: MoSCoW ranking of 8 features");
  const list = page.getByTestId("snapshot-list");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("MoSCoW");
  await expect(list).toContainText("Before planning");
});
