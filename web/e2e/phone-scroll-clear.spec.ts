import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Phone bars and scrolling (waterfall-phone review): on a phone, Simple and Detailed alike,
 * whatever scrolls into view stops clear of the fixed tab bar and the sticky top bar, so a
 * finger's tap on it reaches it; the two bars and the page's scroll padding take their
 * heights from one pair of tokens (--phone-top-bar, --phone-tab-bar in globals.css).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

/** Scroll the page with the wheel until `el`'s top sits 30 px above the screen's bottom: under the tab bar. */
async function scrollUnderTabBar(page: Page, el: Locator) {
  const vh = page.viewportSize()!.height;
  await expect
    .poll(async () => {
      const box = (await el.boundingBox())!;
      const off = box.y - (vh - 30);
      if (Math.abs(off) > 1) await page.mouse.wheel(0, off);
      return Math.abs(off) <= 1;
    })
    .toBe(true);
}

/** A finger's tap at the middle of `el`, through Chromium's DevTools protocol. */
async function fingerTap(page: Page, el: Locator) {
  const box = (await el.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`phone, ${scheme}`, () => {
    test.use({ ...PHONE, colorScheme: scheme });

    /**
     * Card phone-scroll-clear-detailed: protects = in Detailed on a phone a link scrolled
     * into view sits above the fixed tab bar, so a finger's tap opens it; fails_when = the
     * tab bar still covers it (the tap lands on a tab); no_claim = native scrolling.
     */
    test("Detailed: a link scrolled into view clears the tab bar, and a tap opens it", async ({ page }) => {
      await login(page);
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-approvals")).toBeVisible();
      const link = page.getByRole("main").locator('a[href^="/"]').filter({ visible: true }).last();
      const href = (await link.getAttribute("href"))!;
      await scrollUnderTabBar(page, link);
      await link.scrollIntoViewIfNeeded();
      const tabs = (await page.getByTestId("tab-bar").boundingBox())!;
      const box = (await link.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(tabs.y);
      await fingerTap(page, link);
      await expect(page).toHaveURL((u) => u.pathname + u.search === href);
    });

    /**
     * Card phone-bar-tokens: protects = the top bar, the tab bar and the scroll padding share
     * one measure in Simple and Detailed; fails_when = a bar's height or the padding is set on
     * its own; no_claim = the bars' look.
     */
    test("the phone bars and the scroll padding share one measure, Simple and Detailed", async ({ page }) => {
      await login(page);
      for (const [path, tabBar] of [
        ["/inbox", "tab-bar"],
        ["/simple/roadmap", "simple-tab-bar"],
      ] as const) {
        await page.goto(path);
        await expect(page.getByTestId(tabBar)).toBeVisible();
        const m = await page.evaluate((id) => {
          const root = getComputedStyle(document.documentElement);
          const h = (t: string) => document.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect().height;
          return {
            top: root.getPropertyValue("--phone-top-bar").trim(),
            tab: root.getPropertyValue("--phone-tab-bar").trim(),
            padTop: root.scrollPaddingTop,
            padBottom: root.scrollPaddingBottom,
            header: h("phone-header"),
            tabs: h(id),
          };
        }, tabBar);
        expect(m.top).not.toBe("");
        expect(m.tab).toBe("68px");
        expect(m.tabs).toBe(68);
        expect(m.padBottom).toBe("68px");
        expect(m.padTop).toBe(`${m.header}px`);
      }
    });
  });
}
