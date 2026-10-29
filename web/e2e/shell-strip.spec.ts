import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * Sub-tab strips (ds ScrollStrip: Settings, Plan, Company, Sources). Each test states its card:
 * protects / fails_when / no_claim.
 */

/** The scrolling element of a tab strip nav. */
const scroller = (nav: Locator) => nav.locator(".scroll-fade");

/** Each tab's box against the strip's clear area (inside the fades); a tab is cut if it straddles an edge. */
async function cutTabs(nav: Locator) {
  return scroller(nav).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const cutL = el.hasAttribute("data-more-left") ? parseFloat(el.style.getPropertyValue("--cut-l")) || 0 : 0;
    const cutR = el.hasAttribute("data-more-right") ? parseFloat(el.style.getPropertyValue("--cut-r")) || 0 : 0;
    const left = box.left + cutL;
    const right = box.right - cutR;
    const cut: string[] = [];
    for (const a of el.querySelectorAll("a")) {
      const r = a.getBoundingClientRect();
      const visible = Math.min(r.right, right) - Math.max(r.left, left);
      if (visible <= 2) continue; // hidden, or only its padding in the fade
      if (r.left < left - 2 || r.right > right + 2) cut.push(`${a.textContent} [${r.left}, ${r.right}] in [${left}, ${right}]`);
    }
    // The fades hide no more than 20 px of a cut tab: its padding, never a run of letters.
    return { cut, cutL, cutR };
  });
}

async function settle(page: Page, nav: Locator) {
  let last = -1;
  await expect
    .poll(async () => {
      const now = await scroller(nav).evaluate((el) => el.scrollLeft);
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  await page.waitForTimeout(100);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const width of [1440, 1512]) {
    test(`Settings shows every tab in full at ${width} px`, async ({ page }) => {
      // protects=all 13 Settings tabs fully visible on a desktop (qa-settings-10); fails_when=a tab
      // runs past the strip or the viewport, or the strip needs its chevrons; no_claim=phone layout.
      await page.setViewportSize({ width, height: 900 });
      await login(page);
      await page.goto("/settings/members");
      const nav = page.getByRole("navigation", { name: "Settings" }).filter({ visible: true });
      await expect(nav.getByTestId("nav-trash")).toBeVisible();
      await page.waitForTimeout(300);
      const strip = (await scroller(nav).boundingBox())!;
      const links = await nav.getByRole("link").all();
      expect(links.length).toBeGreaterThanOrEqual(13);
      for (const link of links) {
        const b = (await link.boundingBox())!;
        const name = (await link.textContent()) ?? "";
        expect(b.x, name).toBeGreaterThanOrEqual(Math.max(0, strip.x) - 0.5);
        expect(b.x + b.width, name).toBeLessThanOrEqual(Math.min(width, strip.x + strip.width) + 0.5);
        expect(b.y, name).toBeGreaterThanOrEqual(strip.y - 0.5);
        expect(b.y + b.height, name).toBeLessThanOrEqual(strip.y + strip.height + 0.5);
      }
      await expect(nav.getByTestId("strip-more-right")).toHaveCount(0);
      await expect(scroller(nav)).toHaveCSS("scrollbar-width", "none");
    });
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Company's strip: named, focusable chevrons page it by whole tabs", async ({ page }) => {
    // protects=the chevrons are buttons named Scroll tabs left/right, reachable by keyboard, and
    // paging leaves no tab cut mid-word at an edge; all six tabs reachable (qa-company-32,
    // qa-shell-11, qa-shell-13); fails_when=a chevron is aria-hidden/untabbable/unnamed, or a tab
    // is cut by the strip's edge after paging; no_claim=the fade's exact look.
    await login(page);
    await page.goto("/company/strategy");
    const nav = page.getByRole("navigation", { name: "Company" }).filter({ visible: true });
    await expect(nav.getByTestId("company-tab-strategy")).toHaveAttribute("aria-current", "page");
    const right = nav.getByRole("button", { name: "Scroll tabs right" });
    const left = nav.getByRole("button", { name: "Scroll tabs left" });
    await expect(right).toBeVisible();
    await expect(right).toHaveAttribute("data-testid", "strip-more-right");
    await expect(left).toHaveAttribute("data-testid", "strip-more-left");
    for (const b of [left, right]) {
      await expect(b).not.toHaveAttribute("aria-hidden");
      await expect(b).not.toHaveAttribute("tabindex", "-1");
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
    await expect(scroller(nav)).toHaveCSS("scrollbar-width", "none");
    await settle(page, nav);
    expect((await cutTabs(nav)).cut).toEqual([]);

    // The left chevron sits beside the strip, not over its first tab.
    const strip = (await scroller(nav).boundingBox())!;
    const lb = (await left.boundingBox())!;
    expect(lb.x + lb.width).toBeLessThanOrEqual(strip.x + 0.5);

    // Keyboard: focus the right chevron and page with Enter until the end.
    await right.focus();
    await expect(right).toBeFocused();
    for (let i = 0; i < 6 && (await scroller(nav).getAttribute("data-more-right")) !== null; i++) {
      await page.keyboard.press("Enter");
      await settle(page, nav);
      expect((await cutTabs(nav)).cut, `after page ${i + 1}`).toEqual([]);
    }
    await expect(right).toBeFocused();
    await expect(scroller(nav)).not.toHaveAttribute("data-more-right");
    await expect(nav.getByTestId("company-tab-market")).toBeInViewport({ ratio: 1 });

    // And back with the left chevron (a click this time).
    await left.click();
    await settle(page, nav);
    expect((await cutTabs(nav)).cut).toEqual([]);
  });

  // qa-settings-41: Settings on a phone is a page picker, not a strip (fix2-shell.spec.ts).
  for (const [path, label] of [["/plan", "Plan"]] as const) {
    test(`${path}: the ${label} strip shows whole tab names only`, async ({ page }) => {
      // protects=no tab is cut mid-word under the fade or a chevron on a phone; overflowing
      // strips have named chevrons (qa-plan-62, qa-work-15, qa-work-48); fails_when=a tab
      // straddles the strip's edge after paging; no_claim=which tabs fit without scrolling.
      await login(page);
      await page.goto(path);
      const nav = page.getByRole("navigation", { name: label }).filter({ visible: true });
      await expect(nav.getByRole("link").first()).toBeVisible();
      await page.waitForTimeout(300);
      if ((await nav.locator("[data-wrap]").count()) > 0) {
        // A wrapping strip (the Plan's, qa-plan-4): no chevrons, every tab whole on screen.
        await expect(nav.getByRole("button", { name: /^Scroll tabs/ })).toHaveCount(0);
        for (const link of await nav.getByRole("link").all()) await expect(link).toBeInViewport({ ratio: 1 });
        return;
      }
      await settle(page, nav);
      await expect(scroller(nav)).toHaveCSS("scrollbar-width", "none");
      expect((await cutTabs(nav)).cut).toEqual([]);
      const right = nav.getByRole("button", { name: "Scroll tabs right" });
      if ((await right.count()) === 0) {
        // Everything fits: every tab in full inside the strip.
        const strip = (await scroller(nav).boundingBox())!;
        for (const link of await nav.getByRole("link").all()) {
          const b = (await link.boundingBox())!;
          expect(b.x).toBeGreaterThanOrEqual(strip.x - 0.5);
          expect(b.x + b.width).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
        }
        return;
      }
      await expect(right).not.toHaveAttribute("tabindex", "-1");
      for (let i = 0; i < 8 && (await scroller(nav).getAttribute("data-more-right")) !== null; i++) {
        await right.click();
        await settle(page, nav);
        expect((await cutTabs(nav)).cut, `after page ${i + 1}`).toEqual([]);
      }
      await expect(scroller(nav)).not.toHaveAttribute("data-more-right");
    });
  }
});

test.describe("phone, a strip that is not tabs", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("its chevrons say Scroll left and Scroll right, not tabs", async ({ page }) => {
    // protects=the chevrons' names fit what the strip holds (fix-shell review); fails_when=a strip
    // of plain items calls its chevrons "Scroll tabs right"; no_claim=paging (tested above).
    await login(page);
    await page.goto("/design");
    const strip = page.getByTestId("design-scroll-strip");
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip.getByRole("button", { name: "Scroll right", exact: true })).toBeVisible();
    await expect(strip.getByRole("button", { name: /tabs/ })).toHaveCount(0);
  });
});
