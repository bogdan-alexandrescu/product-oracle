import { expect, test, type Page } from "@playwright/test";

import { MOCK_REVIEW_CHANGE_KEY } from "../lib/api/mock/server";
import { login, seedRoadmapReview, signOut } from "./helpers";

/**
 * D8 Shared draft decision: the Roadmap items checkpoint's draft lives on the server. Its note
 * survives a reload, the header says how long the SwarmCloud wait has left, a commenter's
 * suggestion reaches the approver's page on the next poll, and a decision over changes the
 * approver has not seen is refused.
 *
 * The mock keeps its data in one browser context's localStorage, so a second reviewer is a
 * second tab of that context signed in as someone else (each tab keeps its own sign-in; a
 * new tab starts as the last one signed in).
 */

/** Opens the seeded roadmap review run from the runs list, as a person would. */
async function openRun(page: Page) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "usage-alerts-roadmap" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const decision = (page: Page) => page.getByRole("group", { name: "Decide: Roadmap items" });

// Card saved-note: protects = the note to the agents is saved on the server as the approver
// types and loads after a reload; fails_when = a reload loses it, or "Saved" shows before the
// save; no_claim = a second approver's view (the API test reads it as another member).
test("the note to the agents is saved as I type and is there after a reload", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openRun(page);
  const note = decision(page).getByLabel("Note for the agents");
  await note.fill("Caps ship on plan thresholds");
  await expect(decision(page).getByTestId("note-status")).toHaveText("Saved");
  await page.reload();
  await expect(decision(page).getByLabel("Note for the agents")).toHaveValue("Caps ship on plan thresholds");
});

// Card time-left: protects = the approver sees how long the SwarmCloud wait has left;
// fails_when = no chip, or the hours are wrong; no_claim = the amber and red thresholds' timing.
test("the decision header says how long the wait has left", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openRun(page);
  await expect(decision(page).getByTestId("wait-chip")).toHaveText("Waiting for you · 19 h left");
});

// Card commenter-suggests: protects = a commenter's action reaches the approver's open page
// without a reload, as a suggestion that names its author; fails_when = it never shows, or
// shows as staged; no_claim = real polling timing against the API.
test("a commenter's suggestion shows on the approver's page within one poll", async ({ page, context }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openRun(page);
  const budget = page.getByTestId("item-reasons").filter({ hasText: "Budget caps" });
  await expect(budget.getByTestId("draft-action")).toHaveCount(0);

  // A second tab opens signed in as the owner: sign out there, then in as the commenter.
  const other = await context.newPage();
  await other.goto("/home");
  await signOut(other);
  await login(other, "commenter@example.com");
  await openRun(other);
  const theirs = other.getByTestId("item-reasons").filter({ hasText: "Budget caps" });
  await theirs.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(theirs.getByTestId("draft-action")).toHaveText(/Move to Later · Suggested by Commenter/);
  // A commenter suggests; deciding stays with the approver.
  await expect(other.getByRole("button", { name: "Approve and continue" })).toHaveCount(0);

  // The approver's page reads the draft every 10 s.
  await expect(budget.getByTestId("draft-action")).toHaveText(/Move to Later · Suggested by Commenter/, { timeout: 12_000 });
  await budget.getByRole("button", { name: "Stage" }).click();
  await expect(budget.getByTestId("draft-action")).toHaveText(/Move to Later · Staged by Commenter/);
});

// Card stale-revision: protects = nothing is decided over changes the approver has not seen;
// fails_when = the decision lands, or the page says nothing; no_claim = SwarmCloud delivery.
test("a decision over a draft that changed since it loaded is refused until I look again", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openRun(page);
  await expect(decision(page).getByTestId("wait-chip")).toBeVisible();
  // D3: the seeded run has blocking problems, so the decision here is Request changes.
  await decision(page).getByLabel("Note for the agents").fill("Remove the Slack alerts date");
  await expect(decision(page).getByTestId("note-status")).toHaveText("Saved");
  // Another reviewer changes the draft after this page loaded it, before the decision.
  await page.evaluate((key) => localStorage.setItem(key, "commenter@example.com"), MOCK_REVIEW_CHANGE_KEY);
  await decision(page).getByRole("button", { name: "Request changes" }).click();
  const changed = page.getByTestId("review-changed");
  await expect(changed).toContainText("The review changed since you loaded it (1 change by Commenter): look again, then decide.");
  // Nothing was decided: the checkpoint still waits.
  await expect(page.getByTestId("checkpoint-waiting")).toBeVisible();
  await expect(decision(page).getByRole("button", { name: "Request changes" })).toBeEnabled();

  await changed.getByRole("button", { name: "Reload" }).click();
  await expect(changed).toHaveCount(0);
  await decision(page).getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByTestId("checkpoint-waiting")).toHaveCount(0);
  await expect(page.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Changes requested");
});
