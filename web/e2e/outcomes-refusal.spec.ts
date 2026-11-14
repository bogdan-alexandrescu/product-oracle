import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes edits (owner, Nov 13), Real refusal reasons: when saving a prediction is refused
 * (422, the API's validation error), the form shows the API's own sentence, never "Something
 * went wrong". Mock API, "outcomes" scenario (synthetic: Guided setup checklist needs a
 * prediction); the mock answers the refusal in the API's shape.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
  await page.goto("/plan/outcomes");
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });

test("a refused prediction shows the API's reason", async ({ page }) => {
  // protects=a Down bet above its baseline is refused and the inspector says why in the API's
  // words; fails_when="Something went wrong. Try again." or nothing is shown;
  // no_claim=the API's rule (tests/test_outcome_refusal.py).
  await start(page);
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^Needs prediction/ }).click();
  await row(page, "Guided setup checklist").click();
  const form = inspector(page).getByTestId("prediction-form");
  await form.getByLabel("Direction").selectOption({ label: "Down" });
  await form.getByLabel("Baseline").fill("38");
  await form.getByLabel("Predicted").fill("42");
  await form.getByRole("button", { name: "Save prediction" }).click();
  await expect(inspector(page)).toContainText("A decrease prediction must be below its baseline.");
  await expect(inspector(page).getByText("Something went wrong")).toHaveCount(0);
  await expect(inspector(page).getByTestId("outcome-state").first()).toHaveText("Needs prediction");
});
