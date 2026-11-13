import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-roadmap.md #11), driven as a person does
 * against the mock's invented data: the feature panel opens in the same place in every format.
 * On the Gantt, Now / Next / Later and the Waterfall it opens as the Timeline's side panel,
 * beside the chart, never as a floating card over the format switch or the clicked item. A phone
 * keeps the bottom sheet.
 */

const KEY = "alert-digest";
type Format = "timeline" | "gantt" | "board" | "waterfall";

async function open(page: Page, format: Format) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

function itemIn(page: Page, format: Format): Locator {
  if (format === "timeline") return page.locator(`[data-testid="timeline-row"][data-item="${KEY}"]`).getByTestId("timeline-bar");
  if (format === "board") return page.locator(`[data-testid="board-card"][data-item="${KEY}"]`);
  return page.locator(`[data-testid="bar"][data-item="${KEY}"]`).first();
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const format of ["gantt", "board", "waterfall"] as const) {
    test(`#11: on the ${format} the panel opens beside the chart, as on the Timeline`, async ({ page }) => {
      // protects: clicking Weekly alert digest on the Gantt, the board or the Waterfall opens its panel in the side panel at the chart's right, covering neither the format switch nor the clicked item, with the panel's own contents
      // fails_when: the panel opens as a floating card at the item (over the format switch or the clicked card or bar)
      await open(page, format);
      const it = itemIn(page, format);
      await it.scrollIntoViewIfNeeded();
      await it.click();
      const panel = page.getByTestId("item-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId("floating-card")).toBeVisible();
      await expect(panel.getByTestId("floating-card")).toContainText("Weekly alert digest");
      const box = (await panel.boundingBox())!;
      expect(box.x, "it sits at the right of the page").toBeGreaterThan(1440 / 2);
      for (const f of ["timeline", "gantt", "board", "waterfall"] as const) {
        const sw = (await page.getByTestId(`format-${f}`).boundingBox())!;
        expect(overlaps(box, sw), `it leaves the ${f} switch clear`).toBe(false);
      }
      const clicked = (await it.boundingBox())!;
      expect(overlaps(box, clicked), "it leaves the clicked item clear").toBe(false);
      const chart = (await page.getByTestId(format === "board" ? "board-column" : "simple-chart").last().boundingBox())!;
      expect(chart.x + chart.width, "the chart ends where the panel starts").toBeLessThanOrEqual(box.x + 1);
    });
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("#11: a phone keeps the bottom sheet on the board", async ({ page }) => {
    // protects: on a phone a board card opens its panel as the bottom sheet, not a side panel
    // fails_when: the phone's panel becomes a side panel
    await open(page, "board");
    const it = itemIn(page, "board");
    await it.scrollIntoViewIfNeeded();
    await it.tap();
    const sheet = page.getByTestId("floating-card");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-sheet", "bottom");
  });
});
