import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Fix pass 2, the Now / Next / Later board (web/app/simple/roadmap/_board.tsx): five QA
 * findings, driven through the UI against the mock (web/lib/api/mock/simple-roadmap.ts,
 * simple-suggestions.ts), on desktop and phone.
 *
 * - qa-simple-roadmap-3: a column keeps its date range, and a card whose own dates sit
 *   outside it (its horizon moved by drag or the arrow keys, its dates kept) says so.
 * - qa-simple-roadmap-27: a date range's year shows only on the end whose year isn't this
 *   year's, the same way in every header and card.
 * - qa-simple-roadmap-42: an estimated card's dates sit on a plain background with a
 *   dashed border, not a striped one.
 * - qa-simple-roadmap-24: a goal with no suggestions shows no "✦0" chip.
 * - qa-simple-roadmap-25: a pending proposal names who made it, not their role.
 */

const URL = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const column = (page: Page, h: "now" | "next" | "later"): Locator => page.locator(`[data-testid="board-column"][data-horizon-column="${h}"]`);
const card = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const group = (page: Page, h: "now" | "next" | "later", title: string): Locator =>
  column(page, h).getByTestId("board-group").filter({ hasText: title });

async function openBoard(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("format-board")).toHaveAttribute("aria-pressed", "true");
  // Track everywhere (owner Nov 10): the board starts in track bands.
  await expect(page.getByTestId("board-group").first().locator("h3")).toHaveText(/track$/i);
}

/** Opens Oracle's date suggestion for an item (the Gantt, which shows bars on a phone too)
 * and accepts it, giving the item real (not estimated) dates that stay put when its
 * horizon later changes. */
async function acceptSuggestion(page: Page, key: string) {
  await page.getByTestId("format-gantt").click();
  await page.locator(`[data-testid="suggestion-open"][data-item="${key}"]`).click();
  const pop = page.getByTestId("suggestion-popover");
  await expect(pop).toContainText("Oracle suggests");
  await pop.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
}

/**
 * Drags a board card with the mouse onto a column: its header, or, where the card sits below the
 * fold of a long column (the Goal map's features fill Next since P-1), the column at the card's
 * own height (a desktop's columns are one grid row, as tall as the longest).
 */
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

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    /**
     * qa-simple-roadmap-3, board-quarters (owner, Nov 10): a card's column is the quarter of
     * its dates, so a move (the arrow keys, which work the same as a drag) moves its accepted
     * dates into the new column's quarter; the column keeps its range and no card says its
     * dates sit outside it; fails_when = the card moves but its dates stay months away.
     */
    test("a moved card takes its column's quarter, never dates outside it", async ({ page }) => {
      // A phone's Timeline (goal lanes) has no suggestion marker to accept from; the desktop run covers it.
      test.skip(where === "phone", "the phone Timeline has no suggestion marker");
      await openBoard(page);
      await acceptSuggestion(page, "alert-sso");
      await page.getByTestId("format-board").click();
      await expect(page.getByTestId("board-group").first().locator("h3")).toHaveText(/track$/i);
      await expect(column(page, "later").locator('[data-item="alert-sso"]')).toBeVisible();
      await expect(card(page, "alert-sso").getByTestId("board-dates")).toContainText("Apr");
      await card(page, "alert-sso").scrollIntoViewIfNeeded();
      await card(page, "alert-sso").focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByText("Moved 'Alert routing by team' to Next in your working draft")).toBeVisible();
      await expect(column(page, "next").locator('[data-item="alert-sso"]')).toBeVisible();
      await expect(column(page, "next").locator("header")).toContainText("Jan 1 – Mar 31");
      await expect(card(page, "alert-sso").getByTestId("board-dates")).toContainText("Jan");
      await expect(page.getByTestId("outside-column")).toHaveCount(0);
    });

    /**
     * qa-simple-roadmap-42: an estimated card's dates have no striped background (a
     * `repeating-linear-gradient`), only a dashed border; fails_when = the computed
     * background-image is anything but "none".
     */
    test("an estimated card's dates sit on a plain background", async ({ page }) => {
      await openBoard(page);
      const dates = card(page, "alert-sso").getByTestId("board-dates");
      // board-quarters: an undated card sits in Later and says so.
      await expect(dates).toContainText("No dates");
      await expect(dates).toHaveCSS("background-image", "none");
    });

    /**
     * qa-simple-roadmap-24: a goal with open suggestions shows its count ("Grow retention"
     * has one, seeded); a goal with none ("Faster activation", seeded with none) shows no
     * chip at all; fails_when = a "✦0" chip sits on a goal with nothing to show.
     */
    test("a goal with no suggestions shows no chip", async ({ page }) => {
      await openBoard(page);
      // The goal chips sit on goal bands: Group by Goal.
      await page.getByTestId("group-goal").click();
      await expect(page.getByTestId("group-goal")).toHaveAttribute("aria-pressed", "true");
      await expect(group(page, "now", "Grow retention").getByTestId("goal-suggestions-open")).toContainText("✦ 1 suggested feature");
      await expect(group(page, "now", "Faster activation").getByTestId("goal-suggestions-open")).toHaveCount(0);
    });
  });
}

test.describe("desktop, format", () => {
  test.use(DESKTOP);

  /**
   * qa-simple-roadmap-27: a span that starts this year and ends next year shows the year
   * once, on the end that needs it ("Dec 1 – Jan 15, 2027"), never on both ends ("Dec 1,
   * 2026 – Jan 15, 2027"); fails_when = the card's dates repeat the year on an end that
   * matches this year.
   */
  test("a span crossing into next year shows the year once, on the end that needs it", async ({ page }) => {
    await openBoard(page);
    // Oracle's date suggestions are drawn on the Gantt (the Timeline shows none).
    await page.getByTestId("format-gantt").click();
    await page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]').click();
    const pop = page.getByTestId("suggestion-popover");
    await pop.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
    // The toast comes before the reload: wait till the accepted item's outline is gone, then
    // edit the item read (`.first()` again could be another one once the reload lands).
    await expect(page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]')).toHaveCount(0);
    const key = await page.locator('[data-testid="suggestion-open"]').first().getAttribute("data-item");
    const outline = page.locator(`[data-testid="suggestion-open"][data-item="${key}"]`);
    await outline.click();
    await pop.getByRole("button", { name: "Edit dates" }).click();
    await pop.getByLabel("Start").fill("2026-12-01");
    await pop.getByLabel("End").fill("2027-01-15");
    await pop.getByRole("button", { name: "Save dates" }).click();
    await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
    await page.getByTestId("format-board").click();
    await expect(page.getByTestId("board-group").first().locator("h3")).toHaveText(/track$/i);
    const dates = card(page, key!).getByTestId("board-dates");
    await expect(dates).toContainText("Dec 1 – Jan 15, 2027");
    await expect(dates).not.toContainText("2026");
  });

  /**
   * qa-simple-roadmap-25: a commenter's board move is a proposal that names who proposed
   * it by name ("Proposed by Theo Brandt: move to Now"), not their role alone; fails_when =
   * the line reads "Proposed: move to Now · Commenter" with no "Proposed by".
   */
  test("a proposal names who made it, not just the horizon", async ({ page }) => {
    await openBoard(page, "commenter@example.com");
    await dragTo(page, "alert-export", "now");
    await expect(column(page, "next").locator('[data-item="alert-export"]')).toBeVisible();
    const pending = card(page, "alert-export").getByTestId("board-pending");
    await expect(pending).toContainText("Proposed by");
    await expect(pending).toContainText("move to Now");
  });
});
