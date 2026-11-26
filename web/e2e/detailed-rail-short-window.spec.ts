import { login } from './helpers';
import { expect, test } from './test';

/*
 * #1790: on a laptop-height window the Detailed rail cut Company in half and hid Settings, and it
 * scrolled with no scrollbar to show it.
 * protects=every rail entry at 1500x620 is inside the window or reachable with a scrollbar you can
 * see, and Company and Settings are whole without scrolling;
 * fails_when=Company or Settings is cut or hidden, or the rail scrolls with no visible scrollbar;
 * no_claim=Simple's rail and the phone tab bar.
 */

test.use({ viewport: { width: 1500, height: 620 } });

for (const scheme of ['light', 'dark'] as const) {
  test(`Detailed rail at 1500x620 (${scheme}): every entry whole or a visible scroll away`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await login(page);
    await page.goto('/documents');
    const nav = page.getByTestId('app-nav');
    await expect(nav.getByTestId('nav-settings')).toBeVisible();

    const inWindow = async (id: string) =>
      nav.getByTestId(id).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
      });
    // Company and Settings are whole, with no scrolling at all.
    expect(await inWindow('nav-company')).toBe(true);
    expect(await inWindow('nav-settings')).toBe(true);
    await expect(nav.getByTestId('user-menu')).toBeInViewport({ ratio: 1 });

    const ids = await nav
      .locator('a[data-testid^="nav-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
    expect(ids.length).toBeGreaterThan(9);
    for (const id of ids) {
      if (await inWindow(id)) continue;
      // Not whole in the window: its scroller shows a scrollbar, and scrolling it brings it in.
      const shown = await nav.getByTestId(id).evaluate((el) => {
        let box = el.parentElement;
        while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
        if (!box) return false;
        const css = getComputedStyle(box);
        const bar = box.offsetWidth - box.clientWidth - parseFloat(css.borderLeftWidth) * 2;
        return bar > 0 && css.overflowY !== 'hidden';
      });
      expect(shown, `${id} is out of sight with no visible scrollbar`).toBe(true);
      await nav.getByTestId(id).scrollIntoViewIfNeeded();
      expect(await inWindow(id), `${id} scrolled into the window`).toBe(true);
    }
  });
}
