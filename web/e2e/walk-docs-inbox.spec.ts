import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, seedRoadmapReview } from "./helpers";

/**
 * walk-docs-priorities 7: an Inbox item's reason reads its dates month first, as the review page
 * does ("… supports Nov 30, 2026."), never ISO ("2026-11-30").
 *
 * Test card: protects=the reason line and its hover text under a checkpoint row;
 * fails_when=an ISO date shows; no_claim=the API's sentence (it stays ISO for machines).
 */

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;

async function openInbox(page: Page) {
  await login(page);
  const kept = () =>
    page.evaluate((id) => JSON.parse(localStorage.getItem("po-mock-db-v2")!).runs.runs.some((r: { id: string }) => r.id === id), RUN);
  for (let i = 0; i < 5; i++) {
    await seedRoadmapReview(page);
    let still = true;
    for (let n = 0; n < 3 && still; n++) {
      await page.waitForTimeout(700);
      still = await kept();
    }
    if (still) return;
  }
}

test("7 an Inbox reason reads its date month first", async ({ page }) => {
  await openInbox(page);
  await page.goto("/inbox");
  const row = page.locator(`tr[data-key="${CP}-slack-alerts"]`).filter({ visible: true });
  await expect(row).toContainText("No verified estimate, capacity or commitment supports Nov 30, 2026.");
  await expect(row).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(row.getByTestId("child-reason")).toHaveAttribute("title", /supports Nov 30, 2026\./);
});
