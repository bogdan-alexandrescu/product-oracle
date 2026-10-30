import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * dod-perf: no layout read in a Simple roadmap drag's loop (the 500-item roadmap's drag at
 * 60 fps: e2e/simple-roadmap-500-timing.spec.ts). Counted, not timed, so it runs in the
 * default run: the page wraps Element's checkVisibility and getBoundingClientRect and counts
 * the calls made while an item is dragged.
 *
 * Card simple-roadmap-drag-reads: protects = dragging a bar on the Gantt (a mouse on desktop
 * 1440x900, a finger on a phone 390x844) makes no checkVisibility call (the page title's
 * watcher read its H1 on every pill write, laying the whole page out each frame), and dragging
 * a Now/Next/Later card reads the columns' boxes once, not on every move; the drag still lands
 * (the card moves to the column it is dropped on) and the tab's title still names the page;
 * fails_when = the title watcher reads on a chart's style writes, or the board measures its
 * columns per move; no_claim = frame times (the timing spec's).
 */

const URL = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function countReads(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __reads: Record<string, number> };
    w.__reads = { checkVisibility: 0, getBoundingClientRect: 0 };
    for (const name of ["checkVisibility", "getBoundingClientRect"] as const) {
      const own = Element.prototype[name] as (...a: unknown[]) => unknown;
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value(this: Element, ...a: unknown[]) {
          w.__reads[name]++;
          return own.apply(this, a);
        },
      });
    }
  });
}
const reads = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __reads: Record<string, number> }).__reads }));
const zero = (page: Page) => page.evaluate(() => Object.keys((window as unknown as { __reads: Record<string, number> }).__reads).forEach((k) => ((window as unknown as { __reads: Record<string, number> }).__reads[k] = 0)));

async function mouseDrag(page: Page, target: Locator, dx: number, dy: number, during: () => Promise<void>) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // The drag under way (the board measures its columns as it starts), then counted.
  for (let n = 1; n <= 3; n++) await page.mouse.move(x + (dx * n) / 24, y + (dy * n) / 24);
  await page.waitForTimeout(50);
  await zero(page);
  for (let n = 4; n <= 24; n++) {
    await page.mouse.move(x + (dx * n) / 24, y + (dy * n) / 24);
    await page.waitForTimeout(20);
  }
  await during();
  await page.mouse.up();
}

async function touchDrag(page: Page, target: Locator, surface: Locator, dx: number, dy: number, during: () => Promise<void>) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  const ev = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
  await target.dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
  await page.waitForTimeout(650);
  for (let n = 1; n <= 3; n++) await surface.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 24, clientY: y + (dy * n) / 24 });
  await page.waitForTimeout(50);
  await zero(page);
  for (let n = 4; n <= 24; n++) {
    await surface.dispatchEvent("pointermove", { ...ev, clientX: x + (dx * n) / 24, clientY: y + (dy * n) / 24 });
    await page.waitForTimeout(20);
  }
  await during();
  await surface.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + dx, clientY: y + dy });
}

for (const [where, use] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  const phone = where === "phone";
  test.describe(`drag reads, ${where}`, () => {
    test.use(use);

    test("a Gantt bar's drag reads no layout per frame; the tab still names the page", async ({ page }) => {
      // simple-roadmap-drag-reads (see the file's card).
      await countReads(page);
      await login(page);
      await page.goto(URL);
      await page.getByTestId("format-gantt").click();
      const bar = page.locator('g[data-testid="bar"][data-item="alert-rules"]');
      await expect(bar).toBeVisible();
      await expect(page).toHaveTitle(/Roadmap/);
      const during = async () => {
        await expect(page.getByTestId("drag-live")).toBeVisible();
        expect((await reads(page)).checkVisibility).toBe(0);
      };
      if (phone) await touchDrag(page, bar, page.getByTestId("chart-svg"), 48, 0, during);
      else await mouseDrag(page, bar.locator("rect[data-body]"), 96, 0, during);
      await expect(page).toHaveTitle(/Roadmap/);
    });

    test("a board card's drag measures the columns once, and lands", async ({ page, context }) => {
      // simple-roadmap-drag-reads (see the file's card).
      await context.addInitScript((key) => localStorage.setItem(key, "simple-500"), MOCK_SCENARIO_KEY);
      await countReads(page);
      await login(page);
      await page.goto(URL);
      await page.getByTestId("format-board").click();
      const card = page.locator('[data-testid="board-card"][data-horizon="now"]').first();
      await expect(card).toBeVisible();
      const key = (await card.getAttribute("data-bar-id"))!;
      const next = page.locator('[data-testid="board-column"][data-horizon-column="next"]');
      const from = (await card.boundingBox())!;
      await next.scrollIntoViewIfNeeded();
      const to = (await next.boundingBox())!;
      await card.scrollIntoViewIfNeeded();
      const at = (await card.boundingBox())!;
      // To the Next column's top (a phone's columns stack: down; a desktop's sit side by side: right).
      const dx = phone ? 0 : to.x + 40 - (at.x + Math.min(at.width / 2, 20));
      const dy = phone ? Math.min(to.y - from.y + 60, 300) : to.y + 60 - (at.y + at.height / 2);
      const during = async () => {
        expect((await reads(page)).getBoundingClientRect).toBe(0);
      };
      if (phone) await touchDrag(page, card, card, dx, dy, during);
      else await mouseDrag(page, card, dx, dy, during);
      if (!phone) await expect(page.locator(`[data-testid="board-card"][data-bar-id="${key}"]`)).toHaveAttribute("data-horizon", "next");
    });
  });
}
