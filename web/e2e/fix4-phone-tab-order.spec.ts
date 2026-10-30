import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * qa-work-42: on a phone Tab goes skip link, top bar, page content, then the bottom bar.
 */

test.use({ viewport: { width: 390, height: 844 } });

test("qa-work-42: the bottom bar comes after the page in Tab order and stays at the foot", async ({ page }) => {
  await login(page);
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
  const bar = page.getByTestId("tab-bar");
  await expect(bar).toBeVisible();
  // In the DOM after the page's content.
  const after = await page.evaluate(() => {
    const main = document.querySelector("main#main")!;
    const nav = document.querySelector('[data-testid="tab-bar"]')!;
    return !!(main.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING) && !main.contains(nav);
  });
  expect(after).toBe(true);
  // Still fixed at the screen's foot.
  const box = (await bar.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  // The next stop is in the page (top bar or content), not the bottom bar.
  await page.keyboard.press("Tab");
  const inMain = await page.evaluate(() => !!document.activeElement?.closest("main#main"));
  expect(inMain).toBe(true);
  const inBar = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="tab-bar"]'));
  expect(inBar).toBe(false);
});
