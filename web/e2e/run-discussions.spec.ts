import { expect, test, type Page } from "./test";

import { RUN_DISCUSSION_OPEN, RUN_DISCUSSION_PRIVATE } from "../lib/api/mock/discussions";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * G5 Agents read discussions, on the mock layer ("run-discussions" scenario): the link a run's
 * agents are given (`/runs/<run id>?discussion=<id>`) opens the thread sheet on the run page for
 * someone who may read it, and says "This discussion is private" to someone not in a private
 * one. The scenario seeds, on the feature-set run's waiting checkpoint, an open discussion the
 * approver started and a private one the approver started with the owner.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The agent view itself is covered by api/tests/test_run_discussions.py.
 */

// The run the "feature-set" scenario seeds (web/lib/api/mock/runs.ts FEATURE_SET_RUN).
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";
const COMMENTER = "commenter@example.com";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "run-discussions"), MOCK_SCENARIO_KEY);
const sheet = (page: Page) => page.getByRole("dialog", { name: "Discussion" });

// protects=criterion 10: a discussion link from the agents opens the thread on the run page for
// a commenter, with its title and messages, and closing it leaves the run page; fails_when=the
// link is ignored, the sheet is empty or shows the private notice; no_claim=the API's access rules.
test("a discussion link opens the open thread in a sheet on the run page", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(`/runs/${RUN}?discussion=${RUN_DISCUSSION_OPEN}`);
  await expect(sheet(page)).toBeVisible();
  const thread = sheet(page).getByTestId("discussion-thread");
  await expect(thread).toContainText("Bulk edit: keep it without the export?");
  await expect(thread).toContainText("Can bulk edit ship before the export does?");
  await sheet(page).getByRole("button", { name: "Close Discussion" }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

// protects=criterion 10 and Discuss access: someone not in a private discussion sees only that
// it is private; fails_when=its title or a message shows; no_claim=what the owner, who is in it,
// sees (G1's thread tests).
test("a private discussion's link says it is private to someone not in it", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(`/runs/${RUN}?discussion=${RUN_DISCUSSION_PRIVATE}`);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("discussion-private")).toHaveText("This discussion is private");
  await expect(sheet(page)).not.toContainText("Saved addresses: who pays for storage?");
  await expect(sheet(page)).not.toContainText("Storage costs are still open with finance.");
});
