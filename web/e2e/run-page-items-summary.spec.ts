import { expect, test } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, openSeeded, seedRoadmapReview } from "./helpers";

/**
 * #542 (D1, #159): on a run waiting at its Roadmap items checkpoint, the run page's Roadmap
 * items segment is a summary: "{n} need you · {b} blocking", Review items and Raw file. Items
 * are decided on the review screen only: no per-item cards or fix buttons on the run page.
 */

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;

// Card run-page-summary: protects = #542, the run page no longer decides roadmap items inline;
// fails_when = an item card or its Accept / Move to Later / Drop / Keep in Next shows on the run
// page, or Review items does not open the review screen; no_claim = the console-answer panel.
test("the run page at a Roadmap items checkpoint shows the summary only; Review items opens the review screen", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, `/runs/${RUN}`);
  const summary = page.getByTestId("items-review-line");
  await expect(summary).toContainText("10 need you · 3 blocking");
  await expect(summary.getByRole("link", { name: "Review items" })).toBeVisible();
  await expect(summary.getByRole("button", { name: "Raw file" })).toBeVisible();

  const main = page.getByRole("main");
  for (const name of ["Accept", "Move to Later", "Drop", "Keep in Next"]) {
    await expect(main.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId("item-reasons")).toHaveCount(0);
  await expect(page.getByTestId("reason-fix-buttons")).toHaveCount(0);
  await expect(page.getByTestId("draft-action")).toHaveCount(0);

  await summary.getByRole("link", { name: "Review items" }).click();
  await expect(page).toHaveURL(new RegExp(`${SCREEN}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  // The same counts as the run page's summary.
  await expect(page.getByTestId("review-summary")).toContainText("3 blocking");
  await expect(page.getByRole("button", { name: /^Needs you/ })).toContainText("10");
});
