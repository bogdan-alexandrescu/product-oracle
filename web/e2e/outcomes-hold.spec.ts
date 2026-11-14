import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes edits (owner, Nov 13), Hold bets: the prediction form's Direction has "Hold at
 * most" beside Up and Down; a bet to stay at or under a level saves with its baseline equal to
 * the prediction and reads "at most" in the table and the inspector. Mock API, "outcomes"
 * scenario (synthetic: Guided setup checklist needs a prediction).
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

test("an approver saves a Hold at most bet equal to its baseline", async ({ page }) => {
  // protects=Hold at most saves 0 → at most 0 with a partly-held mark of 2, and the row and
  // the inspector read "at most"; fails_when=there is no Hold choice, the bet is refused as a
  // Down bet equal to its baseline, or it reads as a rise; no_claim=the check's verdict rule
  // (tests/test_outcome_hold.py).
  await start(page);
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^Needs prediction/ }).click();
  await row(page, "Guided setup checklist").click();
  const form = inspector(page).getByTestId("prediction-form");
  await form.getByLabel("Direction").selectOption({ label: "Hold at most" });
  await form.getByLabel("Baseline").fill("0");
  await form.getByLabel("Predicted").fill("0");
  await form.getByLabel("Partly held at").fill("2");
  await form.getByLabel("Unit").fill("restrictions");
  await form.getByRole("button", { name: "Save prediction" }).click();
  await expect(inspector(page).getByTestId("outcome-state").first()).toHaveText("Predicted");
  await expect(inspector(page)).toContainText("Predicted 0 restrictions → at most 0 restrictions");
  await expect(inspector(page)).toContainText("2 restrictions");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
  await expect(row(page, "Guided setup checklist").getByTestId("outcome-predicted")).toContainText(
    "0 restrictions → at most 0 restrictions",
  );
});
