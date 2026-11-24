// MOCK-HOOK: mk-undo review round: the frames the review asked to redo.
import { test, type Page } from '@playwright/test'; // MOCK-HOOK
import { signIn, snap, theme } from './snap'; // MOCK-HOOK

const A = ['Removed the dependency of F-140 Usage-based alert thresholds for enterprise workspaces on F-70 Alert rules engine', 'Undo']; // MOCK-HOOK
const B = ['Set F-79 Weekly alert digest to At risk', 'Undo']; // MOCK-HOOK
const C = ['Moved F-79 Weekly alert digest from Oct 31 – Dec 10 to Nov 28 – Jan 7', 'Undo']; // MOCK-HOOK
const MORE = [ // MOCK-HOOK
  ['Set F-88 Quiet hours for alerts to At risk', 'Undo'], // MOCK-HOOK
  ['Moved F-131 Self-serve plan downgrade with prorated credit for annual teams from Feb 2 – Mar 17 to Mar 2 – Apr 17', 'Undo'], // MOCK-HOOK
  ['Cut F-64 In-app tour from the roadmap', 'Undo'], // MOCK-HOOK
]; // MOCK-HOOK
async function real(page: Page) { // the one real change: the broken link's Remove the dependency // MOCK-HOOK
  await page.getByRole('button', { name: 'Remove the dependency' }).first().click(); // MOCK-HOOK
  await page.locator('[data-testid="draft-count"]').waitFor(); // MOCK-HOOK
  await page.evaluate(() => scrollTo(0, 0)); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
} // MOCK-HOOK
const push = (page: Page, list: string[][]) => // MOCK-HOOK
  page.evaluate((l) => l.forEach(([m, b]) => (window as unknown as { __mk: { push: (m: string, b: string) => void } }).__mk.push(m, b)), list); // MOCK-HOOK

async function open(page: Page, q: string, w = 1440, h = 900) { // MOCK-HOOK
  await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
  await signIn(page, `/simple/roadmap?${q}&hold=1`); // MOCK-HOOK
  await page.locator('main h1').waitFor(); // MOCK-HOOK
  await page.waitForTimeout(2500); // the timeline's bars and axis drawn // MOCK-HOOK
} // MOCK-HOOK

for (const v of ['a', 'b', 'c', 'd']) { // MOCK-HOOK
  for (const [sfx, w, h] of [['-1512', 1512, 945], ['', 1440, 900]] as const) { // MOCK-HOOK
    if (v === 'd' && !sfx) continue; // d's hard frame is in its story // MOCK-HOOK
    test(`ut1 ${v} hard${sfx}`, async ({ page }) => { // MOCK-HOOK
      await open(page, `ut1=${v}${v === 'c' ? '&open=1' : ''}`, w, h); // MOCK-HOOK
      await real(page); // MOCK-HOOK
      await push(page, [B, C, ...MORE]); // MOCK-HOOK
      if (v === 'c') { // the open list is tall: the person has scrolled to the timeline, the broken links above it stay clear // MOCK-HOOK
        await page.evaluate(() => { // MOCK-HOOK
          const b = document.querySelector('[data-testid="conflicts"]')!; // MOCK-HOOK
          let sc: Element | null = b.parentElement; // MOCK-HOOK
          while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement; // MOCK-HOOK
          const dy = b.getBoundingClientRect().top - 110; // MOCK-HOOK
          if (sc) sc.scrollTop += dy; else scrollBy(0, dy); // MOCK-HOOK
        }); // MOCK-HOOK
        await page.waitForTimeout(900); // MOCK-HOOK
      } // MOCK-HOOK
      await snap(page, `ut1-${v}-hard${sfx}`); // MOCK-HOOK
    }); // MOCK-HOOK
  } // MOCK-HOOK
  if (v === 'b' || v === 'c') // MOCK-HOOK
    test(`ut1 ${v} open`, async ({ page }) => { // MOCK-HOOK
      await open(page, `ut1=${v}${v === 'c' ? '&open=1' : ''}`); // MOCK-HOOK
      await real(page); // MOCK-HOOK
    await push(page, [B, C]); // MOCK-HOOK
      await snap(page, `ut1-${v}-open`); // MOCK-HOOK
    }); // MOCK-HOOK
  test(`ut1 ${v} dark`, async ({ page }) => { // MOCK-HOOK
    await open(page, `ut1=${v}${v === 'b' || v === 'c' ? '&open=1' : ''}`); // MOCK-HOOK
    await theme(page, 'dark'); // MOCK-HOOK
    await page.waitForTimeout(800); // MOCK-HOOK
    await real(page); // MOCK-HOOK
    await push(page, [B, C]); // MOCK-HOOK
    await snap(page, `ut1-${v}-open-dark`); // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK

test('ut1 a phone', async ({ page }) => { // MOCK-HOOK
  await open(page, 'ut1=a', 390, 844); // MOCK-HOOK
  await real(page); // MOCK-HOOK
  await snap(page, 'ut1-a-phone-390'); // MOCK-HOOK
}); // MOCK-HOOK

test('ut1 d story', async ({ page }) => { // MOCK-HOOK
  await open(page, 'ut1=d'); // MOCK-HOOK
  await real(page); // MOCK-HOOK
  await snap(page, 'ut1-d-rest'); // MOCK-HOOK
  await push(page, [B, C]); // MOCK-HOOK
  await snap(page, 'ut1-d-open'); // MOCK-HOOK
  await page.keyboard.press('Shift'); // MOCK-HOOK
  await page.locator('#mk-strip button', { hasText: 'Undo' }).focus(); // MOCK-HOOK
  await snap(page, 'ut1-d-mid'); // MOCK-HOOK
  await page.keyboard.press('Enter'); // MOCK-HOOK
  await snap(page, 'ut1-d-result'); // MOCK-HOOK
  await push(page, MORE); // MOCK-HOOK
  await snap(page, 'ut1-d-hard'); // MOCK-HOOK
}); // MOCK-HOOK

test('ut1 d phone', async ({ page }) => { // MOCK-HOOK
  await open(page, 'ut1=d', 390, 844); // MOCK-HOOK
  await real(page); // MOCK-HOOK
    await push(page, [B, C]); // MOCK-HOOK
  await snap(page, 'ut1-d-phone-390'); // MOCK-HOOK
}); // MOCK-HOOK

for (const [name, w, h, q] of [ // MOCK-HOOK
  ['ut3-b-hard', 1440, 900, ''], // MOCK-HOOK
  ['ut3-b-hard-1512', 1512, 945, ''], // MOCK-HOOK
] as const) { // MOCK-HOOK
  test(name, async ({ page }) => { // MOCK-HOOK
    await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
    await signIn(page, `/simple/roadmap?ut3=b&mine=1&who=commenter&hold=1${q}`, 'commenter@example.com'); // MOCK-HOOK
    await page.locator('main h1').waitFor(); // MOCK-HOOK
    await page.waitForTimeout(2500); // MOCK-HOOK
    await snap(page, name); // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK

test('ut1 a story', async ({ page }) => { // MOCK-HOOK
  await open(page, 'ut1=a'); // MOCK-HOOK
  await real(page); // MOCK-HOOK
  await snap(page, 'ut1-a-rest'); // MOCK-HOOK
  await push(page, [B, C]); // MOCK-HOOK
  await snap(page, 'ut1-a-open'); // MOCK-HOOK
  await page.keyboard.press('Shift'); // MOCK-HOOK
  await page.locator('[data-mk-line] button', { hasText: 'Undo' }).last().focus(); // MOCK-HOOK
  await snap(page, 'ut1-a-mid'); // MOCK-HOOK
  await page.keyboard.press('Enter'); // MOCK-HOOK
  await page.evaluate(() => { // the draft banner at the top, so its count and the F-79 bar on the timeline are both in view // MOCK-HOOK
    const b = document.querySelector('[data-testid="draft-count"]')!; // MOCK-HOOK
    let sc: Element | null = b.parentElement; // MOCK-HOOK
    while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement; // MOCK-HOOK
    const dy = b.getBoundingClientRect().top - 24; // MOCK-HOOK
    if (sc) sc.scrollTop += dy; else scrollBy(0, dy); // MOCK-HOOK
  }); // MOCK-HOOK
  await snap(page, 'ut1-a-result'); // MOCK-HOOK
}); // MOCK-HOOK
