import { expect, type Page, test } from "./test";

import { login, seedRoadmapReview } from "./helpers";

/**
 * #463 review fixes 1: the review.yaml a run page shows names the Company day it was sent
 * back on. Driven through the UI on the mock layer.
 */

async function setZone(page: Page, zone: string) {
  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption(zone);
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
}

// protects: the review.yaml header names the Company day of the send-back.
// fails_when: it keeps the UTC day (Oct 20) when the Company day is Oct 19.
// no_claim: the API's own header (pytest test_company_day_text.py).
test("run page: the sent-back review names the Company day it was sent back on", async ({ page }) => {
  // Sent back at 09:30 UTC on Oct 20: 23:30 on Oct 19 in Honolulu.
  await page.clock.setFixedTime(new Date("2026-10-20T09:30:00Z"));
  await login(page);
  await setZone(page, "Pacific/Honolulu");
  // A mock request the app had in flight when the seed was written can save its older copy
  // over it (as openSeeded in helpers handles); once the page has navigated nothing old can
  // land any more, so a lost seed is written again (at most 3 times).
  for (let i = 0; i < 3; i++) {
    const runId = await seedRoadmapReview(page);
    await page.goto("/runs");
    const held = await page.evaluate((id) => JSON.parse(localStorage.getItem("po-mock-db-v2")!).runs.runs.some((r: { id: string }) => r.id === id), runId);
    if (held) break;
  }
  await page.getByTestId("run-row").filter({ hasText: "usage alerts roadmap" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();

  // D1 (#542): staged and decided on the Roadmap items review screen, then back to the run.
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  const push = page.locator('[data-testid="roadmap-item-row"][data-key="mobile-push"]');
  await push.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(push.getByTestId("row-done")).toHaveText(/✓ Dropped/);
  await page.getByTestId("decision-bar").getByRole("button", { name: "Send back to agents" }).click();
  await page.getByTestId("sheet-send-back").getByRole("button", { name: "Send back", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText(/^Sent back/);
  await page.getByRole("link", { name: /^(.+ · )?Roadmap from an approved PRD$/ }).click();

  const sent = page.getByTestId("segment-roadmap_items").getByTestId("sent-review");
  await sent.getByRole("button", { name: "View review" }).click();
  const yaml = sent.getByTestId("sent-review-yaml");
  await expect(yaml).toContainText("# Sent back by an approver on 2026-10-19.");
  await expect(yaml).not.toContainText("2026-10-20");
});
