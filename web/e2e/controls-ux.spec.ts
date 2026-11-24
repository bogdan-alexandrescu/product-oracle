import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * controls-ux (#1743, #1744, #1745), invented mock data, the audit's 1500x620 window.
 * protects = every enabled control shows the hand and a disabled one not-allowed (globals.css
 * base layer); a ds Button's hover changes its outline and fill (Button.tsx); a row's "More"
 * menu and an (i) are at least 24x24.
 * fails_when = buttons fall back to the reset's arrow; the secondary or .simple-button hover only tints the fill;
 * Goal map's "More for" menus are 24x16 again.
 */
const cursor = (l: Locator) => l.evaluate((el) => getComputedStyle(el).cursor);

async function open(page: Page, path: string, ready: Locator) {
  await page.goto(path);
  await expect(ready).toBeVisible();
}

async function pointers(controls: Locator[]) {
  for (const c of controls) {
    await expect(c).toBeVisible();
    expect(await cursor(c), await c.evaluate((el) => el.outerHTML.slice(0, 120))).toBe('pointer');
  }
}

async function atLeast24(l: Locator) {
  const box = await l.boundingBox();
  expect(box, 'drawn').not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 620 });
  await login(page);
});

test('enabled controls show the hand on every page; a disabled one shows not-allowed', async ({
  page,
}) => {
  await open(page, '/simple/roadmap', page.getByTestId('simple-roadmap'));
  await pointers([
    page.getByTestId('mode-simple'),
    page.getByTestId('mode-detailed'),
    page.getByRole('button', { name: 'Timeline', exact: true }),
    page.getByTestId('key-dates-open'),
    page.getByRole('button', { name: 'About what is broken' }).first(),
  ]);

  await open(
    page,
    '/simple/priorities',
    page.getByRole('tab', { name: 'Ranked list', exact: true }),
  );
  await pointers([
    page.getByRole('tab', { name: 'Ranked list', exact: true }),
    page.getByRole('button', { name: 'About Ranked list' }),
    page.getByRole('button', { name: /^More for / }).first(),
  ]);

  await open(page, '/plan', page.getByRole('button', { name: 'About Plan' }));
  await pointers([page.getByRole('button', { name: 'About Plan' })]);
  await expect(page.getByTestId('track-push')).toBeDisabled();
  expect(await cursor(page.getByTestId('track-push'))).toBe('not-allowed');

  await open(page, '/home', page.getByRole('button', { name: 'About Needs you' }));
  await pointers([
    page.getByRole('button', { name: 'About Needs you' }),
    page.getByRole('button', { name: 'Answer' }).first(),
  ]);
});

test('a header button visibly changes outline and fill on hover', async ({ page }) => {
  await open(page, '/simple/roadmap', page.getByTestId('simple-roadmap'));
  const btn = page.getByTestId('key-dates-open');
  await expect(btn).toBeVisible();
  const look = () =>
    btn.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopColor, fill: s.backgroundColor };
    });
  const rest = await look();
  await btn.hover();
  await expect.poll(async () => (await look()).border).not.toBe(rest.border);
  await expect.poll(async () => (await look()).fill).not.toBe(rest.fill);
});

test('an outline Simple button visibly changes outline and fill on hover', async ({ page }) => {
  await page.goto('/simple');
  const btn = page
    .locator(
      '.simple-button:not(.simple-button-primary):not(.simple-button-quiet):not(:disabled):not(.invisible):visible',
    )
    .first();
  await expect(btn).toBeVisible();
  const look = () =>
    btn.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopColor, fill: s.backgroundColor };
    });
  const rest = await look();
  await btn.hover();
  await expect.poll(async () => (await look()).border).not.toBe(rest.border);
  await expect.poll(async () => (await look()).fill).not.toBe(rest.fill);
});

test('row menus and (i) icons are at least 24x24 hit areas', async ({ page }) => {
  await open(page, '/simple/goals', page.getByRole('button', { name: /^More for / }).first());
  const menus = page.getByRole('button', { name: /^More for / });
  expect(await menus.count()).toBeGreaterThan(0);
  for (const m of await menus.all()) if (await m.isVisible()) await atLeast24(m);
  for (const i of await page.getByRole('button', { name: /^About / }).all())
    if (await i.isVisible()) await atLeast24(i);
});
