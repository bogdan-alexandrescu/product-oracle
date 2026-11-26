import { login } from './helpers';
import { expect, test } from './test';

/**
 * draw-time (#1870) re-review: the mock puts off a burst's saves until its last read. A read that
 * seeds a part of the stored db still saves it before it answers, so a test (or another tab) that
 * reads the stored db once the page shows finds what the read seeded.
 */

test('a read that seeds the roadmap has saved it once the page shows it', async ({ page }) => {
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  const items = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('po-mock-db-v2') ?? '{}');
    return db.simple_roadmap?.items?.length ?? null;
  });
  expect(items).toBeGreaterThan(0);
});
