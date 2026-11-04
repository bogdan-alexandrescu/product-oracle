import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * ask-page-context: "This page" learns the page's name and what it shows without a second
 * shell. A page that streams (New PRD, New roadmap) never holds a hidden copy of the rail, the
 * user menu or the page's own panels while it loads: each is in the page exactly once, at every
 * moment after load, on a desktop and on a phone.
 */

const ONCE = ["app-nav", "user-menu", "recommendation-panel"] as const;

async function counts(page: Page) {
  return page.evaluate(
    (ids) => ids.map((id) => document.querySelectorAll(`[data-testid="${id}"]`).length),
    [...ONCE],
  );
}

/** The most of each seen at once since the page began: a watcher on every change to the document. */
function watch(page: Page) {
  return page.addInitScript((ids) => {
    const most = ids.map(() => 0);
    (window as unknown as { __most: number[] }).__most = most;
    const look = () =>
      ids.forEach((id, i) => {
        most[i] = Math.max(most[i], document.querySelectorAll(`[data-testid="${id}"]`).length);
      });
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true });
  }, [...ONCE]);
}

const most = (page: Page) => page.evaluate(() => (window as unknown as { __most: number[] }).__most);

/** Opens `url` and reads the counts as it loads and for a while after, a few times a second. */
async function seenCounts(page: Page, url: string) {
  await page.goto(url, { waitUntil: "commit" });
  const seen: number[][] = [];
  await page.waitForLoadState("domcontentloaded");
  seen.push(await counts(page));
  await page.waitForLoadState("load");
  for (let i = 0; i < 12; i++) {
    seen.push(await counts(page));
    await page.waitForTimeout(150);
  }
  return seen;
}

for (const [name, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport: size });

    for (const url of ["/documents/new", "/documents/new?kind=roadmap"]) {
      test(`${url} holds one shell and one recommendation at every moment`, async ({ page }) => {
        await login(page);
        await watch(page);
        const seen = await seenCounts(page, url);
        await expect(page.getByTestId("recommendation-panel")).toBeVisible();
        seen.push(await counts(page));
        expect(await most(page), "the most of each seen at once, as the page streamed").toEqual([1, 1, 1]);
        // Never two of any; after load, one of each.
        for (const c of seen) expect(Math.max(...c)).toBeLessThanOrEqual(1);
        expect(seen.at(-1)).toEqual([1, 1, 1]);
        // The page is still named for "This page": the tab reads its heading.
        await expect(page).toHaveTitle(/· Product Oracle$/);
      });
    }
  });
}
