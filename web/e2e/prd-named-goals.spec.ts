import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// PRD source words: Oracle's own PRD checks name each goal by its name with its code beside
// it ("Raise activation (g.activation)"), never by the bare code. The mock's quality rules
// read as the API's (oracle.quality.criteria.goal_alignment).

async function openQuality(page: Page, path: string) {
  await page.addInitScript(([k]) => localStorage.setItem(k, "owner"), [MOCK_ROLE_KEY] as const);
  await login(page);
  await page.goto(path);
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
}

const rulesSaid = (page: Page) =>
  page.getByTestId("quality-inspector").getByTestId("evaluator").filter({ hasText: "Rules" }).first();

test("a PRD's goal check names the goal it serves by its name, with the code beside it", async ({ page }) => {
  await openQuality(page, "/documents/team-workspaces/v/2/quality");
  await page.locator('[data-testid="criterion-row"][data-key="goal_alignment"]').click();
  await expect(rulesSaid(page)).toContainText("serves a confirmed goal: Raise activation (g.activation)");
});

test("a PRD whose goals are proposed says so as the API does, never by a bare code", async ({ page }) => {
  await openQuality(page, "/documents/online-deposits/v/3/quality");
  await page.locator('[data-testid="criterion-row"][data-key="goal_alignment"]').click();
  await expect(rulesSaid(page)).toContainText("The PRD's goals are proposed, not confirmed.");
  await expect(rulesSaid(page)).not.toContainText("cites G4");
});
