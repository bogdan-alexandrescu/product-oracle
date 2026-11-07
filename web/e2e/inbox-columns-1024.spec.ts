import { expect, test, type Page } from "./test";

import { login } from "./helpers";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";

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
    // Text a button, link or field in the row's action cell draws over: no action control sits on a word of the row.
    const covered: string[] = [];
    const hits = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const row of rows) {
      const act = row.querySelector<HTMLElement>("td:last-child");
      if (!act) continue;
      const controls = [...act.querySelectorAll<HTMLElement>("button, a[href], select, input, textarea, [role=button]")].filter((c) => c.checkVisibility() && c.getClientRects().length > 0);
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.data.trim() || !node.parentElement?.checkVisibility() || node.parentElement.closest(".sr-only")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = [...range.getClientRects()].filter((t) => t.width > 0 && t.height > 0);
        for (const c of controls) {
          if (c.contains(node)) continue;
          const box = c.getBoundingClientRect();
          if (text.some((t) => hits(t, box))) covered.push(`"${node.data.trim().slice(0, 30)}" under "${(c.textContent ?? "").trim().slice(0, 30)}"`);
        }
      }
    }
    return { rows: rows.length, cut, split, covered, wide: document.documentElement.scrollWidth - window.innerWidth };
  });
}

async function check(page: Page, size: { width: number }, tab: string) {
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
  await expect(page.locator("[role=tabpanel] tr[data-row]").first(), `${tab}: has rows`).toBeVisible();
  const r = await readRows(page);
  expect(r.rows, `${tab}: rows drawn`).toBeGreaterThan(0);
  // At 1440 a long "For" still ends in an ellipsis whose tooltip holds the rest; narrower, nothing is cut.
  if (size.width < 1100) expect(r.cut, `${tab}: text cut`).toEqual([]);
  expect(r.split, `${tab}: words split`).toEqual([]);
  expect(r.covered, `${tab}: text under a button`).toEqual([]);
  expect(r.wide, `${tab}: page wider than the window`).toBeLessThanOrEqual(0);
}

for (const [who, email] of WHO) {
  for (const size of SIZES) {
    test(`Inbox rows for ${who} at ${size.width} read whole, with no sideways scroll`, async ({ page }) => {
      // A commenter's own row (a reminder to review a one-pager) so every person has rows on both tabs.
      await page.addInitScript((key) => localStorage.setItem(key, "inbox-commenter-rows"), MOCK_SCENARIO_KEY);
      await page.setViewportSize(size);
      await login(page, email);
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-state-tabs")).toBeVisible();
      await check(page, size, "New");
      // What was new moves to Seen on the next visit; wait until opening the Inbox has marked it seen.
      await expect(async () => {
        await page.goto("/inbox");
        await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Seen/ }).click();
        await expect(page.locator("[role=tabpanel] tr[data-row]").first()).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 20_000 });
      await check(page, size, "Seen");
    });
  }
}
