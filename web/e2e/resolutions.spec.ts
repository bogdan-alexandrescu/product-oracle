import { expect, test, type Page } from "./test";

import { login, seedRoadmapAttempt2 } from "./helpers";

/**
 * D6 No per-item resolutions on re-run: after a send-back with a review, attempt 2 answers
 * every entry; the run page shows how many were done, declined or not applied, each item's
 * answer next to its reasons (a decline's note in full), and an entry the agents claimed but
 * did not apply keeps Approve disabled. Driven through the UI over the mock API.
 */

/** Opens a seeded run from the runs list by its document, as a person would. */
async function openRun(page: Page, slug: string) {
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: new RegExp(`${slug}(?!-)`) }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
}

const NOTE = "Push waits for the mobile app release next quarter, so it stays in Later until the app ships to every owner";

// Card attempt-2-summary: protects = the reviewer sees what attempt 2 did with each entry;
// fails_when = the counts are missing, the decline's note is cut, or Approve is enabled while
// a claimed change is not in the file; no_claim = the D1 Roadmap items review screen.
test("attempt 2 shows its answers: counts, the declined note in full, and Approve held by a change not applied", async ({ page }) => {
  await login(page);
  await seedRoadmapAttempt2(page);
  await openRun(page, "usage-alerts-roadmap-3");
  const check = page.getByTestId("items-check");
  await expect(check.getByTestId("resolution-summary")).toHaveText(
    "Attempt 2: 3 of 5 entries done · 1 declined · 1 not applied · 1 unrequested change",
  );

  const push = check.getByTestId("item-reasons").filter({ hasText: "Mobile push" });
  await expect(push.getByTestId("resolution-chip")).toHaveText(`Declined: ${NOTE}`);
  await expect(push.getByTestId("item-reason").filter({ hasText: "Change declined" })).toContainText(`Declined: ${NOTE}`);

  const sso = check.getByTestId("item-reasons").filter({ hasText: "Single sign-on" });
  await expect(sso.getByTestId("resolution-chip")).toHaveText("Not applied");
  await expect(sso.getByTestId("item-reason").filter({ hasText: "Change not applied" })).toContainText(
    "The agents said done, but sso-login is still in the file.",
  );

  const invoice = check.getByTestId("item-reasons").filter({ hasText: "Invoice PDF" });
  await expect(invoice.getByTestId("item-reason").filter({ hasText: "Unrequested change" })).toContainText(
    "Changed without being asked: outcome Finance downloads each invoice → Finance downloads every invoice as a PDF",
  );

  // D1: Roadmap items are decided on their review screen (Review items), not on the run page.
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  const bar = page.getByTestId("decision-bar");
  await expect(bar.getByTestId("approve-blocked")).toHaveText("1 blocking problem left");
  await expect(page.locator('[data-testid="roadmap-item-row"][data-key="sso-login"]')).toContainText("Change not applied");
  await expect(bar.getByRole("button", { name: /^Approve/ })).toBeDisabled();
});
