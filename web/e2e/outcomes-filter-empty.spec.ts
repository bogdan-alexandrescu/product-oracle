import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes (owner, Nov 13): a state filter left with no rows says so in one short line naming
 * the filter, with a way back to All; the long "No outcomes here…" sentence is for a truly
 * empty table only. Mock API, "outcomes" scenario (synthetic: Guided setup checklist is the one
 * outcome that needs a prediction).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
  await page.goto("/plan/outcomes");
}

const filters = (page: Page) => page.getByTestId("outcome-filters");
const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });

test("a filter emptied by a saved prediction names itself and leads back to All", async ({ page }) => {
  // protects=after the last "Needs prediction" outcome gets its prediction, the table says
  // "No outcomes in Needs prediction" and All brings every row back; fails_when=the whole-table
  // sentence shows, or there is no way back; no_claim=the empty page with no outcome at all.
  await start(page);
  await filters(page).getByRole("button", { name: /^Needs prediction/ }).click();
  await page.getByTestId("outcome-row").filter({ hasText: "Guided setup checklist" }).click();
  const form = inspector(page).getByTestId("prediction-form");
  await form.getByLabel("Predicted").fill("45");
  await form.getByRole("button", { name: "Save prediction" }).click();
  await expect(filters(page).getByRole("button", { name: /^Needs prediction/ })).toContainText("0");

  const empty = page.getByTestId("table-empty");
  await expect(empty).toContainText("No outcomes in Needs prediction");
  await expect(page.getByText("Approving a roadmap records a prediction")).toHaveCount(0);
  await empty.getByRole("button", { name: "Show all" }).click();
  await expect(filters(page).getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("outcome-row").filter({ hasText: "Guided setup checklist" })).toHaveCount(1);
});
