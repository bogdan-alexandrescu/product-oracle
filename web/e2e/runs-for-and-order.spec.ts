import { login } from './helpers';
import { expect, test } from './test';

/**
 * #1789: every code map run's row names the repo it maps, an older run of a repo too, not one
 * more "Code map", and the list reads newest Updated first.
 */
test('Runs: each code map row names its repo; rows are newest updated first', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('po-mock-scenario', 'runs-code-maps'));
  await login(page);
  await page.goto('/runs');
  const table = page.getByRole('grid');
  for (const repo of ['example-org/api', 'example-org/docs'])
    await expect(table.getByRole('link', { name: repo, exact: true })).toBeVisible();
  // Both runs of one repo are named, the older one too.
  await expect(table.getByRole('link', { name: 'example-org/web', exact: true })).toHaveCount(2);

  const stamps = await table
    .getByTestId('run-updated')
    .evaluateAll((els) => els.map((el) => Date.parse(el.getAttribute('data-at') ?? '')));
  expect(stamps.length).toBeGreaterThan(3);
  expect(stamps.every((t) => !Number.isNaN(t))).toBe(true);
  expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
});

/** #1717: Plan › Dates lists its date sources by the day each supports, as the API orders them. */
test('Plan › Dates: date sources read in date order', async ({ page }) => {
  await login(page);
  await page.goto('/plan/dates');
  const days = page.locator('[data-day]').filter({ visible: true });
  await expect(days.first()).toBeVisible();
  const read = await days.evaluateAll((els) => els.map((el) => el.getAttribute('data-day') ?? ''));
  expect(read.length).toBeGreaterThan(2);
  expect(read).toEqual([...read].sort());
});
