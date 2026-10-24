import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN_ID } from "../lib/api/mock/runs";
import { MOCK_REVIEW_CHANGE_KEY } from "../lib/api/mock/server";
import { login, openSeeded, seedRoadmapReview, signOut } from "./helpers";

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

const bar = (page: Page) => page.getByTestId("decision-bar");
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);

/** D1: Roadmap items are decided on their review screen, opened from the run page's Review items. */
async function openReview(page: Page) {
  await openSeeded(page, seedRoadmapReview, `/runs/${ROADMAP_REVIEW_RUN_ID}`);
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
}

// Card saved-note: protects = the note to the agents is saved on the server as the approver
// types and loads after a reload; fails_when = a reload loses it, or "Saved" shows before the
// save; no_claim = a second approver's view (the API test reads it as another member).
test("the note to the agents is saved as I type and is there after a reload", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openReview(page);
  const note = bar(page).getByLabel("Note to the agents");
  await note.fill("Caps ship on plan thresholds");
  // The review screen's bar saves the note when it loses focus; a reload reads it back.
  await page.keyboard.press("Tab");
  // The bar shows no saved state: give the save a moment before reloading (a reload cancels it).
  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(bar(page).getByLabel("Note to the agents")).toHaveValue("Caps ship on plan thresholds");
});

// Card time-left: protects = the approver sees how long the SwarmCloud wait has left;
// fails_when = no chip, or the hours are wrong; no_claim = the amber and red thresholds' timing.
test("the decision header says how long the wait has left", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openReview(page);
  await expect(page.getByTestId("review-status")).toHaveText("Waiting for you · 19 h left");
});

// Card commenter-suggests: protects = a commenter's action reaches the approver's open page
// without a reload, as a suggestion that names its author; fails_when = it never shows, or
// shows as staged; no_claim = real polling timing against the API.
test("a commenter's suggestion shows on the approver's page within one poll", async ({ page, context }) => {
  await login(page);
  await seedRoadmapReview(page);
  // D1 (#542): items are suggested and staged on the review screen; the run page has no per-item buttons.
  await openReview(page);
  const screen = page.url();
  const budget = row(page, "budget-caps");
  await expect(budget.getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  await expect(budget.getByTestId("suggested-by")).toHaveCount(0);

  // A second tab opens signed in as the owner: sign out there, then in as the commenter.
  const other = await context.newPage();
  await other.goto("/home");
  await signOut(other);
  await login(other, "commenter@example.com");
  await other.goto(screen);
  const theirs = row(other, "budget-caps");
  await theirs.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(theirs.getByTestId("suggested-by")).toHaveText(/Suggested by you/);
  // A commenter suggests; deciding stays with the approver.
  await expect(bar(other).getByRole("button", { name: /^Approve/ })).toHaveCount(0);

  // The approver's page reads the draft every 10 s.
  await expect(budget.getByTestId("suggested-by")).toHaveText(/Suggested by Commenter: Move to Later/, { timeout: 12_000 });
  await budget.getByRole("button", { name: "Stage" }).click();
  await expect(budget.getByTestId("row-done")).toHaveText(/✓ Moved to Later/);
});

// Card stale-revision: protects = nothing is decided over changes the approver has not seen;
// fails_when = the decision lands, or the page says nothing; no_claim = SwarmCloud delivery.
test("a decision over a draft that changed since it loaded is refused until I look again", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await openReview(page);
  // D3: the seeded run has blocking problems, so the decision here is Send back.
  await page.locator('[data-testid="roadmap-item-row"][data-key="slack-alerts"]').getByRole("button", { name: "Remove date", exact: true }).click();
  await expect(bar(page).getByTestId("staged-chip")).toHaveCount(1);
  // Another reviewer changes the draft after this page loaded it, before the decision.
  await page.evaluate((key) => localStorage.setItem(key, "commenter@example.com"), MOCK_REVIEW_CHANGE_KEY);
  const sendBack = async () => {
    await bar(page).getByRole("button", { name: "Send back to agents" }).click();
    await page.getByTestId("sheet-send-back").getByRole("button", { name: "Send back", exact: true }).click();
  };
  await sendBack();
  // The confirm sheet stays open over the bar on a refusal: close it to read why.
  await page.getByTestId("sheet-send-back").getByRole("button", { name: "Cancel" }).click();
  const changed = bar(page).getByTestId("review-changed");
  await expect(changed).toContainText("The review changed since you loaded it (1 change by Commenter): look again, then decide.");
  // Nothing was decided: the checkpoint still waits.
  await expect(page.getByTestId("review-status")).toHaveText(/Waiting for you/);

  await changed.getByRole("button", { name: "Reload" }).click();
  await expect(changed).toHaveCount(0);
  await sendBack();
  await expect(page.getByTestId("review-status")).toHaveText(/^Sent back/);
  await page.getByRole("link", { name: /^Roadmap from an approved PRD from / }).click();
  await expect(page.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Changes requested");
});
