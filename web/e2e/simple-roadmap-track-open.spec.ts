import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card track-open-once: protects = picking the Board, the Waterfall or the Gantt (each starts grouped by
 * track) draws its items once, in the track bands, with no other groups shown first and swapped out
 * when a second read comes back; fails_when = a format pick reads the roadmap again by track and the
 * view is drawn from the old goal groups, then regrouped (every card remounted) once the read lands;
 * no_claim = how long the draw takes (simple-roadmap-500-timing).
 *
 * Card timeline-bar-in-sight: protects = a Timeline bar brought into sight (scrolled to, as Tab or a
 * pointer does) clears the sticky names column, so its start is under the pointer, not the column;
 * fails_when = the bar's start is left under the names column; no_claim = the phone's list.
 */

/** Every group title the board shows from now on, as it is drawn. */
async function watchGroups(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __groups: Set<string> };
    w.__groups = new Set();
    const read = () => {
      for (const h of document.querySelectorAll('[data-testid="board-group"] h3')) w.__groups.add((h.textContent ?? "").trim());
    };
    new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

test.describe("Track bands drawn once", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(async ({ context, page }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-500"), MOCK_SCENARIO_KEY);
    await login(page);
  });

  test("the Board opens on its track groups, with no other groups shown first", async ({ page }) => {
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("timeline-row").first()).toBeVisible({ timeout: 15_000 });
    await watchGroups(page);
    await page.getByTestId("format-board").click();
    await expect(page.getByTestId("board-card")).toHaveCount(500, { timeout: 15_000 });
    // Let a second read, if any, land and redraw.
    await page.waitForTimeout(1500);
    const now = await page.locator('[data-testid="board-group"] h3').allTextContents();
    const seen = await page.evaluate(() => [...(window as unknown as { __groups: Set<string> }).__groups]);
    expect(now.length).toBeGreaterThan(0);
    expect(seen.filter((t) => !now.map((x) => x.trim()).includes(t))).toEqual([]);
  });

  test("a Timeline bar scrolled into sight is not under the names column", async ({ page }) => {
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("timeline-row").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("zoom-6m").click();
    const names = page.getByTestId("timeline-names-head");
    const bars = page.locator('[data-testid="timeline-bar"][aria-label*="Arrows move it"]');
    // Each of the first movable bars, brought into sight, starts right of the names column.
    for (let n = 0; n < 5; n++) {
      const bar = bars.nth(n);
      await bar.scrollIntoViewIfNeeded();
      const edge = (await names.boundingBox())!;
      const box = (await bar.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(edge.x + edge.width - 1);
    }
  });
});
