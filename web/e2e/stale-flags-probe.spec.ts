import { login } from './helpers';
import { expect, test, type Page } from './test';

const roadmapCount = (page: Page) => page.getByTestId('simple-nav-roadmap-count');
const decisionsCount = (page: Page) => page.getByTestId('simple-nav-decisions-count');
const num = async (l: ReturnType<Page['locator']>) => Number((await l.textContent()) ?? '0');
const needs = async (page: Page) =>
  Number(/· (\d+)/.exec((await page.getByTestId('needs-decision').textContent()) ?? '')?.[1] ?? 0);

test.use({ viewport: { width: 1440, height: 900 } });

test('probe roadmap reject', async ({ page }) => {
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(decisionsCount(page)).toHaveText(/^\d+$/);
  await expect(page.getByTestId('needs-decision')).toContainText('·');
  const d = await num(decisionsCount(page));
  const r = await num(roadmapCount(page));
  const n = await needs(page);
  console.log('before', d, r, n);
  await page.getByTestId('needs-decision').click();
  const s = page.getByTestId('decision-tray').getByTestId('goal-suggestion').first();
  await s.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('dialog', { name: /^Reject / }).locator('button[type=submit]').click();
  await page.waitForTimeout(2500);
  console.log('after', await num(decisionsCount(page)), await num(roadmapCount(page)), await needs(page));
});

test('probe decisions not this', async ({ page }) => {
  await login(page);
  await page.goto('/simple/decisions');
  await expect(decisionsCount(page)).toHaveText(/^\d+$/);
  await expect(roadmapCount(page)).toHaveText(/^\d+$/);
  const d = await num(decisionsCount(page));
  const r = await num(roadmapCount(page));
  console.log('before', d, r);
  const row = page.getByRole('listitem', { name: /^Goal suggestion: / }).first();
  await row.getByRole('button', { name: 'Not this' }).click();
  await page.waitForTimeout(2500);
  console.log('after', await num(decisionsCount(page)), await num(roadmapCount(page)));
  await page.getByTestId('simple-nav-roadmap').click();
  await expect(page.getByTestId('needs-decision')).toContainText('·');
  await page.waitForTimeout(1500);
  console.log('roadmap needs', await needs(page), await num(roadmapCount(page)));
});

test('probe draft owner on home and decisions', async ({ page }) => {
  await login(page);
  await page.goto('/simple/decisions');
  await expect(decisionsCount(page)).toHaveText(/^\d+$/);
  const names = await page.getByTestId('waiting-item').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  console.log('decisions items', JSON.stringify(names));
  await page.goto('/simple/roadmap');
  await page.getByTestId('needs-decision').click();
  const tiles = await page.getByTestId('tray-counter').allInnerTexts();
  console.log('tiles', JSON.stringify(tiles));
  console.log('flags', JSON.stringify(await page.getByTestId('tray-flag').allInnerTexts()));
});
