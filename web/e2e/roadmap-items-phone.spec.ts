import { expect, test } from "@playwright/test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, openSeeded, seedRoadmapReview } from "./helpers";

// D1 Roadmap items review at 390 px: rows become cards grouped by horizon, a card opens the
// inspector as a full-height sheet, and the bar stays at the bottom. The seeded roadmap review run.

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;

test.use({ viewport: { width: 390, height: 844 } });

// Card phone: protects = criterion 3 at 390 px, cards with whole reason chips and their fixes,
// no horizontal page scroll, a sheet inspector and the collapsed bar; fails_when = a horizontal
// scroll, a clipped chip or no sheet; no_claim = real devices.
test("phone: cards by horizon, a sheet inspector, no horizontal scroll", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, `/runs/${RUN}/review/${CP}`);
  const card = page.locator('[data-testid="roadmap-item-row"][data-key="budget-caps"]');
  await expect(card).toContainText("Depends on a later item");
  await expect(card.getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const clipped = await page.getByTestId("reason-chip").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  expect(clipped).toBe(0);
  await card.locator('[data-phone="title"]').click();
  await expect(page.getByTestId("sheet-item")).toContainText("Budget caps");
  await page.getByTestId("sheet-item").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("decision-bar")).toHaveAttribute("data-collapsed", "true");
});
