import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * dod-perf review: a dragged bar moves on a layer of its own over the chart, so a drag frame
 * repaints that one bar, not the chart's other 499 (the 500-item desktop timeline and waterfall
 * drags missed 60 fps about half the time: e2e/simple-roadmap-500-timing.spec.ts). Counted, not
 * timed, so it runs in the default run: the page watches the chart's own drawing for changes
 * while an item is dragged.
 *
 * Card simple-roadmap-drag-layer: protects = while a bar is dragged on the goal-lanes timeline,
 * the Gantt and the waterfall (a mouse on desktop 1440x900, a finger on the Gantt on a phone
 * 390x844), nothing in the chart's drawing changes but the dragged bar's own dates (no shape is
 * moved, sized, recoloured, added or removed in it); the bar the person sees still follows the
 * pointer, the live dates show, and on release the bar lands on its new dates; fails_when = a
 * drag frame writes the bar's shapes inside the chart (the whole chart repaints each frame);
 * no_claim = frame times (the timing spec's).
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

/** Starts recording every change in the chart's drawing but the dragged bar's own data-* dates. */
async function watch(bar: Locator) {
  await bar.evaluate((g) => {
    const w = window as unknown as { __chartChanges: string[]; __chartWatch: MutationObserver };
    w.__chartChanges = [];
    const svg = (g as SVGGElement).ownerSVGElement!;
    w.__chartWatch = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "attributes" && m.target === g && m.attributeName?.startsWith("data-")) continue;
        w.__chartChanges.push(`${m.type} ${(m.target as Element).tagName} ${m.attributeName ?? ""}`);
      }
    });
    w.__chartWatch.observe(svg, { subtree: true, attributes: true, childList: true, characterData: true });
  });
}
const changes = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __chartChanges: string[]; __chartWatch: MutationObserver };
    w.__chartChanges.push(...w.__chartWatch.takeRecords().map((m) => `${m.type} ${(m.target as Element).tagName} ${m.attributeName ?? ""}`));
    w.__chartWatch.disconnect();
    return w.__chartChanges;
  });

async function open(page: Page, view: string) {
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  if (view !== "timeline") await page.getByTestId(`format-${view}`).click();
  const bar = page.locator('g[data-testid="bar"][data-kind="dated"]').first();
  await expect(bar).toBeVisible({ timeout: 15_000 });
  return bar;
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  const phone = where === "phone";
  test.describe(`a dragged bar on its own layer, ${where}`, () => {
    test.use(use);
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-500"), MOCK_SCENARIO_KEY);
      await login(page);
    });

    // The Timeline is no svg chart: its own case below reads its rows.
    for (const view of phone ? ["gantt"] : ["gantt", "waterfall"]) {
      test(`${view}: a drag frame leaves the chart's other bars alone`, async ({ page }) => {
        // simple-roadmap-drag-layer (see the file's card).
        const bar = await open(page, view);
        const id = await bar.getAttribute("data-bar-id");
        const was = await bar.getAttribute("data-start");
        const body = bar.locator("rect[data-body]");
        await body.scrollIntoViewIfNeeded();
        const box = (await body.boundingBox())!;
        const x = box.x + Math.min(box.width / 2, 20);
        const y = box.y + box.height / 2;
        const dx = phone ? 60 : 160;
        const ev = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
        const surface = page.getByTestId("chart-svg");
        const move = async (n: number) => {
          if (phone) await surface.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 24, clientY: y });
          else await page.mouse.move(x + (dx * n) / 24, y);
        };
        if (phone) {
          await bar.dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
          await page.waitForTimeout(650);
        } else {
          await page.mouse.move(x, y);
          await page.mouse.down();
        }
        // The drag under way (the bar is picked up), then watched.
        for (let n = 1; n <= 3; n++) await move(n);
        await page.waitForTimeout(50);
        await watch(bar);
        for (let n = 4; n <= 24; n++) {
          await move(n);
          await page.waitForTimeout(20);
        }
        // The person sees the bar's new dates as it moves.
        await expect(page.getByTestId("drag-live")).toBeVisible();
        await expect(page.getByTestId("drag-live")).toContainText("–");
        expect(await changes(page)).toEqual([]);
        if (phone) await surface.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + dx, clientY: y });
        else await page.mouse.up();
        // Released: the bar lands on its new dates, drawn in the chart again.
        const landed = page.locator(`g[data-testid="bar"][data-bar-id="${id}"]`);
        await expect(landed).not.toHaveAttribute("data-start", was!);
        await expect(landed).toBeVisible();
        await expect(page.getByTestId("drag-live")).toBeHidden();
      });
    }
  });
}

/**
 * roadmap-r2 review: the picked Timeline (build-roadmap) is rows of HTML bars, not the old svg
 * chart, and its bars move by drag (roadmap-r2). A drag frame there changes the dragged item's
 * own row only (its bar, its dates, the live words); no other row of the 500 is written.
 */
test.describe("a dragged Timeline bar, desktop", () => {
  test.use(DESKTOP);
  test.beforeEach(async ({ context, page }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-500"), MOCK_SCENARIO_KEY);
    await login(page);
  });

  test("timeline: a drag frame leaves the other rows alone", async ({ page }) => {
    await page.goto(URL);
    await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
    const chart = page.getByTestId("simple-chart");
    await expect(chart).toHaveAttribute("data-format", "timeline");
    // A bar that moves (a grab cursor), in sight.
    const bar = chart.locator('[data-testid="timeline-bar"].cursor-grab').first();
    await expect(bar).toBeVisible({ timeout: 15_000 });
    const id = await bar.getAttribute("data-bar-id");
    const was = await bar.getAttribute("data-start");
    const box = (await bar.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const dx = 160;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let n = 1; n <= 3; n++) await page.mouse.move(x + (dx * n) / 24, y);
    await page.waitForTimeout(50);
    await bar.evaluate((b) => {
      const w = window as unknown as { __rowChanges: string[]; __rowWatch: MutationObserver };
      const row = b.closest('[data-testid="timeline-row"]')!;
      const root = b.closest('[data-testid="simple-chart"]')!;
      w.__rowChanges = [];
      w.__rowWatch = new MutationObserver((ms) => {
        for (const m of ms) if (!row.contains(m.target)) w.__rowChanges.push(`${m.type} ${(m.target as Element).tagName ?? "#text"} ${m.attributeName ?? ""}`);
      });
      w.__rowWatch.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    for (let n = 4; n <= 24; n++) {
      await page.mouse.move(x + (dx * n) / 24, y);
      await page.waitForTimeout(20);
    }
    await expect(page.getByTestId("drag-live")).toContainText("–");
    const changed = await page.evaluate(() => {
      const w = window as unknown as { __rowChanges: string[]; __rowWatch: MutationObserver };
      w.__rowWatch.disconnect();
      return w.__rowChanges;
    });
    expect(changed).toEqual([]);
    await page.mouse.up();
    // Released: the bar lands on its new dates.
    await expect(chart.locator(`[data-testid="timeline-bar"][data-bar-id="${id}"]`)).not.toHaveAttribute("data-start", was!);
    await expect(page.getByTestId("drag-live")).toBeHidden();
  });
});
