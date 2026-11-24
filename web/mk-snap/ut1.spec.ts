// MOCK-HOOK: mk-undo review round: the frames the review asked to redo.
import { test, type Page } from '@playwright/test';
import { signIn, snap, theme } from './snap';

const A = ['Removed the dependency of F-140 Usage-based alert thresholds for enterprise workspaces on F-70 Alert rules engine', 'Undo'];
const B = ['Set F-79 Weekly alert digest to At risk', 'Undo'];
const C = ['Moved F-79 Weekly alert digest from Oct 31 – Dec 10 to Nov 28 – Jan 7', 'Undo'];
const MORE = [
  ['Set F-88 Quiet hours for alerts to At risk', 'Undo'],
  ['Moved F-131 Self-serve plan downgrade with prorated credit for annual teams from Feb 2 – Mar 17 to Mar 2 – Apr 17', 'Undo'],
  ['Cut F-64 In-app tour from the roadmap', 'Undo'],
];
async function real(page: Page) { // the one real change: the broken link's Remove the dependency
  await page.getByRole('button', { name: 'Remove the dependency' }).first().click();
  await page.locator('[data-testid="draft-count"]').waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(800);
}
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
      await real(page);
      await push(page, [B, C, ...MORE]);
      if (v === 'c') { // the open list is tall: the person has scrolled to the timeline, the broken links above it stay clear
        await page.evaluate(() => {
          const b = document.querySelector('[data-testid="conflicts"]')!;
          let sc: Element | null = b.parentElement;
          while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
          const dy = b.getBoundingClientRect().top - 110;
          if (sc) sc.scrollTop += dy; else scrollBy(0, dy);
        });
        await page.waitForTimeout(900);
      }
      await snap(page, `ut1-${v}-hard${sfx}`);
    });
  }
  if (v === 'b' || v === 'c')
    test(`ut1 ${v} open`, async ({ page }) => {
      await open(page, `ut1=${v}${v === 'c' ? '&open=1' : ''}`);
      await real(page);
    await push(page, [B, C]);
      await snap(page, `ut1-${v}-open`);
    });
  test(`ut1 ${v} dark`, async ({ page }) => {
    await open(page, `ut1=${v}${v === 'b' || v === 'c' ? '&open=1' : ''}`);
    await theme(page, 'dark');
    await page.waitForTimeout(800);
    await real(page);
    await push(page, [B, C]);
    await snap(page, `ut1-${v}-open-dark`);
  });
}

test('ut1 a phone', async ({ page }) => {
  await open(page, 'ut1=a', 390, 844);
  await real(page);
  await snap(page, 'ut1-a-phone-390');
});

test('ut1 d story', async ({ page }) => {
  await open(page, 'ut1=d');
  await real(page);
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
  await real(page);
    await push(page, [B, C]);
  await snap(page, 'ut1-d-phone-390');
});

for (const [name, w, h, q] of [
  ['ut3-b-hard', 1440, 900, ''],
  ['ut3-b-hard-1512', 1512, 945, ''],
] as const) {
  test(name, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signIn(page, `/simple/roadmap?ut3=b&mine=1&who=commenter&hold=1${q}`, 'commenter@example.com');
    await page.locator('main h1').waitFor();
    await page.waitForTimeout(2500);
    await snap(page, name);
  });
}

test('ut1 a story', async ({ page }) => {
  await open(page, 'ut1=a');
  await real(page);
  await snap(page, 'ut1-a-rest');
  await push(page, [B, C]);
  await snap(page, 'ut1-a-open');
  await page.keyboard.press('Shift');
  await page.locator('[data-mk-line] button', { hasText: 'Undo' }).last().focus();
  await snap(page, 'ut1-a-mid');
  await page.keyboard.press('Enter');
  await page.evaluate(() => { // the draft banner at the top, so its count and the F-79 bar on the timeline are both in view
    const b = document.querySelector('[data-testid="draft-count"]')!;
    let sc: Element | null = b.parentElement;
    while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
    const dy = b.getBoundingClientRect().top - 24;
    if (sc) sc.scrollTop += dy; else scrollBy(0, dy);
  });
  await snap(page, 'ut1-a-result');
});
