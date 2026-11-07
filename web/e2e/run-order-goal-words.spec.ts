import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITY_NO_GOAL_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * The run order's goal words, as the Ground Truth wording change set them: a goal an order names that the Ground
 * Truth lacks is "not a goal of the Ground Truth" (never "in"), on the order's Unknown goal chip
 * as in the API's problem sentence (oracle.priorities.run_order.unknown_goal_message). Test card:
 * protects=the chip's hover text reads "of the Ground Truth"; fails_when=it reads "in the
 * Ground Truth"; no_claim=the sentence for a goal known by name (api tests). Mock API, made-up data.
 */

async function openNoGoalOrder(page: Page) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "priority-order"] as const);
  await login(page, "approver@example.com");
  await page.goto(`/runs/${PRIORITY_NO_GOAL_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page.getByTestId("snapshot-band")).toBeVisible();
}

test("an order's unknown goal reads 'not a goal of the Ground Truth' on its chip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNoGoalOrder(page);
  const chip = page.getByTestId("priority-row-N-8").getByTestId("unknown-goal");
  await expect(chip).toHaveText("Unknown goal");
  await chip.hover();
  await expect(chip).toHaveAttribute("title", /is not a goal of the Ground Truth$/);
  await expect(chip).not.toHaveAttribute("title", /in the Ground Truth/);
});
