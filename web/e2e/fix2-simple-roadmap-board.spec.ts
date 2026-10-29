import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Fix pass 2, the Now / Next / Later board (web/app/simple/roadmap/_board.tsx): five QA
 * findings, driven through the UI against the mock (web/lib/api/mock/simple-roadmap.ts,
 * simple-suggestions.ts), on desktop and phone.
 *
 * - qa-simple-roadmap-3: a column's header never claims a date range a card inside it
 *   contradicts (a card's horizon can move by drag or the arrow keys while its own dates
 *   stay put).
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

/** Drags a board card with the mouse onto a column's header. */
async function dragTo(page: Page, key: string, to: "now" | "next" | "later") {
  const from = (await card(page, key).boundingBox())!;
  const target = (await column(page, to).locator("header").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    /**
     * qa-simple-roadmap-3: an item with its own (accepted) dates keeps them when its
     * horizon moves to another column (the arrow keys, which work the same on a drag);
     * fails_when = the "Now" column's header still claims "Oct 1 – Dec 31" once it holds a
     * card dated months later, a false range the card's own dates contradict.
     */
    test("a column's header drops a date range its own cards contradict", async ({ page }) => {
      // A phone's Timeline (goal lanes) has no suggestion marker to accept from; the desktop run covers it.
      test.skip(where === "phone", "the phone Timeline has no suggestion marker");
      await openBoard(page);
      await acceptSuggestion(page, "alert-sso");
      await page.getByTestId("format-board").click();
      await expect(column(page, "next").locator('[data-item="alert-sso"]')).toBeVisible();
      await expect(column(page, "now").locator("header")).toContainText("Oct 1 – Dec 31");
      await card(page, "alert-sso").scrollIntoViewIfNeeded();
      await card(page, "alert-sso").focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByText("Moved 'Alert routing by team' to Now in your working draft")).toBeVisible();
      await expect(column(page, "now").locator('[data-item="alert-sso"]')).toBeVisible();
      // The card moved to Now, but its own (accepted) dates are still months later: the
      // header no longer claims the Now window now that a card inside contradicts it.
      await expect(column(page, "now").locator("header")).not.toContainText("Oct 1");
      await expect(card(page, "alert-sso").getByTestId("board-dates")).toContainText("2027");
    });

    /**
     * qa-simple-roadmap-42: an estimated card's dates have no striped background (a
     * `repeating-linear-gradient`), only a dashed border; fails_when = the computed
     * background-image is anything but "none".
     */
    test("an estimated card's dates sit on a plain background", async ({ page }) => {
      await openBoard(page);
      const dates = card(page, "alert-sso").getByTestId("board-dates");
      await expect(dates).toContainText("estimated");
      await expect(dates).toHaveCSS("background-image", "none");
    });

    /**
     * qa-simple-roadmap-24: a goal with open suggestions shows its count ("Grow retention"
     * has one, seeded); a goal with none ("Faster activation", seeded with none) shows no
     * chip at all; fails_when = a "✦0" chip sits on a goal with nothing to show.
     */
    test("a goal with no suggestions shows no chip", async ({ page }) => {
      await openBoard(page);
      await expect(group(page, "now", "Grow retention").getByTestId("goal-suggestions-open")).toContainText("✦1");
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
    await page.getByTestId("format-timeline").click();
    await page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]').click();
    const pop = page.getByTestId("suggestion-popover");
    await pop.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
    const outline = page.locator('[data-testid="suggestion-open"]').first();
    const key = await outline.getAttribute("data-item");
    await outline.click();
    await pop.getByRole("button", { name: "Edit dates" }).click();
    await pop.getByLabel("Start").fill("2026-12-01");
    await pop.getByLabel("End").fill("2027-01-15");
    await pop.getByRole("button", { name: "Save dates" }).click();
    await expect(page.getByText("Dates accepted in your working draft")).toBeVisible();
    await page.getByTestId("format-board").click();
    const dates = card(page, key!).getByTestId("board-dates");
    await expect(dates).toContainText("Dec 1 – Jan 15, 2027");
    await expect(dates).not.toContainText("2026");
  });

  /**
   * qa-simple-roadmap-25: a commenter's board move is a proposal that names who proposed
   * it by name ("Proposed by Commenter: move to Now"), not their role alone; fails_when =
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
