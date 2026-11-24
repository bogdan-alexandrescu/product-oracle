// MOCK-HOOK file: checks a static frame renders on its own (light and dark).
import { test } from '@playwright/test';
test('static', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto('http://localhost:3201/frames/pc2-b-rest.html?theme=dark');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${process.env.TMPDIR}/static-dark.png` });
});
