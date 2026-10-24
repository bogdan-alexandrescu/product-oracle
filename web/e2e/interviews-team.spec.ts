import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_TEAM_FOLLOW_UP } from "../lib/api/mock/interviews";
import { login } from "./helpers";

/*
 * C3 team follow-ups, lane 2 (#152, criterion 15), driven through the UI as a person would, on
 * the mock API. The "before-drafting" scenario's brief asks admin@example.com two questions in
 * batch 2. With "Oracle follows up" on, Send answer goes through the team interview's turn: the
 * mock follows up once when the answer has fewer than 12 words.
 *
 * Test card:
 * - "Oracle follows up": protects=the follow-up bubble, Skip, record my answer and the switch
 *   on the Before drafting page; fails_when=a short answer gets no follow-up with the switch
 *   on, Skip loses the answer, the switch off still follows up, or the switch is not
 *   remembered; no_claim=the real model's judgement of a thin answer.
 */

const thread = (page: Page) => page.getByTestId("intake-thread");
const mine = (page: Page): Locator => thread(page).getByTestId("question").filter({ hasText: "Asked you" });
const followSwitch = (page: Page) => page.getByRole("switch", { name: "Oracle follows up" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
  });
});

test("Oracle follows up: a short answer gets one follow-up; Skip records it; off, no follow-up", async ({ page }) => {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(thread(page)).toBeVisible();
  await expect(mine(page)).toHaveCount(2);
  const first = mine(page).nth(0);
  const second = mine(page).nth(1);

  // On by default: a short answer gets one follow-up bubble with Reply and Skip.
  await expect(followSwitch(page)).toBeChecked();
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await first.getByLabel("Your answer").fill("Checkout time.");
  await first.getByRole("button", { name: "Send answer" }).click();
  const follow = first.getByTestId("follow-up");
  await expect(follow).toHaveCount(1);
  await expect(follow).toContainText(MOCK_TEAM_FOLLOW_UP);
  await expect(first.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await expect(first.getByTestId("answer")).toHaveCount(0);

  // Skip, record my answer records what was written; the follow-up stays in the thread.
  await first.getByRole("button", { name: "Skip, record my answer" }).click();
  await expect(first.getByTestId("answer")).toContainText("Checkout time.");
  await expect(first.getByTestId("answer")).toContainText("Your decision");
  await expect(follow).toContainText(MOCK_TEAM_FOLLOW_UP);
  // Oracle moves to the next question asked of me.
  await expect(second.getByLabel("Your answer")).toBeVisible();

  // Off: the same short answer is recorded at once, with no follow-up.
  await followSwitch(page).click();
  await expect(followSwitch(page)).not.toBeChecked();
  await second.getByLabel("Your answer").fill("Q4 goal.");
  await second.getByRole("button", { name: "Send answer" }).click();
  await expect(second.getByTestId("answer")).toContainText("Q4 goal.");
  await expect(second.getByTestId("follow-up")).toHaveCount(0);

  // The switch is remembered, and the transcript keeps the follow-up.
  await page.reload();
  await expect(thread(page)).toBeVisible();
  await expect(followSwitch(page)).not.toBeChecked();
  await expect(thread(page).getByTestId("follow-up")).toHaveCount(1);
});
