import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * roadmap-r2 (the owner's answer, Nov 1): the Timeline's bars move as the Gantt's do. A
 * drag moves a bar, a drag of an end changes its start or end, the arrow keys move a
 * focused bar a week (Shift: a month); each move is one change through the engine, with
 * the Gantt's Undo; a viewer's bars do not move; a short drag is a click. Driven through
 * the UI against the mock (web/lib/api/mock/simple-changes.ts).
 */

const URL = "/simple/roadmap";

const bar = (page: Page, key: string): Locator => page.locator(`[data-testid="timeline-row"][data-item="${key}"] [data-testid="timeline-bar"]`);

const plus = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plusMonth = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(d.getUTCDate(), last))).toISOString().slice(0, 10);
};
/** "Oct 31", as the page writes a day. */
const words = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("zoom-timeline")).toBeVisible();
  await expect(bar(page, "alert-export")).toBeVisible();
}

/** Drags with the mouse from `fx` (0..1 across the bar) by `dx` pixels. */
async function drag(page: Page, l: Locator, dx: number, fx = 0.5) {
  await l.scrollIntoViewIfNeeded();
  const box = (await l.boundingBox())!;
  const x = box.x + box.width * fx;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

const span = async (l: Locator) => [(await l.getAttribute("data-start"))!, (await l.getAttribute("data-end"))!] as const;

for (const width of [1440, 1024]) {
  test.describe(`desktop ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a drag moves a Timeline bar; the dates show on the bar, in the side panel and after a reload; Undo puts it back", async ({ page }) => {
      await open(page);
      const b = bar(page, "alert-export");
      const [s0, e0] = await span(b);
      await expect(b).toHaveCSS("cursor", "grab");
      await drag(page, b, 120);
      await expect(page.getByText(/Moved 'Alert history export' to .* in your working draft/)).toBeVisible();
      await expect(b).not.toHaveAttribute("data-start", s0);
      const [s1, e1] = await span(b);
      // A move keeps its length.
      expect(Date.parse(e1) - Date.parse(s1)).toBe(Date.parse(e0) - Date.parse(s0));
      expect(s1 > s0).toBe(true);
      await expect(b).toHaveAttribute("aria-label", new RegExp(`${words(s1)}.*${words(e1)}`));
      await b.click();
      await expect(page.getByTestId("item-panel").getByTestId("card-dates")).toContainText(words(s1));
      await page.reload();
      await expect(bar(page, "alert-export")).toHaveAttribute("data-start", s1);
      await expect(bar(page, "alert-export")).toHaveAttribute("data-end", e1);
      // Undo, as the Gantt's: the working draft's last change goes.
      await page.getByTestId("draft-banner").getByRole("button", { name: "Undo" }).click();
      await expect(bar(page, "alert-export")).toHaveAttribute("data-start", s0);
      await expect(bar(page, "alert-export")).toHaveAttribute("data-end", e0);
    });

    test("a drag of an end changes only that end", async ({ page }) => {
      await open(page);
      const b = bar(page, "alert-digest");
      const [s0, e0] = await span(b);
      // The right end: the start stays.
      await drag(page, b, 90, 0.99);
      // The toast names the item by its feature code before its name.
      await expect(page.getByText(/Moved 'F-06 Weekly alert digest'/)).toBeVisible();
      await expect(b).not.toHaveAttribute("data-end", e0);
      await expect(b).toHaveAttribute("data-start", s0);
      const [, e1] = await span(b);
      expect(e1 > e0).toBe(true);
      // The left end: the end stays.
      await drag(page, b, -60, 0.01);
      await expect(b).not.toHaveAttribute("data-start", s0);
      await expect(b).toHaveAttribute("data-end", e1);
      expect((await span(b))[0] < s0).toBe(true);
    });

    test("the arrow keys move a focused bar a week, Shift a month; a short drag is a click", async ({ page }) => {
      await open(page);
      const b = bar(page, "alert-export");
      const [s0, e0] = await span(b);
      // A drag shorter than the threshold is a click: the side panel opens, nothing moves.
      await drag(page, b, 2);
      await expect(page.getByTestId("item-panel")).toBeVisible();
      await expect(b).toHaveAttribute("data-start", s0);
      await expect(page.getByTestId("draft-banner")).toHaveCount(0);
      await b.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200);
      await expect(b).toHaveAttribute("data-start", plus(s0, 7));
      await expect(b).toHaveAttribute("data-end", plus(e0, 7));
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await b.focus();
      await page.keyboard.press("Shift+ArrowRight");
      await page.waitForTimeout(1200);
      const s2 = plusMonth(plus(s0, 7));
      await expect(b).toHaveAttribute("data-start", s2);
      await expect(b).toHaveAttribute("data-end", plus(e0, 7 + (Date.parse(s2) - Date.parse(plus(s0, 7))) / 86_400_000));
      await expect(page.getByTestId("draft-count")).toHaveText("2");
    });

    // R2_SHOTS=<dir> saves a drag in progress and its result (the PR's pictures).
    test("a drag in progress shows its dates live", async ({ page }) => {
      await open(page);
      const b = bar(page, "alert-mobile");
      await b.scrollIntoViewIfNeeded();
      const box = (await b.boundingBox())!;
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80, y, { steps: 8 });
      await expect(page.getByTestId("drag-live")).toBeVisible();
      await expect(page.getByTestId("drag-live")).toContainText(" – ");
      const dir = process.env.R2_SHOTS;
      if (dir) await page.screenshot({ path: `${dir}/timeline-drag-${width}-during.png` });
      await page.mouse.up();
      await expect(page.getByText(/Moved 'Mobile alert push'/)).toBeVisible();
      await expect(page.getByTestId("drag-live")).toHaveCount(0);
      if (dir) await page.screenshot({ path: `${dir}/timeline-drag-${width}-after.png` });
    });

    test("a viewer's bars do not move", async ({ page }) => {
      await open(page, "viewer@example.com");
      const b = bar(page, "alert-export");
      const [s0, e0] = await span(b);
      await expect(b).toHaveCSS("cursor", "pointer");
      await drag(page, b, 120);
      await b.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200);
      await expect(b).toHaveAttribute("data-start", s0);
      await expect(b).toHaveAttribute("data-end", e0);
      await expect(page.getByTestId("draft-banner")).toHaveCount(0);
      await expect(page.getByText(/Moved 'Alert history export'/)).toHaveCount(0);
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the list by quarter does not drag", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("timeline-list")).toBeVisible();
    await expect(bar(page, "alert-export")).not.toHaveAttribute("data-start", /./);
  });
});

/** roadmap-r2 review: a cancelled drag, a finger on a touch tablet, and the keys a bar names. */
test.describe("roadmap-r2 review", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a drag the browser cancels moves nothing, and the next click on a bar still opens it", async ({ page }) => {
    await open(page);
    const b = bar(page, "alert-export");
    await b.scrollIntoViewIfNeeded();
    const [s0] = await span(b);
    const box = (await b.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const ev = { pointerId: 7, pointerType: "mouse", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
    await b.dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
    for (const n of [10, 30, 60]) await b.dispatchEvent("pointermove", { ...ev, clientX: x + n, clientY: y });
    await expect(page.getByTestId("drag-live")).toBeVisible();
    await b.dispatchEvent("pointercancel", { ...ev, buttons: 0, clientX: x + 60, clientY: y });
    await expect(page.getByTestId("drag-live")).toBeHidden();
    await expect(b).toHaveAttribute("data-start", s0);
    // No click followed the cancel: the next one is the person's and opens the item.
    await b.click();
    await expect(page.getByTestId("item-panel")).toBeVisible();
  });

  test("a movable bar names its keys", async ({ page }) => {
    await open(page);
    await expect(bar(page, "alert-export")).toHaveAttribute("aria-label", /Arrows move it a week, Shift\+arrows a month; Escape cancels$/);
  });

  test("a viewer's bar names no keys", async ({ page }) => {
    await open(page, "viewer@example.com");
    await expect(bar(page, "alert-export")).not.toHaveAttribute("aria-label", /Arrows/);
  });
});

test.describe("roadmap-r2 review, a touch tablet", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });

  test("a long press picks a Timeline bar up and a finger drags it", async ({ page }) => {
    await open(page);
    const b = bar(page, "alert-export");
    await b.scrollIntoViewIfNeeded();
    const [s0] = await span(b);
    const box = (await b.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const ev = { pointerId: 9, pointerType: "touch", isPrimary: true, bubbles: true, button: 0, buttons: 1 };
    await b.dispatchEvent("pointerdown", { ...ev, clientX: x, clientY: y });
    await page.waitForTimeout(650);
    for (let n = 1; n <= 12; n++) await b.dispatchEvent("pointermove", { ...ev, clientX: x + n * 10, clientY: y });
    await b.dispatchEvent("pointerup", { ...ev, buttons: 0, clientX: x + 120, clientY: y });
    await expect(page.getByText(/Moved 'Alert history export' to .* in your working draft/)).toBeVisible();
    await expect(b).not.toHaveAttribute("data-start", s0);
  });
});
