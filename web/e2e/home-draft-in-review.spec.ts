import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * home-draft-in-review (a person always sees what is happening to a roadmap shared with them):
 * Home's draft card keeps a roadmap draft once it is sent for review. Its decider sees it with one
 * action, Open draft to approve, which opens it on the Roadmap; once decided it is gone. The one
 * who sent it sees it as waiting for review, whom it waits on in the tip. A viewer sees nothing.
 *
 * fails_when: Home keeps only working drafts, so the decider never sees the draft in review.
 */

/** The owner sends the Onboarding roadmap's draft for review (Priya Raman decides it). */
async function sendForReview(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-two-drafts"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("conflicts").locator('[data-testid="conflict"][data-item="setup-tour"]').getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByText(/Brought back 'In-app tour'/)).toBeVisible();
  await page.getByTestId("draft-banner").getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText(/Sent for review/).first()).toBeVisible();
}

async function openHome(page: Page) {
  await page.goto("/simple");
  await expect(page.getByTestId("home-sentence")).toBeVisible();
}

const draftRow = (page: Page) => page.getByTestId("home-draft").filter({ hasText: "Onboarding roadmap" });

test("a roadmap draft sent for review shows on Home to its decider until decided, and to its sender as waiting", async ({ page }) => {
  await sendForReview(page);
  // The sender: its status word, whom it waits on in the tip.
  await openHome(page);
  await expect(draftRow(page)).toContainText("Waiting for review");
  await draftRow(page).getByRole("button", { name: "Waiting for review" }).click();
  await expect(page.getByText(/it waits for Priya Raman to approve/)).toBeVisible();

  // The decider: the card with its one action, listed once.
  await signOut(page);
  await login(page, "approver@example.com");
  await openHome(page);
  await expect(draftRow(page)).toContainText("Waiting for your approval");
  await expect(page.getByTestId("home-also-waiting-list").filter({ hasText: "Onboarding roadmap" })).toHaveCount(0);
  await draftRow(page).getByRole("link", { name: "Open draft to approve" }).click();
  await expect(page).toHaveURL(/\/simple\/roadmap\?draft=/);
  await page.getByTestId("draft-banner").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/Approved/).first()).toBeVisible();

  // Decided: gone from Home.
  await openHome(page);
  await expect(draftRow(page)).toHaveCount(0);
});

test("a viewer sees no draft in review on Home", async ({ page }) => {
  await sendForReview(page);
  await signOut(page);
  await login(page, "viewer@example.com");
  await openHome(page);
  await expect(page.getByTestId("home-draft")).toHaveCount(0);
});
