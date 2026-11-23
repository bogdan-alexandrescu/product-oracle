import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * Card simple-speed-parallel-reads: protects = Simple's Roadmap starts the reads of its parts
 * (the tracks, what was removed, the draft PRDs) while its own read is still on its way, each
 * read once, and the app reads what the role may do while GET /v1/me is still on its way;
 * fails_when = a part's read starts only after the roadmap has answered, a warmed read is made
 * a second time by its part, or the capabilities wait for GET /v1/me; no_claim = how fast the
 * API answers (the API's own statement tests), nor the plans of a first visit (their PRDs are
 * known only from the roadmap's answer).
 */

const ROADMAP = 'GET /v1/simple/roadmap?group=goal';
const PARTS = [
  'GET /v1/simple/tracks',
  'GET /v1/simple/removed',
  'GET /v1/simple/roadmap/draft-prds',
];
const SLOW_MS = 6000;

/** The calls the in-browser mock API has served since this page loaded, in order. */
const calls = (page: Page) =>
  page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

/** The mock answers GETs of `path` late (the request is made at once). */
const slow = (page: Page, path: string) =>
  page.evaluate(
    ([p, ms]) => {
      localStorage.setItem('po-mock-slow', p!);
      localStorage.setItem('po-mock-slow-ms', ms!);
    },
    [path, String(SLOW_MS)],
  );

const count = (list: string[], call: string) => list.filter((c) => c === call).length;

test("the roadmap's parts read while the roadmap itself is still on its way, once each", async ({
  page,
}) => {
  await login(page);
  await slow(page, '/v1/simple/roadmap');
  await page.goto('/simple/roadmap');
  // Each part's read is made before the roadmap has answered.
  await expect
    .poll(
      async () => {
        const made = await calls(page);
        return PARTS.filter((p) => !made.includes(p));
      },
      { timeout: SLOW_MS - 2000 },
    )
    .toEqual([]);
  await expect(page.getByTestId('filters')).toHaveCount(0);
  const early = await calls(page);
  expect(count(early, ROADMAP)).toBe(1);
  // The roadmap answers; its parts draw from the reads already made, never a second one.
  await expect(page.getByTestId('filters')).toBeVisible({ timeout: SLOW_MS + 15_000 });
  await expect(page.getByRole('button', { name: /Tracks/ }).first()).toBeVisible();
  await page.waitForTimeout(2500);
  const seen = await calls(page);
  for (const part of PARTS) expect([part, count(seen, part)]).toEqual([part, 1]);
  expect(count(seen, ROADMAP)).toBe(1);
});

test('what the role may do is read while GET /v1/me is still on its way, once', async ({
  page,
}) => {
  await login(page);
  await slow(page, '/v1/me');
  await page.goto('/simple/roadmap');
  await expect
    .poll(async () => count(await calls(page), 'GET /v1/me/capabilities'), {
      timeout: SLOW_MS - 2000,
    })
    .toBe(1);
  // GET /v1/me has not answered yet: the rail still shows its frame.
  await expect(page.getByTestId('simple-nav-skeleton')).toBeVisible();
  await expect(page.getByTestId('simple-nav-roadmap').first()).toBeVisible({
    timeout: SLOW_MS + 15_000,
  });
  await expect(page.getByTestId('filters')).toBeVisible({ timeout: 15_000 });
  expect(count(await calls(page), 'GET /v1/me/capabilities')).toBe(1);
});
