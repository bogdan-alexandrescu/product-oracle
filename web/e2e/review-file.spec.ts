import { expect, test, type Page } from "./test";

import { login, seedRoadmapReview } from "./helpers";

const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);

/**
 * D4 A note is all the agents get: sending a checkpoint back delivers a structured review file
 * (review.yaml) built from the staged actions, one entry per item. The note is optional once
 * something is staged, and the decided checkpoint shows what was sent.
 */

// Card sent-review: protects = a person sends back staged decisions without a note and sees
// what the agents got; fails_when = Request changes stays disabled with staged actions, no
// "View review" link, or the review is empty; no_claim = the agents' prompts (the API tests).
test("send back with staged actions and no note, then view the review that was sent", async ({ page }) => {
  await login(page);
  await seedRoadmapReview(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap"]').getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();

  // D1 (#542): staged and decided on the Roadmap items review screen, not the run page; no note.
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  const slack = row(page, "slack-alerts");
  await slack.getByRole("button", { name: "Remove date", exact: true }).click();
  await expect(slack.getByTestId("row-done")).toHaveText(/✓ Date removed/);
  const push = row(page, "mobile-push");
  await push.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(push.getByTestId("row-done")).toHaveText(/✓ Dropped/);
  const bar = page.getByTestId("decision-bar");
  await expect(bar.getByLabel("Note to the agents")).toHaveValue("");
  await bar.getByRole("button", { name: "Send back to agents" }).click();
  await page.getByTestId("sheet-send-back").getByRole("button", { name: "Send back", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText("Sent back · 2 entries");
  await page.getByRole("link", { name: /^Roadmap from an approved PRD from / }).click();

  const items = page.getByTestId("segment-roadmap_items");
  await expect(items).toContainText("attempt 2");
  await expect(items).toContainText("Running");
  await expect(items.getByTestId("checkpoint-roadmap_items")).toContainText("Changes requested");
  const sent = items.getByTestId("sent-review");
  await expect(sent).toContainText("Sent back · 2 entries · View review");
  await sent.getByRole("button", { name: "View review" }).click();
  const yaml = sent.getByTestId("sent-review-yaml");
  await expect(yaml).toContainText("# Review of roadmap_items.yaml, attempt 1, at the Roadmap items checkpoint.");
  await expect(yaml).toContainText("- id: slack-alerts\n  action: change\n  changes:\n    milestone:\n      date: null");
  await expect(yaml).toContainText("- id: mobile-push\n  action: drop");
  await expect(yaml).toContainText("general_note: null");
});
