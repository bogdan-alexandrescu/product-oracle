import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes edits (owner, Nov 13), Confidence and why: the prediction form takes a Confidence
 * (Low, Medium, High) and a one-line Why; the inspector shows both and Edit opens with them.
 * Mock API, "outcomes" scenario (synthetic: Guided setup checklist needs a prediction).
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

test("an approver saves a prediction with its confidence and why", async ({ page }) => {
  // protects=Confidence and Why save with the prediction, show in the inspector and come back
  // into the form on Edit; fails_when=either field is missing, dropped or not shown;
  // no_claim=the track record's arithmetic (tests/test_outcome_confidence.py).
  await start(page);
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^Needs prediction/ }).click();
  await row(page, "Guided setup checklist").click();
  const form = inspector(page).getByTestId("prediction-form");
  await form.getByLabel("Baseline").fill("38");
  await form.getByLabel("Predicted").fill("42");
  await form.getByLabel("Unit").fill("%");
  await form.getByLabel("Confidence").selectOption({ label: "High" });
  await form.getByLabel("Why").fill("Most new teams stop at the setup step");
  await form.getByRole("button", { name: "Save prediction" }).click();
  await expect(inspector(page).getByTestId("outcome-state").first()).toHaveText("Predicted");
  await expect(inspector(page).getByTestId("outcome-confidence")).toHaveText("High");
  await expect(inspector(page).getByTestId("outcome-why")).toHaveText("Most new teams stop at the setup step");

  await inspector(page).getByTestId("outcome-edit").click();
  const again = inspector(page).getByTestId("prediction-form");
  await expect(again.getByLabel("Confidence")).toHaveValue("high");
  await expect(again.getByLabel("Why")).toHaveValue("Most new teams stop at the setup step");
});
