// MOCK-HOOK: mock-up notes on static frames: each result frame's cost tag, and the focus ring on mid frames.
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames');
const COST: Record<string, string> = {
  'ut1-a-result': 'Cost: 1 click (today 1); earlier changes lost',
  'ut1-b-result': 'Cost: 1 click (today 1); a 4th or older: 2',
  'ut1-c-result': 'Cost: 2 clicks for an earlier change (today: lost)',
  'ut1-d-result': 'Cost: 1 click (today 1); earlier ones: not here',
  'ut2-a-result': 'Cost: cut 1 click, Undo 1 (today: cut 2)',
  'ut2-b-result': 'Cost: cut 1, Undo 1; a status: 2 by hand',
  'ut2-c-result': 'Cost: cut 1 click, Undo 1 (today: cut 2)',
  'ut2-d-result': 'Cost: cut 2 clicks, as today; no Undo',
  'ut3-a-result': 'Cost: 3 clicks, any time (today: by hand)',
  'ut3-b-result': 'Cost: 2 clicks, today only (today: by hand)',
  'ut3-c-result': 'Cost: 2 clicks, cuts only (today 2)',
};
const FOCUS: Record<string, string> = {
  'ut2-c-mid': '[data-mk-line] button',
  'ut3-a-mid': '[data-mk-history] li button',
  'ut3-b-mid': '[aria-label="Your changes today"] button',
};
const SHOW: Record<string, string> = { // scroll what the caption names into the frame
  'ut3-a-rest': '[data-mk-history]',
  'ut3-a-open': '[data-mk-history]',
  'ut3-a-open-dark': '[data-mk-history]',
  'ut3-a-mid': '[data-mk-history]',
  'ut3-c-rest': 'TOP',
};
for (const n of [...new Set([...Object.keys(SHOW), ...Object.keys(COST), ...Object.keys(FOCUS)])])
  test(n, async ({ page }) => {
    const file = path.join(OUT, n + '.html');
    const [w, h] = (fs.readFileSync(file, 'utf8').match(/mockup-viewport" content="(\d+)x(\d+)"/) ?? ['', '1440', '900']).slice(1).map(Number);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('file://' + file);
    await page.waitForTimeout(700);
    const ok = await page.evaluate(({ cost, focus, show }) => {
      if (show === 'TOP') { scrollTo(0, 0); document.documentElement.setAttribute('data-mk-win', '0,0'); }
      else if (show) {
        const el = document.querySelector(show);
        if (!el) return false;
        el.scrollIntoView({ block: 'start' });
        for (let a = el.parentElement; a; a = a.parentElement) if (a.scrollTop) a.setAttribute('data-mk-scroll', `${a.scrollLeft},${a.scrollTop}`);
        document.documentElement.setAttribute('data-mk-win', `${scrollX},${scrollY}`);
      }
      document.querySelectorAll('[data-mk-note]').forEach((e) => e.remove());
      if (cost) {
        const t = document.createElement('div');
        t.setAttribute('data-mk-note', '');
        t.textContent = cost;
        t.style.cssText = 'position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:99;padding:2px 10px;border:1px dashed #b45309;border-radius:999px;background:#fffbeb;color:#92400e;font:600 13px/20px "Inter Tight",sans-serif';
        document.body.append(t);
      }
      if (focus) {
        const b = [...document.querySelectorAll<HTMLElement>(focus)].find((e) => /Undo|Restore/.test(e.textContent ?? ''));
        if (!b) return false;
        b.style.outline = '2px solid #1d6fb8';
        b.style.outlineOffset = '2px';
      }
      return true;
    }, { cost: COST[n], focus: FOCUS[n], show: SHOW[n] });
    if (!ok) throw new Error('no button in ' + n);
    await page.screenshot({ path: path.join(OUT, n + '.png') });
    fs.writeFileSync(file, '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML)));
  });
