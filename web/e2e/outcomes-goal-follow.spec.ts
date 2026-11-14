import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes (owner, Nov 13), Change goal: the inspector's Metric line follows the goal picked
 * at once; with no predicted value yet, the prediction form's Unit follows the new goal's unit,
 * while a written prediction keeps its own (owner's pick: Keep the prediction). Mock API,
 * "outcomes" scenario (synthetic: Fewer failed payments counts failed payments per 100 orders).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });

test("moving an outcome with no prediction yet: the Metric and the form's Unit follow the new goal", async ({ page }) => {
  // protects=after the Goal pick saves, the Metric line names the new goal's metric and the
  // form's Unit is the new goal's unit, without a reload; fails_when=the old goal's metric or
  // unit stays; no_claim=the baseline's figure.
  await start(page);
  await row(page, "Guided setup checklist").click();
  const form = inspector(page).getByTestId("prediction-form");
  await expect(form.getByLabel("Unit")).toHaveValue("%");
  await inspector(page).getByLabel("Goal").selectOption({ label: "Fewer failed payments" });
  await expect(row(page, "Guided setup checklist")).toContainText("Fewer failed payments");
  await expect(inspector(page).getByText("Failed payments per 100 orders")).toBeVisible();
  await expect(inspector(page).getByText("Accounts that finish setup within 7 days")).toHaveCount(0);
  await expect(inspector(page).getByTestId("prediction-form").getByLabel("Unit")).toHaveValue("failed payments");
});

test("moving an outcome with a written prediction: the Metric follows, the prediction keeps its unit", async ({ page }) => {
  // protects=the Metric line follows the new goal and the prediction stays "38% → 42%";
  // fails_when=the old metric stays or the prediction's unit is replaced; no_claim=the
  // track record's per-goal split (outcomes-goal.spec.ts).
  await start(page);
  await row(page, "Order status emails").click();
  await inspector(page).getByLabel("Goal").selectOption({ label: "Fewer failed payments" });
  await expect(row(page, "Order status emails")).toContainText("Fewer failed payments");
  await expect(inspector(page).getByText("Failed payments per 100 orders")).toBeVisible();
  await expect(inspector(page)).toContainText("Predicted 38% → 42%");
});
