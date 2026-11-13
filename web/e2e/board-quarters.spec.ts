import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * board-quarters (owner, Nov 10): Now is this calendar quarter, Next the next one, Later the
 * quarters after; an item's column comes from its dates, and moving a card to another column
 * moves its dates there by whole quarters. The mock's day is Oct 22, 2026.
 *
 * Card board-quarters: protects = the column headers read the quarters month first ("Now ·
 * Oct 1 – Dec 31", "Next · Jan 1 – Mar 31", "Later · Apr 1, 2027 on"); an undated item sits in
 * Later and says "No dates yet · estimated" and its estimate (QA Nov 12 #6); no card says its dates sit outside its column; a drag from Now to
 * Later and then from Later to Next moves the card's dates a quarter at a time (length kept)
 * and Undo puts them back; a commenter's drag is a proposal and the card's dates stay;
 * fails_when = a column comes from a stored horizon, a drag changes only the column, or the
 * headers show the old six-month windows; no_claim = engineering dates (the API's pytest).
 */

const URL = "/simple/roadmap";

const column = (page: Page, h: "now" | "next" | "later"): Locator => page.locator(`[data-testid="board-column"][data-horizon-column="${h}"]`);
const card = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

async function openBoard(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("format-board")).toHaveAttribute("aria-pressed", "true");
}

async function dragTo(page: Page, key: string, to: "now" | "next" | "later") {
  await card(page, key).scrollIntoViewIfNeeded();
  const from = (await card(page, key).boundingBox())!;
  const head = (await column(page, to).locator("header").boundingBox())!;
  const col = (await column(page, to).boundingBox())!;
  const y = head.y >= 0 ? head.y + head.height / 2 : Math.min(from.y + from.height / 2, col.y + col.height - 8);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + head.width / 2, y, { steps: 12 });
  await page.mouse.up();
}

test.use({ viewport: { width: 1440, height: 900 } });

test("the board shows each item in the quarter of its dates", async ({ page }) => {
  await openBoard(page);
  await expect(column(page, "now").getByTestId("column-window")).toHaveText("· Oct 1 – Dec 31");
  await expect(column(page, "next").getByTestId("column-window")).toHaveText("· Jan 1 – Mar 31");
  await expect(column(page, "later").getByTestId("column-window")).toHaveText("· Apr 1, 2027 on");
  // Dated this quarter: Now.
  await expect(column(page, "now").locator('[data-item="alert-rules"]')).toBeVisible();
  await expect(card(page, "alert-rules").getByTestId("board-dates")).toHaveText("Oct 1 – Nov 10");
  // Stored in Next, but no dates: Later, saying so.
  await expect(column(page, "later").locator('[data-item="price-tiers"]')).toBeVisible();
  await expect(card(page, "price-tiers").getByTestId("board-dates")).toHaveText(/^No dates yet · estimated [A-Z][a-z]{2} \d/);
  await expect(page.getByTestId("outside-column")).toHaveCount(0);
});

test("a drag moves the card's dates by quarters, and Undo puts them back", async ({ page }) => {
  await openBoard(page);
  const dates = card(page, "alert-rules").getByTestId("board-dates");
  await expect(dates).toHaveText("Oct 1 – Nov 10");

  await dragTo(page, "alert-rules", "later");
  await expect(column(page, "later").locator('[data-item="alert-rules"]')).toBeVisible();
  await expect(dates).toHaveText("Apr 1 – May 11, 2027");

  await dragTo(page, "alert-rules", "next");
  await expect(column(page, "next").locator('[data-item="alert-rules"]')).toBeVisible();
  await expect(dates).toHaveText("Jan 1 – Feb 10, 2027");

  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(column(page, "later").locator('[data-item="alert-rules"]')).toBeVisible();
  await expect(dates).toHaveText("Apr 1 – May 11, 2027");

  // An undated item moved to Next takes Next's quarter; Undo leaves it with no dates again.
  await dragTo(page, "price-tiers", "next");
  await expect(column(page, "next").locator('[data-item="price-tiers"]')).toBeVisible();
  await expect(card(page, "price-tiers").getByTestId("board-dates")).toHaveText("Jan 1 – Mar 31, 2027");
  await page.getByRole("button", { name: "Undo" }).last().click();
  await expect(column(page, "later").locator('[data-item="price-tiers"]')).toBeVisible();
  await expect(card(page, "price-tiers").getByTestId("board-dates")).toHaveText(/^No dates yet · estimated [A-Z][a-z]{2} \d/);
});

test("a commenter's drag proposes the move and the dates stay", async ({ page }) => {
  await openBoard(page, "commenter@example.com");
  await dragTo(page, "alert-rules", "next");
  const pending = card(page, "alert-rules").getByTestId("board-pending");
  await expect(pending).toContainText("Proposed by");
  await expect(pending).toContainText("move to Next");
  await expect(column(page, "now").locator('[data-item="alert-rules"]')).toBeVisible();
  await expect(card(page, "alert-rules").getByTestId("board-dates")).toHaveText("Oct 1 – Nov 10");
});
