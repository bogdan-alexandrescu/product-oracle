// MOCK-HOOK: re-lays the static UT2/UT3 1512 frames in a real 1512x945 window (they were a zoomed 1440 one).
import fs from 'node:fs'; // MOCK-HOOK
import path from 'node:path'; // MOCK-HOOK
import { test } from '@playwright/test'; // MOCK-HOOK

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames'); // MOCK-HOOK
const names = ['ut2-a', 'ut2-b', 'ut2-c', 'ut2-d', 'ut3-a', 'ut3-c'].map((p) => `${p}-hard-1512`); // MOCK-HOOK
for (const n of names) // MOCK-HOOK
  test(n, async ({ page }) => { // MOCK-HOOK
    const file = path.join(OUT, n + '.html'); // MOCK-HOOK
    let html = fs.readFileSync(file, 'utf8'); // MOCK-HOOK
    html = html.replace(/ zoom: 0\.952381;/, '').replace(/content="1512x945"/, 'content="1512x945"'); // MOCK-HOOK
    fs.writeFileSync(file, html); // MOCK-HOOK
    await page.setViewportSize({ width: 1512, height: 945 }); // MOCK-HOOK
    await page.goto('file://' + file); // MOCK-HOOK
    await page.waitForTimeout(800); // MOCK-HOOK
    await page.screenshot({ path: path.join(OUT, n + '.png') }); // MOCK-HOOK
  }); // MOCK-HOOK
