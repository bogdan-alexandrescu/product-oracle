import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * Build prompt §10: learnings kept from outcomes tune later question recommendations, driven
 * through the UI as a person would, on the mock API ("before-drafting" scenario, synthetic:
 * one brief by the signed-in owner, twelve questions not asked yet; the effort question
 * ties with two others and sits just below the five Oracle offers next).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const EFFORT = "Roughly how much effort and running cost would this take?";
const DIFFERENTIATION = "What makes this better than what buyers can already do or buy?";
const LEARNT = "Effort questions asked early saved a re-plan";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "before-drafting");
    localStorage.setItem("po-interview-follow-up", "off");
  });
});

async function openIntake(page: Page) {
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const next = (page: Page) => page.getByTestId("next-questions");
const nextPrompts = (page: Page) => next(page).getByTestId("next-prompt");

/** Plan > Outcomes > Add learning, as a person keeps one. */
async function addLearning(page: Page) {
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(/\/plan\/outcomes$/);
  await page.getByTestId("learnings-panel").getByRole("button", { name: "Add learning" }).click();
  const form = page.getByTestId("learning-form");
  await form.getByLabel("Learning").fill(LEARNT);
  await form.getByLabel("Applies to").selectOption("question_category");
  await form.getByLabel("Key").fill("effort_cost");
  await form.getByLabel("Direction").selectOption("recommend_more");
  await form.getByRole("button", { name: "Add learning" }).click();
  await expect(form).toHaveCount(0);
  return page.getByTestId("learning-row").filter({ hasText: LEARNT });
}

/** More actions > Re-analyse: Oracle ranks the questions not asked yet again. */
async function reanalyse(page: Page) {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Re-analyse" }).click();
}

test("a kept learning moves its question into the next ones and says why", async ({ page }) => {
  // protects=a recommend_more learning on a question category: after Re-analyse the effort
  // question is offered next, before the one it tied with, and once asked its "Why Oracle
  // asks" says "Recommended because" with the learning's words; fails_when=the order or the
  // why ignores the learning; no_claim=the cap (api tests/test_learnings_tune.py).
  await login(page);
  await openIntake(page);
  await expect(nextPrompts(page)).toHaveCount(5);
  await expect(nextPrompts(page).nth(4)).toHaveText(DIFFERENTIATION);
  await expect(next(page)).not.toContainText(EFFORT);

  await expect(await addLearning(page)).toContainText("Question category · effort_cost");
  await openIntake(page);
  await reanalyse(page);
  await expect(nextPrompts(page).nth(4)).toHaveText(EFFORT);
  await expect(next(page)).not.toContainText(DIFFERENTIATION);

  await next(page).getByRole("button", { name: "Ask these" }).click();
  const asked = page.getByTestId("intake-thread").getByTestId("question").filter({ hasText: EFFORT });
  await expect(asked).toBeVisible();
  await asked.getByRole("button", { name: "About why Oracle asks" }).click();
  await expect(asked.locator('[role="tooltip"]')).toContainText(`Recommended because of a learning from past outcomes: ${LEARNT}.`);
});

test("a retired learning stops counting", async ({ page }) => {
  // protects=retiring the learning on Plan > Outcomes puts the questions back in their own
  // order at the next Re-analyse; fails_when=a retired learning still moves the effort
  // question; no_claim=questions already asked (never re-ranked).
  await login(page);
  const row = await addLearning(page);
  await row.getByRole("button", { name: "Retire" }).click();
  await row.getByLabel("Reason").fill("Effort is in the template now");
  await row.getByRole("button", { name: "Retire learning" }).click();
  await expect(row.getByTestId("learning-status")).toHaveText("Retired");

  await openIntake(page);
  await reanalyse(page);
  await expect(nextPrompts(page)).toHaveCount(5);
  await expect(nextPrompts(page).nth(4)).toHaveText(DIFFERENTIATION);
  await expect(next(page)).not.toContainText(EFFORT);
});
