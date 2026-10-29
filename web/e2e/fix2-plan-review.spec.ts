import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The fix2-plan review's minors, through the UI on the mock layer as a person would. Each
 * test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what green
 * does not prove>.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);

/** Cancel sits wholly left of the primary action, as in every dialog (qa-plan-34). */
async function cancelFirst(where: Locator, primary: string) {
  const cancel = await where.getByRole("button", { name: "Cancel" }).boundingBox();
  const action = await where.getByRole("button", { name: primary }).boundingBox();
  expect(cancel, "Cancel is shown").not.toBeNull();
  expect(action, `${primary} is shown`).not.toBeNull();
  // Same row: Cancel ends before the action starts. Wrapped: Cancel's row comes first.
  if (Math.abs(cancel!.y - action!.y) < 4) expect(cancel!.x + cancel!.width).toBeLessThanOrEqual(action!.x);
  else expect(cancel!.y).toBeLessThan(action!.y);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  // protects=qa-plan-20: an approver's empty change log says how to make a change on either
  // filter; fails_when=All shows bare "No changes yet."; no_claim=the log's rows.
  test("the empty Changes log says how on All as on Active", async ({ page }) => {
    await login(page, "approver@example.com");
    await page.goto("/priorities");
    const empty = page.getByTestId("changes-empty");
    await expect(empty).toContainText("move or pin a feature");
    await page.getByRole("radiogroup", { name: "Changes filter" }).getByRole("radio", { name: "All" }).click();
    await expect(empty).toHaveText("No changes yet. Use ▲ ▼ or More actions on a row to move or pin a feature, with a reason.");
  });

  // protects=qa-plan-8 on the Flagged tab: a feature with no evidence shows no score there, as in
  // its drawer; fails_when=its ring reads "Not scored yet" or a percentage beside Evidence 0;
  // no_claim=the API's scoring (pytest).
  test("a flagged feature with no evidence shows no confidence score", async ({ page }) => {
    await login(page);
    await page.goto("/baseline");
    await page.getByRole("tab", { name: /Flagged/ }).click();
    const usage = page.getByTestId("flagged-f.usage-export");
    await expect(usage.getByTestId("flag")).toHaveText(["No evidence"]);
    await expect(usage.getByRole("img", { name: "Not scored: no evidence yet" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  const planInspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });

  async function openPlanItem(page: Page, key: string) {
    await login(page);
    await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await page.locator(`[data-testid="plan-row"][data-item="${key}"]`).filter({ visible: true }).getByTestId("plan-title").click();
    await expect(page.getByTestId("sheet-plan-item")).toBeVisible();
  }

  // protects=qa-plan-34 in the Plan item's bottom sheet: Keep watching puts Cancel first;
  // fails_when=Keep watching sits left of Cancel; no_claim=the alert rules (API).
  test("the Plan item sheet's Keep watching form puts Cancel first", async ({ page }) => {
    await scenario(page, "track-alerts");
    await openPlanItem(page, "alert-digest");
    const card = planInspector(page).getByTestId("plan-alert");
    await card.getByRole("button", { name: "Keep watching" }).click();
    await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
    await cancelFirst(card, "Keep watching");
  });

  // protects=qa-plan-34 in the Plan item's bottom sheet: Waive puts Cancel first; fails_when=Waive
  // finding sits left of Cancel; no_claim=who may waive (strategy-drift-items.spec.ts).
  test("the Plan item sheet's Waive form puts Cancel first", async ({ page }) => {
    await scenario(page, "strategy-plan");
    await openPlanItem(page, "slack-alerts");
    await planInspector(page).getByTestId("plan-drift-card").getByRole("button", { name: "Waive…" }).click();
    await cancelFirst(planInspector(page).getByRole("group", { name: "Waive finding" }), "Waive finding");
  });

  // protects=qa-plan-34 in the outcome's bottom sheet: the assessment form puts Cancel first;
  // fails_when=Record assessment sits left of Cancel; no_claim=the verdict rule (API).
  test("the outcome sheet's assessment form puts Cancel first", async ({ page }) => {
    await scenario(page, "outcomes");
    await login(page);
    await page.goto("/plan/outcomes");
    await page.getByTestId("outcome-row").filter({ hasText: "Saved payment methods" }).filter({ visible: true }).click();
    const sheet = page.getByTestId("outcome-sheet");
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("outcome-assess-edit").click();
    await cancelFirst(sheet.getByTestId("assessment-form"), "Record assessment");
  });
});
