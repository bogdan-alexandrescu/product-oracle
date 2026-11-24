// MOCK-HOOK: mk-undo round 3: the static UT2/UT3 frames get this round's changes to built text: the draft banner's
// Undo names its scope (Undo whole draft), and UT3 a's History no longer repeats a proposal that Decided lists.
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames');
const names = fs.readdirSync(OUT).filter((f) => /^ut[23]-.*\.html$/.test(f)).map((f) => f.replace(/\.html$/, ''))
  .filter((n) => { const h = fs.readFileSync(path.join(OUT, n + '.html'), 'utf8'); return h.includes('data-testid="draft-count"') || h.includes('proposed cutting it'); });
for (const n of names)
  test(n, async ({ page }) => {
    const file = path.join(OUT, n + '.html');
    const [w, h] = (fs.readFileSync(file, 'utf8').match(/mockup-viewport" content="(\d+)x(\d+)"/) ?? ['', '1440', '900']).slice(1).map(Number);
    await page.setViewportSize({ width: w, height: h });
    if (fs.readFileSync(file, 'utf8').includes('data-theme="dark"')) await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('file://' + file);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="draft-count"]');
      let b: Element | null = c;
      for (let i = 0; b && i < 6 && ![...b.querySelectorAll('button')].some((x) => x.textContent?.trim() === 'Undo'); i++) b = b.parentElement;
      b?.querySelectorAll('button').forEach((x) => { if (x.textContent?.trim() === 'Undo' && !x.closest('[data-testid="toasts"]')) x.textContent = 'Undo whole draft'; });
      document.querySelectorAll('[data-mk-history] li').forEach((li) => {
        if (!li.textContent?.includes('proposed cutting it')) return;
        li.remove();
        const n = [...document.querySelectorAll('[data-mk-history] > button span')].find((s) => /^· \d+$/.test(s.textContent ?? ''));
        if (n) n.textContent = `· ${Number(n.textContent!.slice(2)) - 1}`;
      });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, n + '.png') });
    fs.writeFileSync(file, '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML)));
  });
