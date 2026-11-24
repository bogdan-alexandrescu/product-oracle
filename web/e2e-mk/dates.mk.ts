// MOCK-HOOK file: reads each Goal map feature's dates from its panel, to keep the mock-up's predicted dates true.
import { test } from '@playwright/test';
import { login } from '../e2e/helpers';
test('dates', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/simple/goals');
  const chips = page.locator('[data-testid="gm-chip"]');
  await chips.first().waitFor();
  const n = await chips.count();
  for (let i = 0; i < n; i++) {
    const c = chips.nth(i);
    const name = (await c.innerText()).split('\n').slice(0, 2).join(' ');
    await c.click({ position: { x: 120, y: 10 } });
    const d = page.getByRole('dialog').last();
    await d.waitFor({ timeout: 5000 }).catch(() => {});
    const txt = await d.innerText().catch(() => '');
    const m = txt.match(/Dates\n([^\n]+)/);
    console.log('DATES', name, '|', m?.[1]);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
});
