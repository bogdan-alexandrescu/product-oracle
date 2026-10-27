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

test("Team's goal headings span the page as row headings over its three-column item cards", async ({ page }) => {
  // protects=Team's goal headings span the card board in the audience preview, its item cards
  // under them stay three to a row (owner decision, 2026-10-26); fails_when=a goal heading is laid
  // out as one card column, or an item card spans the row; no_claim=the PDF (the API's test).
  await page.setViewportSize({ width: 1400, height: 900 });
  await sharing(page);
  await page.goto(DOC);
  await page.getByRole("radiogroup", { name: "Audience" }).getByRole("radio", { name: "Team" }).click();
  const team = page.frameLocator('iframe[title="Roadmap for Team"]');
  const heading = team.locator('section[data-section-key="now-group-1"]');
  await expect(heading.getByRole("heading")).toBeVisible();
  const width = (s: HTMLElement | SVGElement) => s.getBoundingClientRect().width / s.ownerDocument.body.getBoundingClientRect().width;
  expect(await heading.evaluate(width)).toBeGreaterThanOrEqual(0.9);
  const card = team.locator('section[data-section-key^="now-"]').filter({ has: team.getByRole("heading", { name: "Falcon alerts rework" }) });
  expect(await card.evaluate(width)).toBeLessThan(0.4);
});
