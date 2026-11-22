import { login } from './helpers';
import { expect, test } from './test';

/*
 * #1589: one type scale. Every text a person sees on these pages is one of the scale's sizes
 * (app/globals.css, @theme: 13, 14, 15, 18, 22, 28, 34 and 44 px), on a desktop and a phone.
 */

const SCALE = [13, 14, 15, 18, 22, 28, 34, 44];
const PAGES = ['/home', '/plan', '/settings/members', '/documents/new?kind=prd'];

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`text sizes are the type scale's steps on a ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator('main').first()).toBeVisible();
      const sizes = await page.evaluate(() => {
        const seen = new Set<number>();
        for (const el of document.querySelectorAll('body *')) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
          const box = el.getBoundingClientRect();
          if (own && box.width && box.height) seen.add(parseFloat(getComputedStyle(el).fontSize));
        }
        return [...seen].sort((a, b) => a - b);
      });
      expect(
        sizes.filter((s) => !SCALE.includes(s)),
        `${path}: sizes off the scale`,
      ).toEqual([]);
    }
  });
}
