import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The owner's production walk of Simple mode, the roadmap (walk fixes 3, R4 and R5). Driven
 * through the UI on the mock's invented data (./lib/api/mock/simple-roadmap.ts; the mock's
 * day is MOCK_NOW, Oct 22, 2026), on desktop (1366x820) and phone (390x844), light and dark.
 *
 * Card walk3-why-provenance: protects = an item card's "Why" line names where the item came
 * from as "From <PRD>: <feature name>." ("From Usage alerts: Weekly digest of fired alerts."),
 * with no draft number or code, and an item imported from a section with no code reads its
 * own name ("From Usage alerts: Alert rules engine."), never a lowercase section anchor;
 * fails_when = the line reads "section bets" / "section f-06"; no_claim = the other reasons (rationale, goal) and the API's rule
 * (api/tests/test_simple_walk_fixes3_rw_api.py).
 *
 * Card walk3-later-window: protects = on the Now / Next / Later board, Later's window starts
 * the day after Next ends (Next "Jan 1 – Jun 30, 2027", Later "Jul 1, 2027 – Oct 22, 2028")
 * and an undated Later item's estimate starts there too; fails_when = Later starts a year
 * from today (Oct 22, 2027), leaving a gap after Next; no_claim = the Settings page's
 * planning horizons and the timeline's quarter axis.
 */

const DESKTOP = { width: 1366, height: 820 };
const PHONE = { width: 390, height: 844 };

const column = (page: Page, h: "now" | "next" | "later"): Locator => page.locator(`[data-testid="board-column"][data-horizon-column="${h}"]`);
const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? PHONE : DESKTOP, colorScheme: scheme, hasTouch: phone, isMobile: phone });

      for (const email of ["admin@example.com", "viewer@example.com"]) {
        test(`${email.split("@")[0]}: the card's Why line names the PRD and the feature, no draft number or code (${where})`, async ({ page }) => {
          await login(page, email);
          await page.goto("/simple/roadmap");
          await openRoadmapItem(page, "alert-digest");
          let reasons = page.getByTestId("floating-card").getByTestId("card-reasons");
          await expect(reasons).toContainText("From Usage alerts: Weekly digest of fired alerts.");
          await expect(reasons).not.toContainText("section ");
          await page.getByTestId("floating-card").getByRole("button", { name: "Close" }).click();
          await expect(page.getByTestId("floating-card")).toHaveCount(0);

          await openRoadmapItem(page, "alert-rules");
          reasons = page.getByTestId("floating-card").getByTestId("card-reasons");
          await expect(reasons).toContainText("From Usage alerts: Alert rules engine.");
          await expect(reasons).not.toContainText("section bets");
          await expect(reasons).not.toContainText("section ");
        });
      }

      test(`Later starts the day after Next ends, with no gap (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple/roadmap");
        await expect(page.getByTestId("simple-roadmap")).toBeVisible();
        await page.getByTestId("format-board").click();
        await expect(page.getByTestId("format-board")).toHaveAttribute("aria-pressed", "true");
        await expect(column(page, "next").locator("header")).toContainText("Jan 1 – Jun 30, 2027");
        const later = column(page, "later").locator("header");
        await later.scrollIntoViewIfNeeded();
        await expect(later).toContainText("Jul 1, 2027 – Oct 22, 2028");
        await expect(later).not.toContainText("Oct 22, 2027");
        await expect(boardCard(page, "setup-video").getByTestId("board-dates")).toContainText("Jul 1, 2027 –");
      });
    });
  }
}
