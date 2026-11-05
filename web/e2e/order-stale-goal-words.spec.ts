import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITY_NO_GOAL_RUN, PRIORITY_STALE_GOAL_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * Follow-ups to PR 1244 (review minors), on the mock layer, driven as a person would. Test cards:
 * - "a stale goal problem clears once the goal is back": protects=a goal the order's new feature
 *   serves, rejected after the check, blocks Approve order; once a person brings the goal back
 *   (Undo in the run's From this run review, or Confirm after it), the band and the run page's
 *   gate no longer list it and Approve order saves the order; fails_when=the problem stays on the
 *   band or the gate list after the goal is back, or Approve order stays refused;
 *   no_claim=other order problems.
 * - "a goal with no name is said as a deleted goal": protects=an order naming a goal key the
 *   Ground Truth has no name for says "a goal that was deleted" on the band, the run page's gate
 *   chip and the Inbox, never the key nor "an unknown goal"; fails_when=the key or the old words
 *   show; no_claim=the goal's last known name (api tests).
 */

const STALE_GOAL = "Gift box sizes serves the goal Cut early churn, which was rejected after the order was checked: the run must name a goal of the Ground Truth";
const DELETED_GOAL = "Gift wrap choice names a goal that was deleted: the run must name a goal of the Ground Truth";

const withScenario = (page: Page) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "priority-order"]);

async function openOrder(page: Page, run: string) {
  await page.goto(`/runs/${run}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page.getByTestId("snapshot-band")).toBeVisible();
}

/** The run's own review of what it wrote to the baseline: Cut early churn's row. */
async function churnRow(page: Page) {
  await page.goto(`/baseline?tab=from-run&run=${PRIORITY_STALE_GOAL_RUN}`);
  const row = page.getByTestId("from-run-row").filter({ hasText: "Cut early churn" });
  await expect(row).toBeVisible();
  return row;
}

async function rejectAndTry(page: Page) {
  await openOrder(page, PRIORITY_STALE_GOAL_RUN);
  const order = page.url();
  // A person rejects the goal after the order was checked.
  const row = await churnRow(page);
  await row.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(row.getByTestId("row-result")).toContainText("Rejected");
  // Approve order is refused, the problem named on the band.
  await page.goto(order);
  const band = page.getByTestId("snapshot-band");
  await band.getByRole("button", { name: "Approve order" }).click();
  await expect(band.getByRole("list", { name: "Blocking problems" })).toContainText(STALE_GOAL);
  await expect(band.getByRole("button", { name: "Approve order" })).toBeDisabled();
  return order;
}

test.describe("Follow-ups to PR 1244: order problems about goals", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a stale goal problem clears once the goal is back, and Approve order saves", async ({ page }) => {
    await withScenario(page);
    await login(page);
    const order = await rejectAndTry(page);

    // The person changes their mind: Undo brings the goal back, proposed.
    const row = await churnRow(page);
    await row.getByRole("button", { name: "Undo" }).click();
    await expect(row.getByRole("button", { name: "Confirm" })).toBeVisible();

    // The run page's gate no longer lists it.
    await page.goto(`/runs/${PRIORITY_STALE_GOAL_RUN}`);
    const cp = page.getByTestId("checkpoint-priority_order");
    await expect(cp.getByRole("link", { name: "Review the order" })).toBeVisible();
    await expect(cp).not.toContainText("rejected after the order was checked");

    // Nor does the band, and Approve order saves the order.
    await page.goto(order);
    const band = page.getByTestId("snapshot-band");
    await expect(band.getByRole("button", { name: "Approve order" })).toBeEnabled();
    await expect(band).not.toContainText(STALE_GOAL);
    await band.getByRole("button", { name: "Approve order" }).click();
    await expect(band).toContainText("Saved for Gift boxes");
    await expect(band.getByRole("button", { name: "Approve order" })).toHaveCount(0);
  });

  test("a goal confirmed again clears the problem too", async ({ page }) => {
    await withScenario(page);
    await login(page);
    const order = await rejectAndTry(page);
    const row = await churnRow(page);
    await row.getByRole("button", { name: "Undo" }).click();
    await row.getByRole("button", { name: "Confirm" }).click();
    await expect(row.getByTestId("row-result")).toContainText("Confirmed");

    await page.goto(order);
    const band = page.getByTestId("snapshot-band");
    await expect(band).not.toContainText(STALE_GOAL);
    await expect(band.getByTestId("cannot-approve")).toHaveCount(0);
    await expect(band.getByRole("button", { name: "Approve order" })).toBeEnabled();
  });

  test("a goal with no name is said as a deleted goal, never by its key", async ({ page }) => {
    await withScenario(page);
    await login(page, "approver@example.com");
    // The band.
    await openNoGoalOrder(page);
    const band = page.getByTestId("snapshot-band");
    await expect(band.getByRole("list", { name: "Blocking problems" }).getByText(DELETED_GOAL, { exact: true })).toBeVisible();
    await expect(band).not.toContainText("g.no-such-goal");
    await expect(band).not.toContainText("an unknown goal");

    // The run page's gate chip.
    await page.goto(`/runs/${PRIORITY_NO_GOAL_RUN}`);
    const gate = page.getByTestId("checkpoint-priority_order").getByTestId("approve-gate");
    await expect(gate.getByText(DELETED_GOAL, { exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("g.no-such-goal");

    // The Inbox.
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("g.no-such-goal");
  });
});

async function openNoGoalOrder(page: Page) {
  await openOrder(page, PRIORITY_NO_GOAL_RUN);
}
