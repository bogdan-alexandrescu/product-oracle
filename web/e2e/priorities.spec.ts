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
  // F-02 is the best score but needs F-07 first, so F-07 is moved up.
  expect(await rankedKeys(page)).toEqual(["F-07", "F-02", "F-01", "F-12", "F-13", "F-08", "F-05", "F-06"]);
  await expect(page.getByTestId("priority-row-F-02").getByTestId("score")).toHaveText("8.10");

  await methods.getByRole("radio", { name: "WSJF" }).click();
  await expect(page.getByTestId("formula")).toContainText("business value + time criticality + risk reduction");
  await expect(page.getByTestId("priority-row-F-02").getByTestId("score")).toHaveText("7.50");
  expect(await rankedKeys(page)).toEqual(["F-07", "F-02", "F-08", "F-01", "F-12", "F-13", "F-05", "F-06"]);

  await methods.getByRole("radio", { name: "RICE" }).click();
  await expect(page.getByTestId("formula")).toContainText("reach × impact × confidence");
  await expect(page.getByTestId("priority-row-F-02").getByTestId("score")).toHaveText("5,400");
  // F-08 has no reach: unscored and flagged.
  await expect(page.getByTestId("priority-row-F-08")).toContainText("Not scored: no Reach");
  await expect(page.getByTestId("priority-row-F-08").getByTestId("score")).toHaveText("—");
});

test("priorities: flags, cycles and the explanation of a row", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");

  await expect(page.getByTestId("cycles-banner")).toContainText("F-12 Referral link → F-13 Public signup");
  const noGoal = page.getByTestId("priority-row-F-06");
  await expect(noGoal).toContainText("Serves no confirmed goal");
  await expect(page.getByTestId("priority-row-F-12")).toContainText("Dependency cycle");
  await expect(page.getByTestId("priority-row-F-07")).toContainText("Ranked higher: F-02 Sample data import depends on it");
  await expect(page.getByTestId("priority-row-F-08")).toContainText("Low confidence");

  // Select: the inspector shows steps, inputs, confidence and goals.
  const toggle = page.getByTestId("priority-row-F-01").getByRole("button", { name: /Setup checklist/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const ex = page.getByTestId("explanation-F-01");
  await expect(ex.getByRole("list", { name: "Steps" })).toContainText("Goal value = 3×2 (Raise activation) = 6");
  await expect(ex.getByRole("list", { name: "Steps" })).toContainText("Score = 6 × 75% ÷ 2 = 2.25");
  await expect(ex).toContainText("from evidence");
  await expect(ex).toContainText("Interview 07");
  await expect(ex.getByRole("row", { name: /^Effort\b/ }).getByRole("cell", { name: "The feature", exact: true })).toBeVisible();

  // Assumed goal weight, and an order note.
  await page.getByTestId("priority-row-F-05").getByRole("button", { name: "Team invites" }).click();
  await expect(page.getByTestId("explanation-F-05")).toContainText("assumed");
  await page.getByTestId("priority-row-F-07").getByRole("button", { name: "Bulk import" }).click();
  await expect(page.getByTestId("explanation-F-07").locator("li", { hasText: "Moved for" })).toContainText(
    "Sample data import",
  );
  await expect(page.getByTestId("explanation-F-07")).not.toContainText("depend(s)");

  // The inspector shows one feature at a time: F-01's explanation has gone.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("explanation-F-01")).toHaveCount(0);
});

test("priorities: save a snapshot", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await expect(page.getByText("No snapshots yet.")).toBeVisible();

  await page.getByRole("radio", { name: "MoSCoW" }).click();
  await expect(page.getByTestId("formula")).toContainText("Must have (4)");
  await page.getByLabel("Snapshot note").fill("Before planning");
  await page.getByRole("button", { name: "Save snapshot" }).click();
  await expect(page.getByRole("status")).toHaveText("Snapshot saved.");
  const list = page.getByTestId("snapshot-list");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("MoSCoW");
  await expect(list).toContainText("Before planning");
});
