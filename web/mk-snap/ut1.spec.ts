// MOCK-HOOK: mk-undo review round: the frames the review asked to redo.
import { test, type Page } from '@playwright/test';
import { signIn, snap, theme } from './snap';

const A = ['Removed the dependency of F-140 Usage-based alert thresholds for enterprise workspaces on F-70 Alert rules engine', 'Undo'];
const B = ['Set F-79 Weekly alert digest to At risk', 'Undo'];
const C = ['Moved F-131 Self-serve plan downgrade with prorated credit for annual teams from Feb 2 – Mar 17 to Mar 2 – Apr 17', 'Undo'];
const MORE = [
  ['Set F-88 Quiet hours for alerts to At risk', 'Undo'],
  ['Moved F-70 Alert rules engine from Jan 5 – Feb 20 to Feb 2 – Mar 20', 'Undo'],
  ['Cut F-64 In-app tour from the roadmap', 'Undo'],
];
const push = (page: Page, list: string[][]) =>
  page.evaluate((l) => l.forEach(([m, b]) => (window as unknown as { __mk: { push: (m: string, b: string) => void } }).__mk.push(m, b)), list);

async function open(page: Page, q: string, w = 1440, h = 900) {
  await page.setViewportSize({ width: w, height: h });
  await signIn(page, `/simple/roadmap?${q}&hold=1`);
  await page.locator('main h1').waitFor();
  await page.waitForTimeout(2500); // the timeline's bars and axis drawn
}

for (const v of ['a', 'b', 'c', 'd']) {
  for (const [sfx, w, h] of [['-1512', 1512, 945], ['', 1440, 900]] as const) {
    if (v === 'd' && !sfx) continue; // d's hard frame is in its story
    test(`ut1 ${v} hard${sfx}`, async ({ page }) => {
      await open(page, `ut1=${v}${v === 'c' ? '&open=1' : ''}`, w, h);
      await push(page, [A, B, C, ...MORE]);
      await snap(page, `ut1-${v}-hard${sfx}`);
    });
  }
  if (v === 'b' || v === 'c')
    test(`ut1 ${v} open`, async ({ page }) => {
      await open(page, `ut1=${v}${v === 'c' ? '&open=1' : ''}`);
      await push(page, [A, B, C]);
      await snap(page, `ut1-${v}-open`);
    });
  test(`ut1 ${v} dark`, async ({ page }) => {
    await open(page, `ut1=${v}${v === 'b' || v === 'c' ? '&open=1' : ''}`);
    await theme(page, 'dark');
    await page.waitForTimeout(800);
    await push(page, [A, B, C]);
    await snap(page, `ut1-${v}-open-dark`);
  });
}

test('ut1 a phone', async ({ page }) => {
  await open(page, 'ut1=a', 390, 844);
  await push(page, [A]);
  await snap(page, 'ut1-a-phone-390');
});

test('ut1 d story', async ({ page }) => {
  await open(page, 'ut1=d');
  await push(page, [A]);
  await snap(page, 'ut1-d-rest');
  await push(page, [B, C]);
  await snap(page, 'ut1-d-open');
  await page.keyboard.press('Shift');
  await page.locator('#mk-strip button', { hasText: 'Undo' }).focus();
  await snap(page, 'ut1-d-mid');
  await page.keyboard.press('Enter');
  await snap(page, 'ut1-d-result');
  await push(page, MORE);
  await snap(page, 'ut1-d-hard');
});

test('ut1 d phone', async ({ page }) => {
  await open(page, 'ut1=d', 390, 844);
  await push(page, [A, B, C]);
  await snap(page, 'ut1-d-phone-390');
});

for (const [name, w, h, q] of [
  ['ut3-b-hard', 1440, 900, ''],
  ['ut3-b-hard-1512', 1512, 945, ''],
  ['ut3-b-phone-390', 390, 844, ''],
] as const) {
  test(name, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signIn(page, `/simple/roadmap?ut3=b&mine=1&who=commenter&hold=1${q}`, 'commenter@example.com');
    await page.locator('main h1').waitFor();
    await page.waitForTimeout(2500);
    await snap(page, name);
  });
}
