import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * dod-perf: the Simple plan's performance target on the "simple-500" mock (500 invented
 * items over 12 roadmaps from 12 PRDs, 8 goals, 6 tracks, dated and undated, with
 * dependencies). Timing specs: tagged @timing, so the default run skips them (as the
 * API's pytest `timing` mark); E2E_TIMING=1 runs them, alone, after the parallel run:
 *   E2E_TIMING=1 npx playwright test --grep @timing --workers=1
 *
 * Card simple-roadmap-500-paint: protects = in every view of /simple/roadmap (goal-lanes
 * timeline, Gantt, Now/Next/Later board, waterfall and, on a phone, the timeline's lane list)
 * the items are drawn under 2 s from navigation, desktop 1440x900 and phone 390x844;
 * fails_when = a view draws its 500 items slowly (re-laying out per item, drawing rows nobody
 * sees); no_claim = a real laptop's numbers (the mock in headless Chromium, best of three
 * loads so another worker's load does not count against the chart).
 *
 * Card simple-roadmap-500-drag: protects = dragging an item on the timeline, Gantt,
 * waterfall and board keeps frames coming at 60 fps: the requestAnimationFrame deltas'
 * p95 is at or under 16.7 ms on desktop (a phone's drag is measured and reported, with no
 * missed run of frames: p95 under 2 frames); fails_when = the drag re-renders the chart or
 * reads layout per pointer move; no_claim = a real phone's GPU.
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const FRAME = 1000 / 60;

type View = "timeline" | "gantt" | "board" | "waterfall" | "list";

/** What a view draws per item. */
function itemsOf(page: Page, view: View, phone: boolean): Locator {
  if (view === "board") return page.getByTestId("board-card");
  if (view === "list") return page.getByTestId("lane-row");
  if (view === "timeline" && phone) return page.getByTestId("phone-lane");
  return page.locator('g[data-testid="bar"]');
}

/** Navigation to the view's items drawn (the first in sight), in ms. */
async function paint(page: Page, view: View, phone: boolean): Promise<number> {
  const t0 = Date.now();
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  if (view !== "timeline" && view !== "list") await page.getByTestId(`format-${view}`).click();
  if (view === "list") {
    await expect(page.getByTestId("phone-lane").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("phone-lane").first().click();
  }
  await expect(itemsOf(page, view, phone).first()).toBeVisible({ timeout: 15_000 });
  return Date.now() - t0;
}

async function bestPaint(page: Page, view: View, phone: boolean): Promise<number> {
  const paints: number[] = [];
  for (let n = 0; n < 3; n++) {
    if (n) await page.goto("about:blank");
    paints.push(await paint(page, view, phone));
    if (paints[n] < 2000) break;
  }
  console.log(`[dod-perf] ${phone ? "phone" : "desktop"} ${view}: items drawn in ${paints.join(", ")} ms`);
  return Math.min(...paints);
}

/** Starts recording requestAnimationFrame deltas in the page. */
async function recordFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __perfFrames: number[]; __perfOn: boolean };
    w.__perfFrames = [];
    w.__perfOn = true;
    let last = 0;
    const tick = (t: number) => {
      if (last) w.__perfFrames.push(t - last);
      last = t;
      if (w.__perfOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopFrames(page: Page, label: string): Promise<{ p95: number; median: number; n: number }> {
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __perfFrames: number[]; __perfOn: boolean };
    w.__perfOn = false;
    return w.__perfFrames;
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Infinity;
  const r = { p95: at(0.95), median: at(0.5), n: frames.length };
  console.log(`[dod-perf] ${label}: ${r.n} frames, median ${r.median.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, worst ${sorted.at(-1)?.toFixed(1)} ms`);
  return r;
}

/** A mouse drag of the first dated bar (or board card) sideways, a move a frame or so. */
async function mouseDrag(page: Page, target: Locator, dx: number, dy = 0) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await recordFrames(page);
  for (let n = 1; n <= 40; n++) {
    await page.mouse.move(x + (dx * n) / 40, y + (dy * n) / 40);
    await page.waitForTimeout(8);
  }
  return async () => {
    await page.mouse.up();
  };
}

/** A phone's long-press drag (touch pointer events, as a finger). */
async function touchDrag(page: Page, target: Locator, surface: Locator, dx: number, dy = 0) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  const ev = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
  await target.dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
  await page.waitForTimeout(650);
  await recordFrames(page);
  for (let n = 1; n <= 40; n++) {
    await surface.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 40, clientY: y + (dy * n) / 40 });
    await page.waitForTimeout(8);
  }
  return async () => {
    await surface.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + dx, clientY: y + dy });
  };
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  const phone = where === "phone";
  test.describe(`500 items, ${where} @timing`, () => {
    test.use(use);
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-500"), MOCK_SCENARIO_KEY);
      await login(page);
    });

    const views: View[] = phone ? ["timeline", "list", "gantt", "board", "waterfall"] : ["timeline", "gantt", "board", "waterfall"];
    for (const view of views) {
      test(`${view}: items drawn under 2 s @timing`, async ({ page }) => {
        // simple-roadmap-500-paint (see the file's cards).
        expect(await bestPaint(page, view, phone)).toBeLessThan(2000);
        if (view === "timeline" && !phone) {
          // Every one of the 500 items is on the goal lanes (none lost to drawing less).
          await expect(page.locator('[data-testid="bar"]')).toHaveCount(500);
        }
      });
    }

    const drags: View[] = phone ? ["gantt", "waterfall", "board"] : ["timeline", "gantt", "waterfall", "board"];
    for (const view of drags) {
      test(`${view}: a drag at 60 fps @timing`, async ({ page }) => {
        // simple-roadmap-500-drag (see the file's cards).
        await paint(page, view, phone);
        let end: () => Promise<void>;
        if (view === "board") {
          const card = page.locator('[data-testid="board-card"][data-horizon="now"]').first();
          end = phone ? await touchDrag(page, card, card, 0, 120) : await mouseDrag(page, card, 400, 40);
        } else {
          const bar = page.locator('g[data-testid="bar"][data-kind="dated"]').first();
          const body = bar.locator("rect[data-body]");
          end = phone ? await touchDrag(page, bar, page.getByTestId("chart-svg"), 60) : await mouseDrag(page, body, 160);
        }
        const r = await stopFrames(page, `${where} ${view} drag`);
        await end();
        expect(r.n).toBeGreaterThan(10);
        if (phone) expect(r.p95).toBeLessThan(2 * FRAME);
        else expect(r.p95).toBeLessThanOrEqual(16.7);
      });
    }
  });
}
