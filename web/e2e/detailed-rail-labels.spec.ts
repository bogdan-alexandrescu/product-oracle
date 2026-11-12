import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Detailed's left rail (owner report, Nov 12): every item's label sits centered under its
 * centered icon, line by line when it wraps ("Ground Truth"), and no label runs past the rail.
 * protects=the rail's labels at 1512 and 1280 px, light and dark, Ground Truth selected or not;
 * fails_when=a label's lines start at the item's left edge or a label overflows the rail;
 * no_claim=Simple's rail and the phone tab bar.
 */

type Item = { id: string; label: number; icon: number; box: number; left: number; right: number; width: number; padding: string };

async function measure(page: Page) {
  return page.getByTestId("app-nav").evaluate((nav) => {
    const railBox = nav.getBoundingClientRect();
    const items = Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[data-testid^="nav-"]:not([data-testid="nav-brand"])'));
    return {
      rail: { left: railBox.left, right: railBox.right },
      items: items.map((a) => {
        // The label's own text, its lines' ink: every text node of the item but the badge's.
        const range = document.createRange();
        const rects: DOMRect[] = [];
        const walk = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent?.trim() || n.parentElement?.closest("[data-testid$='-badge']")) continue;
          range.selectNodeContents(n);
          rects.push(...Array.from(range.getClientRects()));
        }
        const left = Math.min(...rects.map((r) => r.left));
        const right = Math.max(...rects.map((r) => r.right));
        const icon = a.querySelector("svg")!.getBoundingClientRect();
        const box = a.getBoundingClientRect();
        const lineCenters = rects.map((r) => r.left + r.width / 2);
        const style = getComputedStyle(a);
        return {
          id: a.dataset.testid!,
          label: (left + right) / 2,
          lines: lineCenters,
          icon: icon.left + icon.width / 2,
          box: box.left + box.width / 2,
          left,
          right,
          width: box.width,
          padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        } as Item & { lines: number[] };
      }),
    };
  });
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1512, 1280]) {
    test(`every rail label is centered under its icon and inside the rail (${width} px, ${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await login(page);
      const rail = page.getByTestId("app-nav");

      const check = async () => {
        const { rail: r, items } = await measure(page);
        expect(items.map((i) => i.id)).toContain("nav-baseline");
        for (const i of items) {
          expect(Math.abs(i.label - i.icon), `${i.id}: label vs icon`).toBeLessThanOrEqual(2);
          expect(Math.abs(i.label - i.box), `${i.id}: label vs item box`).toBeLessThanOrEqual(2);
          // Each line on its own, so a wrapped label is centered line by line.
          for (const c of i.lines) expect(Math.abs(c - i.box), `${i.id}: a line vs item box`).toBeLessThanOrEqual(2);
          expect(i.left, `${i.id}: left edge`).toBeGreaterThanOrEqual(r.left);
          expect(i.right, `${i.id}: right edge`).toBeLessThanOrEqual(r.right);
          // The same box as every other item: width and padding.
          expect(i.width, `${i.id}: width`).toBe(items[0].width);
          expect(i.padding, `${i.id}: padding`).toBe(items[0].padding);
        }
      };

      await check();
      // Selected, its highlight box is the same as any other selected item's.
      await rail.getByRole("link", { name: "Ground Truth" }).click();
      await expect(page.getByTestId("nav-baseline")).toHaveAttribute("aria-current", "page");
      await check();
    });
  }
}
