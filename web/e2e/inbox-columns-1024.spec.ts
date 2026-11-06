import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Inbox rows at 1024 and 390 (visual QA R-6): the middle column keeps its room, so no word is cut
 * ("new…", "Sho…") or split mid-word ("Recon nect…"), and the page never scrolls sideways.
 */

const WHO = [
  ["the owner", "admin@example.com"],
  ["an approver", "approver@example.com"],
  ["a commenter", "commenter@example.com"],
] as const;

const SIZES = [
  { width: 1024, height: 800 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function readRows(page: Page) {
  return page.evaluate(() => {
    const cut: string[] = [];
    const split: string[] = [];
    const rows = [...document.querySelectorAll<HTMLElement>("[role=tabpanel] tr[data-row]")].filter((r) => r.checkVisibility());
    for (const row of rows) {
      for (const el of row.querySelectorAll<HTMLElement>("*")) {
        if (!el.checkVisibility()) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        if (own && !el.classList.contains("sr-only") && el.scrollWidth > el.clientWidth + 1) cut.push(`${el.tagName}.${el.className} "${(el.textContent ?? "").trim().slice(0, 40)}" in cell ${(el.closest("td") as HTMLTableCellElement | null)?.cellIndex} ${el.scrollWidth}>${el.clientWidth}`);
      }
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.checkVisibility()) continue;
        for (const m of node.data.matchAll(/[^\s\-–—/·]+/g)) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
          if (tops.size > 1) split.push(m[0]);
        }
      }
    }
    return { rows: rows.length, cut, split, wide: document.documentElement.scrollWidth - window.innerWidth };
  });
}

for (const [who, email] of WHO) {
  for (const size of SIZES) {
    test(`Inbox rows for ${who} at ${size.width} read whole, with no sideways scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      await login(page, email);
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-state-tabs")).toBeVisible();
      if (email === "admin@example.com") await expect(page.locator("[role=tabpanel] tr[data-row]").first()).toBeVisible();
      for (const tab of ["New", "Seen"]) {
        await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
        const r = await readRows(page);
        if (r.rows === 0) continue;
        // At 1440 a long "For" still ends in an ellipsis whose tooltip holds the rest; narrower, nothing is cut.
        if (size.width < 1100) expect(r.cut, `${tab}: text cut`).toEqual([]);
        expect(r.split, `${tab}: words split`).toEqual([]);
        expect(r.wide, `${tab}: page wider than the window`).toBeLessThanOrEqual(0);
      }
    });
  }
}
