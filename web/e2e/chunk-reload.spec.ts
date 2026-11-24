import { expect, test, type Page } from './test';

// #1714: a chunk from an older deploy is gone (vite:preloadError): the app loads the new build
// once. The guard that stops a reload loop is cleared once a page has loaded, so a later deploy
// in the same tab, on the same address, reloads again; a browser that blocks storage gets no
// error thrown from the handler (and no reload loop).

const KEY = 'oracle-reloaded';

/** Fires the event Vite fires for a chunk that failed to load; resolves whether the page reloaded. */
async function staleChunk(page: Page): Promise<boolean> {
  const reloaded = page.waitForEvent('load', { timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  await page.evaluate(() => {
    setTimeout(() => window.dispatchEvent(new Event('vite:preloadError')), 0);
  });
  return reloaded;
}

test('a stale chunk reloads once per deploy, not once per tab', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('main')).toBeVisible();
  expect(await staleChunk(page)).toBe(true);
  // The new build's page loaded: the guard is cleared.
  await expect(page.getByRole('main')).toBeVisible();
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBeNull();
  // A later deploy, same tab, same address: it reloads again.
  expect(await staleChunk(page)).toBe(true);
});

test('a browser that blocks storage gets no error from the guard', async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    Object.defineProperty(window, 'sessionStorage', { get: blocked, configurable: true });
  });
  await page.goto('/home');
  await expect(page.getByRole('main')).toBeVisible();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Without storage it can not tell a loop from a first try, so it does not reload.
  expect(await staleChunk(page)).toBe(false);
  expect(errors).toEqual([]);
});
