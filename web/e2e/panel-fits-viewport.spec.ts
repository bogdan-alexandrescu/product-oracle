import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * BGD (Nov 10, Roadmap Timeline): "some modal windows are larger or taller than the viewport and
 * it doesn't allow the user to scroll down". Every floating panel fits the viewport, its body
 * scrolls inside under its header (title and close in view), and its last field and Save are
 * reached by scrolling inside it: the wheel, PageDown, Tab.
 * protects = the feature panel opened on an item low on the screen and on one near the top, on the
 * Timeline, Gantt, Now / Next / Later and Waterfall at 1440x700 and the phone at 390x664, sits inside the viewport and its
 * last control and a field's Save are reached by scrolling inside it; the Tracks sheet with many
 * tracks likewise;
 * fails_when = the card opens under a low bar and runs past the screen's foot, or grows past the
 * viewport with nothing to scroll, or PageDown / the wheel over its header scrolls nothing;
 * no_claim = the panels' content (other specs).
 * Invented people and products (the mock's seed).
 */

const SIZES = [
  { name: "1440x700", phone: false, use: { viewport: { width: 1440, height: 700 } } },
  { name: "390x664", phone: true, use: { viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true } },
];

type Format = "timeline" | "gantt" | "board" | "waterfall";
const card = (page: Page) => page.getByTestId("floating-card");

/** The element's box lies inside the viewport. */
async function inViewport(page: Page, l: Locator) {
  const vp = page.viewportSize()!;
  const b = (await l.boundingBox())!;
  expect(b, "on screen").not.toBeNull();
  expect(b.y).toBeGreaterThanOrEqual(-0.5);
  expect(b.x).toBeGreaterThanOrEqual(-0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
}

/** Scrolls inside `over` until `target` is in the viewport (a person scrolling inside the panel):
 * the wheel on a desktop, a finger's swipe up on a phone. */
async function wheelTo(page: Page, over: Locator, target: Locator) {
  const b = (await over.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = Math.min(b.y + b.height, page.viewportSize()!.height) - 30;
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  const cdp = touch ? await page.context().newCDPSession(page) : null;
  if (!touch) await page.mouse.move(x, b.y + Math.min(b.height - 8, 80));
  for (let n = 0; n < 40 && !(await fullyIn(page, target)); n++) {
    if (cdp) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 20 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else await page.mouse.wheel(0, 200);
  }
  await cdp?.detach();
}

async function fullyIn(page: Page, l: Locator): Promise<boolean> {
  const vp = page.viewportSize()!;
  const b = await l.boundingBox();
  return !!b && b.y >= 0 && b.y + b.height <= vp.height;
}

/** The page does not scroll behind the panel. */
const pageY = (page: Page) => page.evaluate(() => window.scrollY);

/** Opens the item `at` ("low": its bar near the screen's foot; "top": the first item) on the roadmap. */
async function openAt(page: Page, at: "low" | "top", format: Format) {
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  if (format !== "timeline") await page.getByTestId(`format-${format}`).click();
  const bars =
    format === "timeline"
      ? page.locator('[data-testid="timeline-row"] [data-testid="timeline-bar"]')
      : format === "board"
        ? page.getByTestId("board-card")
        : page.getByTestId("simple-chart").locator("[data-bar-id]");
  await expect(bars.first()).toBeVisible();
  const n = await bars.count();
  const bar = at === "top" ? bars.first() : bars.nth(Math.max(0, Math.floor(n * 0.6)));
  if (at === "low") {
    // A person scrolls the page until the bar sits near the screen's foot.
    await bar.evaluate((el) => el.scrollIntoView({ block: "end" }));
    await page.mouse.wheel(0, -40);
  } else await bar.scrollIntoViewIfNeeded();
  await bar.click();
  await expect(card(page)).toBeVisible();
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);
    const formats = size.phone ? (["timeline"] as const) : (["timeline", "gantt", "board", "waterfall"] as const);
    for (const format of formats)
      for (const at of ["low", "top"] as const) {
        test(`the feature panel opened on a ${format} item ${at === "low" ? "low on the screen" : "near the top"} fits and scrolls inside`, async ({ page }) => {
          await openAt(page, at, format);
          const panel = card(page);
          // Placed and sized inside the viewport, its header with the title and close in view.
          await expect.poll(() => fullyIn(page, panel)).toBe(true);
          await inViewport(page, panel);
          const close = panel.getByRole("button", { name: "Close", exact: true });
          await inViewport(page, close);
          await inViewport(page, panel.getByTestId("card-name"));
          const y = await pageY(page);

          // The wheel inside the panel reaches its last control; the header stays in view.
          const last = panel.locator("button:visible, a:visible, select:visible").last();
          await wheelTo(page, panel, last);
          await inViewport(page, last);
          await inViewport(page, close);
          await inViewport(page, panel);
          expect(await pageY(page)).toBe(y);

          // A field low in the panel opens and its Save is reached by scrolling inside it.
          const change = panel.getByRole("button", { name: /^Change the / }).last();
          await wheelTo(page, panel, change);
          await change.click();
          const save = panel.getByRole("button", { name: "Save", exact: true }).last();
          await wheelTo(page, panel, save);
          await inViewport(page, save);
          await inViewport(page, panel);
          await panel.getByRole("button", { name: "Cancel", exact: true }).last().click();

          if (!size.phone) {
            // Keyboard: back to the head with Home on the panel, then PageDown to its foot.
            await panel.focus();
            await page.keyboard.press("Home");
            await inViewport(page, panel.getByTestId("card-name"));
            for (let n = 0; n < 12 && !(await fullyIn(page, last)); n++) await page.keyboard.press("PageDown");
            await inViewport(page, last);
            // The wheel over the header scrolls the body too, never the page behind.
            await page.keyboard.press("Home");
            const head = (await panel.getByTestId("card-name").boundingBox())!;
            await page.mouse.move(head.x + 10, head.y + 4);
            for (let n = 0; n < 20 && !(await fullyIn(page, last)); n++) await page.mouse.wheel(0, 300);
            await inViewport(page, last);
            expect(await pageY(page)).toBe(y);
          }
          // Tab to the panel's last control brings it in view.
          await last.focus();
          await inViewport(page, last);
          await inViewport(page, panel);
        });
      }

    test("the Tracks sheet with many tracks fits and scrolls inside", async ({ page }) => {
      await login(page, ADMIN.email);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await page.getByTestId("tracks-open").click();
      const sheet = page.getByTestId("tracks-sheet").getByRole("dialog");
      await expect(sheet).toBeVisible();
      for (const name of ["Garden club track", "Bike repair track", "Tea tasting track", "Pottery track", "Chess track", "Choir track", "Kite track", "Bread track", "Map track", "Knitting track"]) {
        await sheet.getByTestId("track-add").click();
        await sheet.getByLabel("New track name").fill(name);
        await sheet.getByLabel("New track PRD").selectOption({ label: "No PRD" });
        await sheet.getByRole("button", { name: "Add", exact: true }).click();
        await expect(sheet.getByTestId("track-row").filter({ hasText: name })).toHaveCount(1);
      }
      await inViewport(page, sheet);
      const close = page.getByRole("button", { name: "Close Tracks" });
      const rows = sheet.getByTestId("track-row");
      const lastRow = rows.last();
      await expect.poll(() => fullyIn(page, lastRow)).toBe(false);
      const y = await pageY(page);

      // The wheel inside the sheet reaches its last track, the title and close in view.
      await wheelTo(page, sheet, lastRow);
      await inViewport(page, lastRow);
      await inViewport(page, close);
      await inViewport(page, sheet);
      // Its fields open, and the last of them is reached inside the sheet.
      await lastRow.getByRole("button", { name: /^Change / }).click();
      const trash = lastRow.getByRole("button", { name: "Move to Trash" });
      await wheelTo(page, sheet, trash);
      await inViewport(page, trash);
      await inViewport(page, sheet);
      expect(await pageY(page)).toBe(y);

      if (!size.phone) {
        // Keyboard: Home on the sheet goes back to its first track, PageDown down to the last.
        await sheet.focus();
        await page.keyboard.press("Home");
        await inViewport(page, sheet.getByTestId("track-add"));
        for (let n = 0; n < 12 && !(await fullyIn(page, trash)); n++) await page.keyboard.press("PageDown");
        await inViewport(page, trash);
        // The wheel over its title scrolls its tracks.
        await page.keyboard.press("Home");
        const title = (await sheet.getByRole("heading", { name: "Tracks" }).boundingBox())!;
        await page.mouse.move(title.x + 10, title.y + 4);
        for (let n = 0; n < 20 && !(await fullyIn(page, trash)); n++) await page.mouse.wheel(0, 300);
        await inViewport(page, trash);
        expect(await pageY(page)).toBe(y);
      }
    });
  });
}
