import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * Board's goal tables span the page (train O5 follow-up). The roadmap-board theme lays the
 * sections under a horizon out as a three-column board of cards; a goal group holding Board's
 * item table is marked full width (section-wide) and spans the whole row instead of one card
 * column. The "sharing" scenario's Board: Now and Next each hold two goal tables (G1, G2).
 */

const DOC = "/documents/example-labs-roadmap";

async function sharing(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
}

test("Board's first goal table is as wide as the page, not one card column", async ({ page }) => {
  // protects=Board's goal tables span the card board in the audience preview;
  // fails_when=a goal table is laid out as one of three card columns again;
  // no_claim=the PDF (the API's test_board_goal_tables_span).
  await page.setViewportSize({ width: 1400, height: 900 });
  await sharing(page);
  await page.goto(DOC);
  await page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Board" }).click();
  const board = page.frameLocator('iframe[title="Roadmap for Board"]');
  const table = board.getByRole("table").first();
  await expect(table.getByRole("columnheader", { name: "Outcome" })).toBeVisible();
  await expect(table.getByRole("row")).not.toHaveCount(0);
  const ratio = await table.evaluate((t) => t.getBoundingClientRect().width / t.ownerDocument.body.getBoundingClientRect().width);
  expect(ratio).toBeGreaterThanOrEqual(0.9);
  // Team's item cards stay cards: narrower than a third of the page.
  await page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Team" }).click();
  const team = page.frameLocator('iframe[title="Roadmap for Team"]');
  const card = team.locator('section[data-section-key^="now-"]').filter({ has: team.getByRole("heading", { name: "Falcon alerts rework" }) });
  const cardRatio = await card.evaluate((s) => s.getBoundingClientRect().width / s.ownerDocument.body.getBoundingClientRect().width);
  expect(cardRatio).toBeLessThan(0.4);
});
