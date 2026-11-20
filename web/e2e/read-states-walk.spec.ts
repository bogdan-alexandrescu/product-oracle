import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * #1586 on Simple's Home walk and the waiting rows: a decisions read that failed says so (Could
 * not load ..., its reason behind an (i), Try again), never reads as no decisions. Each case is
 * checked both ways: answered, then failed. Against the mock's invented data ("simple-home"
 * scenario; the decision-log call "Ship usage caps before anomaly detection").
 * no_claim: the real API's walk and decisions (their pytest files).
 */

const APPROVER = "approver@example.com";

test.use({ viewport: { width: 1440, height: 900 } });

const failGets = (page: Page, path: string | null) =>
  page.evaluate(([k, p]) => (p ? localStorage.setItem(k, p) : localStorage.removeItem(k)), [MOCK_FAIL_KEY, path] as const);

async function startWalk(page: Page) {
  await page.getByRole("button", { name: "Walk me through it" }).click();
  await expect(page.getByTestId("walk-progress")).toHaveText(/^1 of \d+$/);
}

/** Skips through every step, returning each step's kind in order. */
async function walkKinds(page: Page): Promise<string[]> {
  const total = Number((await page.getByTestId("walk-progress").textContent())!.split(" of ")[1]);
  const kinds: string[] = [];
  for (let n = 1; n <= total; n++) {
    await expect(page.getByTestId("walk-progress")).toHaveText(`${n} of ${total}`);
    kinds.push((await page.getByTestId("walk-step").getAttribute("data-kind"))!);
    await page.getByRole("button", { name: "Skip" }).click();
  }
  await expect(page.getByTestId("walk-finished")).toBeVisible();
  return kinds;
}

test("Home's walk: decisions that could not be read say so with Try again, never no decisions", async ({ page }) => {
  // fails_when: a failed GET /v1/simple/decisions/waiting drops its decision steps with no word on why
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "simple-home"] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
  const walk = page.getByTestId("walk");
  const failed = walk.getByTestId("load-error").filter({ hasText: "Could not load the decisions waiting for you." });

  // Answered: the decision steps are in the walk, no error.
  await startWalk(page);
  expect(await walkKinds(page)).toContain("decision");
  await expect(walk.getByTestId("load-error")).toHaveCount(0);
  // Failing before Done: Home's read again after Done fails too, so the walk never takes its
  // answer, shared for a moment (lib/api/shared-reads), in place of its own.
  await failGets(page, "/v1/simple/decisions/waiting");
  await page.getByRole("button", { name: "Done" }).click();

  // Failed: the walk still goes, and says which read failed and why.
  await startWalk(page);
  await expect(failed).toBeVisible();
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
  expect(await walkKinds(page)).not.toContain("decision");
  await expect(failed).toBeVisible();

  // Try again once it answers: the error goes and the decisions are back.
  await failGets(page, null);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(walk.getByTestId("load-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Done" }).click();
  await startWalk(page);
  expect(await walkKinds(page)).toContain("decision");
});

test("Decisions: a decision-log call that could not be read says so with Try again in place of Decide", async ({ page }) => {
  // fails_when: a failed GET /v1/decisions/{n} leaves the row with no Decide buttons and no error
  await login(page, APPROVER);
  await page.goto("/simple/decisions");
  const call = page.getByTestId("questions-mine").getByRole("listitem", { name: "Decision: Ship usage caps before anomaly detection" });
  const failed = call.getByTestId("load-error").filter({ hasText: "Could not load the decision." });

  // Answered: Decide in place, no error.
  await expect(call.getByRole("button", { name: "Decide: Caps first" })).toBeVisible();
  await expect(call.getByTestId("load-error")).toHaveCount(0);

  // Failed: the error with its reason, in place of the actions.
  await failGets(page, "/v1/decisions/5");
  await page.reload();
  await expect(failed).toBeVisible();
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
  await expect(call.getByRole("button", { name: "Decide: Caps first" })).toHaveCount(0);

  // Try again once it answers: Decide is back.
  await failGets(page, null);
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(call.getByRole("button", { name: "Decide: Caps first" })).toBeVisible();
  await expect(call.getByTestId("load-error")).toHaveCount(0);
});
