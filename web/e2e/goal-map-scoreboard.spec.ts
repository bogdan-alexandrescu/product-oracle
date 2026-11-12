import { SCOREBOARD_SCENARIO } from "../lib/api/mock/goal-map";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The Goal map reached from Home (owner, Nov 5), driven through the UI against the mock
 * ("goal-map-scoreboard", invented data): each Home goal card opens the map on its goal, and a
 * goal with no number to aim at ("Cut early churn") lands on a line saying so.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const VIEWER = "viewer@example.com";
/** The mock's confirmed goal with no number to aim at (on Home, off the map). */
const OFF_MAP = "Cut early churn";

const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });

test.describe("Home", () => {
  test.use(DESKTOP);

  test("a Home goal card opens its goal on the Goal map", async ({ page }) => {
    // protects=each Home goal card links to the Goal map on that goal; fails_when=the card has no
    // way to the map; no_claim=Home's other parts (another lane ports them).
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple");
    const card = page.getByTestId("home-goal").first();
    const link = card.getByTestId("home-goal-map");
    await expect(link).toHaveText("Goal map");
    await link.click();
    await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
    await expect(page.getByTestId("gm-page")).toBeVisible();
  });

  test("Home's Goal map link scrolls to its goal", async ({ page }) => {
    // protects=Home's goals are the map's goals (one store, same ids): the link lands on the goal's
    // column, in view; fails_when=the map opens at the top with no goal picked.
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
    await login(page, VIEWER);
    await page.goto("/simple");
    await page.getByTestId("home-goal").filter({ hasText: "Revenue per day" }).getByTestId("home-goal-map").click();
    await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
    await expect(page.getByTestId("gm-grid")).toBeVisible();
    const rev = goal(page, "Revenue per day");
    await expect(rev).toHaveCount(1);
    await expect(rev).toBeInViewport();
    await expect(page.getByTestId("gm-off-map")).toHaveCount(0);
  });

  test("a Home goal with no number to aim at says it is not on the map yet", async ({ page }) => {
    // protects=a goal left off the map lands on a line naming it and why, with a way to it;
    // fails_when=the map opens at the top saying nothing.
    await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, SCOREBOARD_SCENARIO] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple");
    await page.getByTestId("home-goal").filter({ hasText: OFF_MAP }).getByTestId("home-goal-map").click();
    const off = page.getByTestId("gm-off-map");
    await expect(off).toContainText(`Not on the map yet: ${OFF_MAP} has no number to aim at`);
    await expect(off).toBeInViewport();
    await expect(off.getByRole("link", { name: "Open the goal" })).toHaveAttribute("href", /^\/simple\/priorities\?goal=/);
    await expect(goal(page, OFF_MAP)).toHaveCount(0);
  });
});
