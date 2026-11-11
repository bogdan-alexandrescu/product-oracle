import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * B-26 (visual QA pass B): protects = the Detailed Plan's roadmap has a Table | Timeline toggle
 * in its Show bar; the Timeline draws the items the table lists (the Show bar's scope, the Group
 * by's groups) against their dates, with Today's line, a milestone and a dependency, and a bar
 * opens the item in the Plan's inspector; the choice is remembered; an item with no dates is
 * listed under the chart and opens the same way; the table shows "Review the PRD" once per PRD
 * in a group, not on every row. fails_when = there is no toggle, the Timeline draws other items
 * or opens nothing, the choice is lost on reload, or each row repeats the PRD's review.
 * Invented data: the mock's Usage alerts roadmap ("plan-timeline" dates its items in Simple).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const inScenario = (page: Page, s: string) => page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);
const roadmap = (page: Page) => page.getByTestId("plan-table").or(page.getByTestId("plan-timeline"));

async function openPlan(page: Page) {
  await login(page);
  await page.goto("/plan");
  await expect(roadmap(page)).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("the PRD's review shows once in its group, not on every row", async ({ page }) => {
    await openPlan(page);
    const table = page.getByTestId("plan-table");
    await expect(table.getByTestId("plan-row")).toHaveCount(7);
    const review = table.getByRole("link", { name: "Review the PRD" });
    // Group by PRD: one PRD, one group, one button, on its first row.
    await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "PRD", exact: true }).click();
    await expect(review).toHaveCount(1);
    await expect(table.getByTestId("plan-row").first().getByRole("link", { name: "Review the PRD" })).toBeVisible();
    // By horizon: once in each of Now, Next and Later.
    await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Horizon", exact: true }).click();
    await expect(table.getByTestId("plan-group")).toHaveCount(3);
    await expect(review).toHaveCount(3);
  });

  test("the Timeline draws the table's items against their dates and opens one in the inspector", async ({ page }) => {
    await inScenario(page, "plan-timeline");
    await openPlan(page);
    const titles = await page.getByTestId("plan-table").getByTestId("plan-title").allTextContents();
    expect(titles).toHaveLength(7);
    const bar = page.getByTestId("plan-scope-bar");
    await bar.getByRole("group", { name: "Roadmap view" }).getByRole("button", { name: "Timeline", exact: true }).click();
    const timeline = page.getByTestId("plan-timeline");
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId("plan-table")).toHaveCount(0);
    // The same items: six drawn, the seventh (no dates on the roadmap) listed below the chart.
    const drawn = timeline.getByTestId("label-title");
    await expect(drawn).toHaveCount(6);
    const undated = timeline.getByTestId("plan-timeline-undated-item");
    await expect(undated).toHaveText(["Budgets per team"]);
    expect([...(await drawn.allTextContents()), ...(await undated.allTextContents())].sort()).toEqual([...titles].sort());
    // In the Group by's groups, with Today's line, a milestone and a dependency.
    // B-26: the label column's heading names the Group by ("Horizon", not the lane's "Track").
    const heading = timeline.getByTestId("chart-labels").locator("> div").first();
    await expect(heading).toHaveText("Horizon");
    await expect(timeline.getByTestId("chart-labels")).toContainText("Now");
    await expect(timeline.getByTestId("lane-count")).toHaveText(["5 items", "1 item"]);
    await expect(timeline.getByTestId("today-pill")).toBeVisible();
    await expect(timeline.locator('[data-testid="bar"][data-item="threshold-alerts"] [data-testid="item-milestone"]')).toHaveCount(1);
    await expect(timeline.locator('[data-testid="dep-arrow"][data-from="threshold-alerts"][data-to="slack-alerts"]')).toHaveCount(1);
    await expect(timeline.locator('[data-testid="bar"][data-item="slack-alerts"]')).toHaveAttribute("data-start", /^\d{4}-\d{2}-\d{2}$/);

    // A bar opens the item in the Plan's inspector.
    const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
    await timeline.getByTestId("chart-label").filter({ hasText: "Alerts in the team chat" }).click();
    await expect(inspector).toContainText("Alerts in the team chat");
    await expect(timeline.getByTestId("chart-label").filter({ hasText: "Alerts in the team chat" })).toHaveAttribute("data-open", "true");
    await timeline.locator('[data-testid="bar"][data-item="usage-dashboard"]').click();
    await expect(inspector).toContainText("Usage dashboard");
    // So does an item not on the timeline.
    await undated.click();
    await expect(inspector).toContainText("Budgets per team");

    // The Group by regroups the Timeline as it does the table.
    await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Goal", exact: true }).click();
    await expect(heading).toHaveText("Goal");
    await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "PRD", exact: true }).click();
    await expect(heading).toHaveText("PRD");
    await expect(timeline.getByTestId("chart-labels")).toContainText("PRD");
    await expect(timeline.getByTestId("lane-count")).toHaveText(["6 items"]);

    // The choice is remembered.
    await page.reload();
    await expect(page.getByTestId("plan-timeline")).toBeVisible();
    await expect(bar.getByRole("group", { name: "Roadmap view" }).getByRole("button", { name: "Timeline", exact: true })).toHaveAttribute("aria-pressed", "true");
    // The Show bar's scope filters it: Approved only holds none of these draft items.
    await bar.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved only", exact: true }).click();
    await expect(page.getByTestId("plan-timeline")).toHaveCount(0);
    await expect(page.getByText("No roadmap items yet")).toBeVisible();
    // And back to the table.
    await bar.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved + drafts", exact: true }).click();
    await bar.getByRole("group", { name: "Roadmap view" }).getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByTestId("plan-table").getByTestId("plan-row")).toHaveCount(7);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the Timeline on a phone opens an item in the sheet", async ({ page }) => {
    await inScenario(page, "plan-timeline");
    await openPlan(page);
    await page.getByRole("group", { name: "Roadmap view" }).getByRole("button", { name: "Timeline", exact: true }).click();
    const timeline = page.getByTestId("plan-timeline");
    await expect(timeline.getByTestId("label-title")).toHaveCount(6);
    await timeline.getByTestId("chart-label").filter({ hasText: "Usage dashboard" }).click();
    const sheet = page.getByTestId("sheet-plan-item");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("plan-inspector")).toContainText("Usage dashboard");
  });
});
