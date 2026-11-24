// MOCK-HOOK: mock-up notes on static frames: each result frame's cost tag, and the focus ring on mid frames.
import fs from 'node:fs'; // MOCK-HOOK
import path from 'node:path'; // MOCK-HOOK
import { test } from '@playwright/test'; // MOCK-HOOK

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames'); // MOCK-HOOK
const COST: Record<string, string> = { // MOCK-HOOK
  'ut1-a-result': 'Cost: 1 click (today 1); earlier changes lost', // MOCK-HOOK
  'ut1-b-result': 'Cost: 1 click (today 1); a 4th or older: 2', // MOCK-HOOK
  'ut1-c-result': 'Cost: 2 clicks for an earlier change (today: lost)', // MOCK-HOOK
  'ut1-d-result': 'Cost: 1 click (today 1); earlier ones: not here', // MOCK-HOOK
  'ut2-a-result': 'Cost: cut 1 click, Undo 1 (today: cut 2)', // MOCK-HOOK
  'ut2-b-result': 'Cost: cut 1, Undo 1; a status: 2 by hand', // MOCK-HOOK
  'ut2-c-result': 'Cost: cut 1 click, Undo 1 (today: cut 2)', // MOCK-HOOK
  'ut2-d-result': 'Cost: cut 2 clicks, as today; no Undo', // MOCK-HOOK
  'ut3-a-result': 'Cost: 3 clicks, any time (today: by hand)', // MOCK-HOOK
  'ut3-b-result': 'Cost: 2 clicks, today only (today: by hand)', // MOCK-HOOK
  'ut3-c-result': 'Cost: 2 clicks, cuts only (today 2)', // MOCK-HOOK
}; // MOCK-HOOK
const FOCUS: Record<string, string> = { // MOCK-HOOK
  'ut2-c-mid': '[data-mk-line] button', // MOCK-HOOK
  'ut3-a-mid': '[data-mk-history] li button', // MOCK-HOOK
  'ut3-b-mid': '[aria-label="Your changes today"] button', // MOCK-HOOK
  'ut3-c-mid': 'main button', // MOCK-HOOK
}; // MOCK-HOOK
const SAY = 'Status changed proposed: it waits for Avery Stone in Needs a decision'; // UT2 b and d: the commenter's toast says where to take it back // MOCK-HOOK
const TEXT: Record<string, string> = {}; // UT2 b and d hard frames are now snapped live as a commenter (ut2.spec.ts) // MOCK-HOOK
const SHOW: Record<string, string> = { // scroll what the caption names into the frame // MOCK-HOOK
  'ut3-a-rest': '[data-mk-history]', // MOCK-HOOK
  'ut3-a-open': '[data-mk-history]', // MOCK-HOOK
  'ut3-a-open-dark': '[data-mk-history]', // MOCK-HOOK
  'ut3-a-mid': '[data-mk-history]', // MOCK-HOOK
  'ut3-c-rest': 'TOP', // MOCK-HOOK
}; // MOCK-HOOK
for (const n of [...new Set([...Object.keys(SHOW), ...Object.keys(TEXT), ...Object.keys(COST), ...Object.keys(FOCUS)])]) // MOCK-HOOK
  test(n, async ({ page }) => { // MOCK-HOOK
    const file = path.join(OUT, n + '.html'); // MOCK-HOOK
    const [w, h] = (fs.readFileSync(file, 'utf8').match(/mockup-viewport" content="(\d+)x(\d+)"/) ?? ['', '1440', '900']).slice(1).map(Number); // MOCK-HOOK
    await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
    await page.goto('file://' + file); // MOCK-HOOK
    await page.waitForTimeout(700); // MOCK-HOOK
    const ok = await page.evaluate(({ cost, focus, show, say }) => { // MOCK-HOOK
      if (say) { // MOCK-HOOK
        const sp = [...document.querySelectorAll('[data-mk-line] span')].find((e) => e.textContent === say); // MOCK-HOOK
        if (!sp) return false; // MOCK-HOOK
        sp.textContent = say + ' · Withdraw it there'; // MOCK-HOOK
      } // MOCK-HOOK
      if (show === 'TOP') { scrollTo(0, 0); document.documentElement.setAttribute('data-mk-win', '0,0'); } // MOCK-HOOK
      else if (show) { // MOCK-HOOK
        const el = document.querySelector(show); // MOCK-HOOK
        if (!el) return false; // MOCK-HOOK
        el.scrollIntoView({ block: 'start' }); // MOCK-HOOK
        for (let a = el.parentElement; a; a = a.parentElement) if (a.scrollTop) a.setAttribute('data-mk-scroll', `${a.scrollLeft},${a.scrollTop}`); // MOCK-HOOK
        document.documentElement.setAttribute('data-mk-win', `${scrollX},${scrollY}`); // MOCK-HOOK
      } // MOCK-HOOK
      document.querySelectorAll('[data-mk-note]').forEach((e) => e.remove()); // MOCK-HOOK
      if (cost) { // MOCK-HOOK
        const t = document.createElement('div'); // MOCK-HOOK
        t.setAttribute('data-mk-note', ''); // MOCK-HOOK
        t.textContent = cost; // MOCK-HOOK
        t.style.cssText = 'position:fixed;left:16px;top:630px;width:200px;z-index:99;padding:4px 10px;border:1px dashed #b45309;border-radius:12px;background:#fffbeb;color:#92400e;font:600 13px/20px "Inter Tight",sans-serif'; // a margin note in the rail's empty middle, over no control // MOCK-HOOK
        if (document.querySelector('[aria-label="Your changes today"]')) Object.assign(t.style, { top: '18px', left: 'auto', right: '40px', width: 'auto' }); // the open list fills the rail: the empty top right instead // MOCK-HOOK
        document.body.append(t); // MOCK-HOOK
      } // MOCK-HOOK
      if (focus) { // MOCK-HOOK
        document.querySelectorAll<HTMLElement>('button').forEach((e) => { e.style.outline = ''; e.style.outlineOffset = ''; }); // MOCK-HOOK
        const b = [...document.querySelectorAll<HTMLElement>(focus)].find((e) => /^(Undo|Restore|Withdraw)(?! whole)/.test(e.textContent?.trim() ?? '')); // MOCK-HOOK
        if (!b) return false; // MOCK-HOOK
        b.style.outline = '2px solid #1d6fb8'; // MOCK-HOOK
        b.style.outlineOffset = '2px'; // MOCK-HOOK
      } // MOCK-HOOK
      return true; // MOCK-HOOK
    }, { cost: COST[n], focus: FOCUS[n], show: SHOW[n], say: TEXT[n] }); // MOCK-HOOK
    if (!ok) throw new Error('no button in ' + n); // MOCK-HOOK
    await page.screenshot({ path: path.join(OUT, n + '.png') }); // MOCK-HOOK
    fs.writeFileSync(file, '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML))); // MOCK-HOOK
  }); // MOCK-HOOK
