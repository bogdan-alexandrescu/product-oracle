import { expect, test } from './test';

/**
 * #1789: a code map run's row names the repo it maps, not one more "Code map", and the list
 * reads newest Updated first.
 */
test('Runs: each code map row names its repo; rows are newest updated first', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('po-mock-scenario', 'runs-code-maps'));
  await page.goto('/runs');
  const table = page.getByRole('table');
  for (const repo of ['example-org/web', 'example-org/api', 'example-org/docs'])
    await expect(table.getByRole('link', { name: repo, exact: true })).toBeVisible();

  const stamps = await table
    .getByTestId('run-updated')
    .evaluateAll((els) => els.map((el) => Date.parse(el.getAttribute('data-at') ?? '')));
  expect(stamps.length).toBeGreaterThan(3);
  expect(stamps.every((t) => !Number.isNaN(t))).toBe(true);
  expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
});
