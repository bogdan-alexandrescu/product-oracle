import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * at-followups (train AT's review of removed-tracks): at 390 px the Simple roadmap's filter row
 * holds "Removed · N", the Filters toggle and "Tracks · N" (and Group by, outside the Timeline).
 * Nothing in it overlaps another control or runs past the screen, in every format, with the
 * filters shut and open. Invented people and products (the mock's seed).
 *
 * protects = each control of the filter row is whole on a phone and apart from the others;
 * fails_when = two controls overlap, one runs past the right edge, or the row or page scrolls
 * sideways; no_claim = the desktop row (roadmap-tracks-sheet, roadmap-removed-list).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** The filter row's controls that overlap or leave the screen, by their names. */
async function clashes(page: Page): Promise<{ overlaps: string[]; outside: string[]; rowScrolls: boolean; pageScrolls: boolean }> {
  return page.getByTestId("filters").evaluate((row) => {
    const name = (el: Element) => (el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const boxes = [...row.querySelectorAll("button, select, [role='radio']")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 1 && r.height > 1);
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 1 && h > 1) overlaps.push(`${name(a.el)} / ${name(b.el)}`);
      }
    const outside = boxes.filter(({ r }) => r.left < 0 || r.right > window.innerWidth).map(({ el }) => name(el));
    return { overlaps, outside, rowScrolls: row.scrollWidth > row.clientWidth + 1, pageScrolls: document.documentElement.scrollWidth > window.innerWidth };
  });
}

test.describe("the roadmap's filter row on a phone", () => {
  test.use(PHONE);

  test("Removed, Filters and Tracks sit apart and on screen in every format, filters shut and open", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await expect(page.getByTestId("removed-open")).toHaveText(/^Removed · \d+$/);
    await expect(page.getByTestId("tracks-open")).toHaveText(/^Tracks · \d+$/);
    for (const format of ["format-timeline", "format-gantt", "format-board", "format-waterfall"]) {
      await page.getByTestId(format).click();
      for (const open of [false, true]) {
        const toggle = page.getByTestId("filters-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== String(open)) await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", String(open));
        expect(await clashes(page), `${format}, filters ${open ? "open" : "shut"}`).toEqual({ overlaps: [], outside: [], rowScrolls: false, pageScrolls: false });
      }
    }
    // Narrowed, the toggle names its count ("Filters · 1"): still apart from Removed and Tracks.
    await page.getByTestId("filters").locator("label", { hasText: /^Goal/ }).locator("select").selectOption({ index: 1 });
    await page.getByTestId("filters-toggle").click();
    await expect(page.getByTestId("filters-toggle")).toHaveText("Filters · 1");
    expect(await clashes(page), "narrowed, filters shut").toEqual({ overlaps: [], outside: [], rowScrolls: false, pageScrolls: false });
  });
});
