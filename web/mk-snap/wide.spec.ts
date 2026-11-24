// MOCK-HOOK: re-lays the static UT2/UT3 1512 frames in a real 1512x945 window (they were a zoomed 1440 one).
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames');
const names = ['ut2-a', 'ut2-b', 'ut2-c', 'ut2-d', 'ut3-a', 'ut3-c'].map((p) => `${p}-hard-1512`);
for (const n of names)
  test(n, async ({ page }) => {
    const file = path.join(OUT, n + '.html');
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace(/ zoom: 0\.952381;/, '').replace(/content="1512x945"/, 'content="1512x945"');
    fs.writeFileSync(file, html);
    await page.setViewportSize({ width: 1512, height: 945 });
    await page.goto('file://' + file);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, n + '.png') });
  });
