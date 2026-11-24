// MOCK-HOOK: mk-undo round 3: the static UT2/UT3 frames get this round's changes to built text: the draft banner's
// Undo names its scope (Undo whole draft), and UT3 a's History no longer repeats a proposal that Decided lists. // MOCK-HOOK
import fs from 'node:fs'; // MOCK-HOOK
import path from 'node:path'; // MOCK-HOOK
import { test } from '@playwright/test'; // MOCK-HOOK

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames'); // MOCK-HOOK
const names = fs.readdirSync(OUT).filter((f) => /^ut[23]-.*\.html$/.test(f)).map((f) => f.replace(/\.html$/, '')) // MOCK-HOOK
  .filter((n) => { const h = fs.readFileSync(path.join(OUT, n + '.html'), 'utf8'); return h.includes('data-testid="draft-count"') || h.includes('proposed cutting it'); }); // MOCK-HOOK
for (const n of names) // MOCK-HOOK
  test(n, async ({ page }) => { // MOCK-HOOK
    const file = path.join(OUT, n + '.html'); // MOCK-HOOK
    const [w, h] = (fs.readFileSync(file, 'utf8').match(/mockup-viewport" content="(\d+)x(\d+)"/) ?? ['', '1440', '900']).slice(1).map(Number); // MOCK-HOOK
    await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
    if (fs.readFileSync(file, 'utf8').includes('data-theme="dark"')) await page.emulateMedia({ colorScheme: 'dark' }); // MOCK-HOOK
    await page.goto('file://' + file); // MOCK-HOOK
    await page.waitForTimeout(700); // MOCK-HOOK
    await page.evaluate(() => { // MOCK-HOOK
      const c = document.querySelector('[data-testid="draft-count"]'); // MOCK-HOOK
      let b: Element | null = c; // MOCK-HOOK
      for (let i = 0; b && i < 6 && ![...b.querySelectorAll('button')].some((x) => x.textContent?.trim() === 'Undo'); i++) b = b.parentElement; // MOCK-HOOK
      b?.querySelectorAll('button').forEach((x) => { if (x.textContent?.trim() === 'Undo' && !x.closest('[data-testid="toasts"]')) x.textContent = 'Undo whole draft'; }); // MOCK-HOOK
      document.querySelectorAll('[data-mk-history] li').forEach((li) => { // MOCK-HOOK
        if (!li.textContent?.includes('proposed cutting it')) return; // MOCK-HOOK
        li.remove(); // MOCK-HOOK
        const n = [...document.querySelectorAll('[data-mk-history] > button span')].find((s) => /^· \d+$/.test(s.textContent ?? '')); // MOCK-HOOK
        if (n) n.textContent = `· ${Number(n.textContent!.slice(2)) - 1}`; // MOCK-HOOK
      }); // MOCK-HOOK
    }); // MOCK-HOOK
    await page.waitForTimeout(300); // MOCK-HOOK
    await page.screenshot({ path: path.join(OUT, n + '.png') }); // MOCK-HOOK
    fs.writeFileSync(file, '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML))); // MOCK-HOOK
  }); // MOCK-HOOK
