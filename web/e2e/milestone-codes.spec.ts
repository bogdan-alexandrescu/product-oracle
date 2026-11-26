import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from '../lib/api/mock/server';

import { ADMIN, lineOptionsSettled, login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * #1894: one milestone has one code on every page. The "milestone-codes-prd" scenario's roadmap carries its PRD's
 * milestones (the PRD numbers them M1, M2, M3) with the roadmap's own codes, by date across the roadmap, beside the
 * track's Beta. Priorities' Line picker names each PRD milestone by the roadmap's code, as the Roadmap does, never
 * by the PRD's number, so no code names two milestones there.
 * #1882: while the roadmap read is slow, the picker never lists a milestone without its code (no label that
 * changes under the reader).
 * fails_when = a picker option or a part head reads a PRD's own number ("M2 · Scale volume"), two options share a
 * code, or a milestone option is drawn without its code before the roadmap read lands. Invented data.
 */

const MILESTONE = /^(Milestone|From the PRD): /;

async function setUp(page: Page, slow = false) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, slowKey, msKey, isSlow]) => {
      localStorage.setItem(key, value);
      if (isSlow) {
        localStorage.setItem(slowKey, '/v1/simple/roadmap');
        localStorage.setItem(msKey, '3000');
      }
    },
    [MOCK_SCENARIO_KEY, 'milestone-codes-prd', MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, slow] as const,
  );
  await login(page, ADMIN.email);
}

test('the Line picker names each milestone by the code the Roadmap shows', async ({ page }) => {
  await setUp(page);
  await page.goto('/simple/roadmap');
  // The Roadmap's milestone list names each PRD milestone by its roadmap code ("M3 Scale volume (from the PRD ...)").
  const fromPrd = page.getByRole('button', { name: /^M\d+ .+ \(from the PRD Guided setup\)$/ });
  await expect(fromPrd).toHaveCount(3);
  const names = await fromPrd.evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''),
  );
  const want = names.map((n) => n.replace(/ \(from the PRD.*$/, ''));
  expect(want.map((w) => w.replace(/^M\d+ /, '')).sort()).toEqual([
    'Open to all',
    'Prove it',
    'Scale volume',
  ]);

  await page.goto('/simple/priorities');
  await expect(page.getByTestId('simple-priorities')).toBeVisible();
  const options = page.locator('#prio-line option');
  await expect(options.filter({ hasText: want[1] })).toHaveCount(1);
  const shown = (await options.allTextContents()).filter((t) => MILESTONE.test(t));
  for (const w of want)
    expect(
      shown.some((t) => t.includes(`: ${w} · `)),
      shown.join(' | '),
    ).toBe(true);
  expect(shown.join(' | ')).not.toMatch(/M\d+ · /);
  const codes = shown.map((t) => /^[^:]+: (M\d+) /.exec(t)?.[1]);
  expect(codes.every(Boolean), shown.join(' | ')).toBe(true);
  expect(new Set(codes).size, shown.join(' | ')).toBe(codes.length);
});

test('a PRD line picked, the part heads and rows name its milestone by the Roadmap code', async ({
  page,
}) => {
  await setUp(page);
  await page.goto('/simple/roadmap');
  const scale = page.getByRole('button', {
    name: /^M\d+ Scale volume \(from the PRD Guided setup\)$/,
  });
  await expect(scale).toHaveCount(1);
  const code = /^(M\d+) /.exec(
    (await scale.getAttribute('aria-label')) ?? (await scale.innerText()),
  )![1];

  await page.goto('/simple/priorities');
  await expect(page.getByTestId('simple-priorities')).toBeVisible();
  await lineOptionsSettled(page);
  const option = page.locator('#prio-line option').filter({ hasText: /Scale volume/ });
  await expect(option).toHaveCount(1);
  await page.locator('#prio-line').selectOption({ label: (await option.textContent())! });
  const heads = page.getByTestId('prio-part-head');
  await expect(heads.first()).toBeVisible();
  for (const head of await heads.all())
    await expect(head).toHaveAttribute(
      'aria-label',
      new RegExp(`^(Makes|Misses) ${code} Scale volume · `),
    );
  const words = [
    ...(await heads.allInnerTexts()),
    ...(await page.getByTestId('prio-milestone').allInnerTexts()),
  ].join(' | ');
  expect(words).not.toMatch(/M\d+ · /);
});

test('while the roadmap read is slow, no milestone option shows without its code', async ({
  page,
}) => {
  await setUp(page, true);
  await page.addInitScript(() => {
    const w = window as unknown as { seenOptions: string[] };
    w.seenOptions = [];
    const look = () =>
      document
        .querySelectorAll('#prio-line option')
        .forEach((o) => w.seenOptions.push(o.textContent ?? ''));
    new MutationObserver(look).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await page.goto('/simple/priorities');
  await expect(page.getByTestId('line-picker')).toBeVisible();
  await expect(page.locator('#prio-line option').filter({ hasText: /M\d+ Beta/ })).toHaveCount(1, {
    timeout: 15_000,
  });
  const seen = await page.evaluate(
    () => (window as unknown as { seenOptions: string[] }).seenOptions,
  );
  expect(seen.length).toBeGreaterThan(0);
  const uncoded = seen.filter((t) => MILESTONE.test(t) && !/^[^:]+: M\d+ /.test(t));
  expect(uncoded).toEqual([]);
});
