import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * one-roadmap-many-prds (train review): the Goal map and Bring a date in read the ONE company
 * roadmap (Product roadmap), never the PRD's older roadmap kept as history. Driven through the UI
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

const boardCard = (page: Page, title: string) => page.getByTestId("board-card").filter({ hasText: title });

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("the Goal map shows only the company roadmap's milestones and a new one joins them", async ({ page }) => {
    // protects=the map reads the company roadmap's goal milestones alone and a proposed milestone shows
    // among them; fails_when=the older roadmap's milestones show or the proposal is not on the map;
    // no_claim=the API's roadmap pick (test_simple_goal_map_api).
    await open(page);
    await page.goto("/simple/home");
    await page.getByTestId("simple-nav-goals").first().click();
    const map = page.getByTestId("gm-page");
    await expect(map).toBeVisible();
    await expect(page.getByTestId("gm-ladder")).toContainText("25 sign-ups per rep");
    await expect(map).not.toContainText("15 sign-ups per rep");
    await expect(map).not.toContainText("$8k revenue per day");

    await page.getByTestId("gm-propose").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await ed.locator("label", { hasText: "Scale per rep" }).click();
    // A new milestone starts with nothing before it (gm1-a-open); its place is picked.
    await expect(ed.getByLabel("Comes after").locator("option:checked")).toHaveText("Nothing: it can start now");
    await ed.getByLabel("Comes after").selectOption({ label: "25 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Proposed: 40 sign-ups per rep.");
    await expect(page.locator('[data-testid="gm-gate"][data-proposed="1"]')).toContainText("40 sign-ups per rep");
    await expect(map).not.toContainText("15 sign-ups per rep");
  });

  test("Bring a date in re-plans the company roadmap, not the PRD's older one", async ({ page }) => {
    // protects=on the company roadmap the goal's date shows and an approved re-plan moves the PRD's
    // items there; fails_when=the answer names the older roadmap (nothing shows on the company
    // roadmap) or the board keeps the old dates; no_claim=the API's write (test_simple_fit_date_api).
    await open(page);
    await page.goto("/simple/roadmap?roadmap=product-roadmap");
    await expect(page.getByTestId("fit-goal")).toBeVisible();
    await page.getByTestId("format-board").click();
    await expect(boardCard(page, "Thread summary card")).toContainText("Jan 31");
    // The older roadmap's own item is history, never on Simple.
    await expect(boardCard(page, "Saved reply folders")).toHaveCount(0);

    await page.getByRole("button", { name: "Bring this date in" }).click();
    const panel = page.getByTestId("fit-panel");
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "Draft 5 changes" }).click();
    await expect(panel).toContainText("Check the new drafts");
    await page.getByRole("button", { name: "Approve both", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("fit-approved")).toContainText("roadmap version 7 are live: M2 lands Jan 24.");

    await page.goto("/simple/roadmap?roadmap=product-roadmap");
    await page.getByTestId("format-board").click();
    const summary = boardCard(page, "Thread summary card");
    await expect(summary).toContainText("Jan 15");
    await expect(summary).toContainText("Estimate pending");
    await expect(boardCard(page, "Reply to similar threads at once")).toContainText("Feb 17");
    await expect(boardCard(page, "Saved reply folders")).toHaveCount(0);
  });
});
