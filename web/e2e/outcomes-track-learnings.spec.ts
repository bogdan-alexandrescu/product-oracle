import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * #349: track an outcome, add a learning and retire a learning by hand, driven through the
 * UI as a person would, on the mock API ("outcomes" scenario, synthetic: the approved Usage
 * alerts roadmap's items serve Raise activation; one active learning, "Ask for the metric's
 * baseline before drafting", is on record).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page, role?: "viewer" | "approver") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
}

/** From Plan's tab strip, as a person gets there. */
async function openOutcomes(page: Page) {
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(/\/plan\/outcomes$/);
  await expect(page.getByTestId("outcomes-table")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const learnings = (page: Page) => page.getByTestId("learnings-panel");
const learning = (page: Page, text: string) => page.getByTestId("learning-row").filter({ hasText: text });

test("an approver tracks an outcome for a roadmap item", async ({ page }) => {
  // protects=Track outcome: an item, the expected effect, a metric and a check date make a
  // new outcome row whose inspector shows them, and the item is no longer offered;
  // fails_when=the button is missing, the row does not appear, or the values are lost;
  // no_claim=the API's link checks (tests/test_outcomes.py).
  await start(page);
  await openOutcomes(page);
  await page.getByRole("button", { name: "Track outcome" }).click();
  const form = page.getByTestId("track-outcome-form");
  await form.getByLabel("Item").selectOption({ label: "Threshold alerts on spend" });
  await expect(form.getByLabel("Goal")).toHaveValue(/.+/);
  await expect(form.getByLabel("Goal").locator("option:checked")).toHaveText("Raise activation");
  await form.getByLabel("Expected effect").fill("+5 weekly active teams");
  await form.getByLabel("Metric").fill("Weekly active teams");
  await form.getByLabel("Check date").fill("2027-02-01");
  await form.getByRole("button", { name: "Track outcome" }).click();
  await expect(form).toHaveCount(0);

  const row = page.getByTestId("outcome-row").filter({ hasText: "Threshold alerts on spend" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(inspector(page)).toContainText("Weekly active teams");
  await expect(inspector(page)).toContainText("+5 weekly active teams");
  await expect(inspector(page)).toContainText("Raise activation");

  await page.getByRole("button", { name: "Track outcome" }).click();
  await expect(
    page.getByTestId("track-outcome-form").getByLabel("Item").locator("option", { hasText: "Threshold alerts on spend" }),
  ).toHaveCount(0);
});

test("an approver adds a learning by hand", async ({ page }) => {
  // protects=Add learning: a statement, what it applies to, its key and its direction make
  // an active learning in the list, still there after a reload; fails_when=the button is
  // missing or the learning is not stored; no_claim=the learnings signal.
  await start(page);
  await openOutcomes(page);
  await learnings(page).getByRole("button", { name: "Add learning" }).click();
  const form = page.getByTestId("learning-form");
  await form.getByLabel("Learning").fill("Ask who owns the rollout before the plan is approved");
  await form.getByLabel("Applies to").selectOption("question_category");
  await form.getByLabel("Which topic").selectOption("ownership");
  await form.getByLabel("Direction").selectOption("recommend_more");
  await form.getByRole("button", { name: "Add learning" }).click();
  await expect(form).toHaveCount(0);
  const added = learning(page, "Ask who owns the rollout");
  await expect(added).toContainText("Question topic · Team ownership");
  await expect(added).toContainText("Recommend more");
  await expect(added.getByTestId("learning-status")).toHaveText("Active");

  await page.reload();
  await expect(learning(page, "Ask who owns the rollout")).toBeVisible();
});

test("an approver retires a learning with a reason", async ({ page }) => {
  // protects=Retire: the reason is asked, the learning reads Retired with the reason and
  // offers no Retire again, after a reload too; fails_when=Retire is missing, the reason is
  // lost, or the learning stays active; no_claim=the signal leaving out retired learnings.
  await start(page);
  await openOutcomes(page);
  const seeded = learning(page, "Ask for the metric's baseline");
  await expect(seeded.getByTestId("learning-status")).toHaveText("Active");
  await seeded.getByRole("button", { name: "Retire" }).click();
  await seeded.getByLabel("Reason").fill("Every template asks for it now");
  await seeded.getByRole("button", { name: "Retire learning" }).click();
  await expect(seeded.getByTestId("learning-status")).toHaveText("Retired");
  await expect(seeded).toContainText("Every template asks for it now");
  await expect(seeded.getByRole("button", { name: "Retire" })).toHaveCount(0);

  await page.reload();
  await expect(learning(page, "Ask for the metric's baseline").getByTestId("learning-status")).toHaveText("Retired");
});

test("a viewer reads learnings without Track outcome, Add learning or Retire", async ({ page }) => {
  // protects=the #370 rule: controls a viewer can never use are hidden; fails_when=any of
  // the three shows; no_claim=the API's 403 (tests/test_outcomes.py).
  await start(page, "viewer");
  await openOutcomes(page);
  await expect(learning(page, "Ask for the metric's baseline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Track outcome" })).toHaveCount(0);
  await expect(learnings(page).getByRole("button", { name: "Add learning" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retire" })).toHaveCount(0);
});
