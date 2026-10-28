import { expect, test, type Page } from "./test";

import { login, seedRoadmapAttempt2 } from "./helpers";

/**
 * D6 No per-item resolutions on re-run: after a send-back with a review, attempt 2 answers
 * every entry; the run page shows how many were done, declined or not applied, the review
 * screen each item's answer with its reasons (a decline's note in full), and an entry the
 * agents claimed but did not apply keeps Approve disabled. Driven through the UI over the mock API.
 */

/** Opens a seeded run from the runs list by its document, as a person would. */
async function openRun(page: Page, slug: string) {
  await page.goto("/runs");
  await page.locator(`[data-testid="run-row"][data-document="${slug}"]`).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);

/** On the review screen, the item's reason card (in its inspector) says the text in full. */
async function reason(page: Page, key: string, label: string, text: string) {
  await row(page, key).locator('[data-phone="title"]').click();
  await expect(page.getByTestId("roadmap-item-inspector").getByTestId("reason-card").filter({ hasText: label })).toContainText(text);
}

const NOTE = "Push waits for the mobile app release next quarter, so it stays in Later until the app ships to every owner";

// Card attempt-2-summary: protects = the reviewer sees what attempt 2 did with each entry;
// fails_when = the counts are missing, the decline's note is cut, or Approve is enabled while
// a claimed change is not in the file; no_claim = the review screen's other filters and fixes.
test("attempt 2 shows its answers: counts, the declined note in full, and Approve held by a change not applied", async ({ page }) => {
  await login(page);
  await seedRoadmapAttempt2(page);
  await openRun(page, "usage-alerts-roadmap-3");
  const check = page.getByTestId("items-check");
  await expect(check.getByTestId("resolution-summary")).toHaveText(
    "Attempt 2: 3 of 5 entries done · 1 declined · 1 not applied · 1 unrequested change",
  );

  // D1 (#542): each item's answer is on the review screen (Review items), not the run page.
  await expect(check.getByTestId("item-reasons")).toHaveCount(0);
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Changed/ }).click();
  await expect(row(page, "mobile-push").getByTestId("resolution-chip")).toHaveText(`Declined: ${NOTE}`);
  await expect(row(page, "sso-login").getByTestId("resolution-chip")).toHaveText("Not applied");

  await reason(page, "mobile-push", "Change declined", `Declined: ${NOTE}`);
  await reason(page, "sso-login", "Change not applied", "The agents said done, but sso-login is still in the file.");
  await reason(
    page,
    "invoice-pdf",
    "Unrequested change",
    "Changed without being asked: outcome Finance downloads each invoice → Finance downloads every invoice as a PDF",
  );

  const bar = page.getByTestId("decision-bar");
  await expect(bar.getByTestId("approve-blocked")).toHaveText("1 blocking problem left");
  await expect(row(page, "sso-login")).toContainText("Change not applied");
  await expect(bar.getByRole("button", { name: /^Approve/ })).toBeDisabled();
});
