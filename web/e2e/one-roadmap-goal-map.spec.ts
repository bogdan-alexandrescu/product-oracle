import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * one-roadmap-many-prds (train review): the Goal map reads the ONE company roadmap (Product
 * roadmap), never the PRD's older roadmap kept as history. Driven through the UI
 * against the mock's "fit-date-company-roadmap" scenario: the company roadmap next to the older
 * Help desk roadmap, which still holds goal milestones and an item of its own (invented data:
 * Larkspur Help Desk's Reply faster in the shared inbox).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "fit-date-company-roadmap"] as const);
  await login(page, ADMIN.email);
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("the Goal map shows only the company roadmap's milestones", async ({ page }) => {
    // protects=the map reads the company roadmap's goal milestones alone, in the milestone strip;
    // fails_when=the older roadmap's milestones show; no_claim=the API's roadmap pick
    // (test_simple_goal_map_api).
    await open(page);
    await page.goto("/simple/home");
    await page.getByTestId("simple-nav-goals").first().click();
    const map = page.getByTestId("gm-page");
    await expect(map).toBeVisible();
    await expect(page.getByTestId("gm-strip-milestone").filter({ hasText: "25 sign-ups per rep" })).toHaveCount(1);
    await expect(map).not.toContainText("15 sign-ups per rep");
    await expect(map).not.toContainText("$8k revenue per day");
  });
});
