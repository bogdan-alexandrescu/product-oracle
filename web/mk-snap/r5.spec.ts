// MOCK-HOOK: mk-undo round 5: the static frames not re-snapped live this round get this round's built text: the draft
// banner's button says what it does (Undo my last change, enabled while the banner counts changes), every banner on the
// pinned clock (4:15 AM), no 'in your working draft' suffix in a toast or list, and the cut names F-79 with its code. // MOCK-HOOK
import fs from 'node:fs'; // MOCK-HOOK
import path from 'node:path'; // MOCK-HOOK

import { test } from '@playwright/test'; // MOCK-HOOK

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames'); // MOCK-HOOK
const OLD = [/Undo whole draft/, / in your working draft/, /since Nov 24, 2026, (?!4:15)\d+:\d+ AM/, /Cut Weekly alert digest/]; // MOCK-HOOK
const names = fs.readdirSync(OUT).filter((f) => /^ut\d-.*\.html$/.test(f)).map((f) => f.replace(/\.html$/, '')) // MOCK-HOOK
  .filter((n) => { const h = fs.readFileSync(path.join(OUT, n + '.html'), 'utf8'); return OLD.some((r) => r.test(h)); }); // MOCK-HOOK
for (const n of names) // MOCK-HOOK
  test(n, async ({ page }) => { // MOCK-HOOK
    const file = path.join(OUT, n + '.html'); // MOCK-HOOK
    const src = fs.readFileSync(file, 'utf8'); // MOCK-HOOK
    const [w, h] = (src.match(/mockup-viewport" content="(\d+)x(\d+)"/) ?? ['', '1440', '900']).slice(1).map(Number); // MOCK-HOOK
    await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
    if (src.includes('data-theme="dark"')) await page.emulateMedia({ colorScheme: 'dark' }); // MOCK-HOOK
    await page.goto('file://' + file); // MOCK-HOOK
    await page.waitForTimeout(700); // MOCK-HOOK
    await page.evaluate(() => { // MOCK-HOOK
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); // MOCK-HOOK
      for (let t = walk.nextNode(); t; t = walk.nextNode()) { // MOCK-HOOK
        const v = t.nodeValue ?? ''; // MOCK-HOOK
        const nv = v.replace(/since Nov 24, 2026, \d+:\d+ AM/, 'since Nov 24, 2026, 4:15 AM').replace(/ in your working draft/, '').replace(/Cut Weekly alert digest/, 'Cut F-79 Weekly alert digest'); // MOCK-HOOK
        if (nv !== v) t.nodeValue = nv; // MOCK-HOOK
      } // MOCK-HOOK
      const c = document.querySelector('[data-testid="draft-count"]'); // MOCK-HOOK
      let b: Element | null = c; // MOCK-HOOK
      for (let i = 0; b && i < 6 && ![...b.querySelectorAll('button')].some((x) => /^Undo( whole draft)?$/.test(x.textContent?.trim() ?? '')); i++) b = b.parentElement; // MOCK-HOOK
      b?.querySelectorAll('button').forEach((x) => { // MOCK-HOOK
        if (!/^Undo( whole draft)?$/.test(x.textContent?.trim() ?? '') || x.closest('[data-testid="toasts"]')) return; // MOCK-HOOK
        x.textContent = 'Undo my last change'; // MOCK-HOOK
        x.removeAttribute('disabled'); // MOCK-HOOK: enabled while the banner counts a change
      }); // MOCK-HOOK
    }); // MOCK-HOOK
    await page.waitForTimeout(300); // MOCK-HOOK
    await page.screenshot({ path: path.join(OUT, n + '.png') }); // MOCK-HOOK
    fs.writeFileSync(file, '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML))); // MOCK-HOOK
  }); // MOCK-HOOK
