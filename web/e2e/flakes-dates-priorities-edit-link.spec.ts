import { login } from './helpers';
import { expect, test } from './test';

/*
 * flakes-dates: a goal's ?edit= link (Rename on the Goal map) opens its form on Goal buckets once.
 * Mock default scenario (invented data), the owner, desktop.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("a Rename link opens the goal's form once: closed, it does not come back and the link leaves the URL", async ({
  page,
}) => {
  // protects: the form opened from ?edit= stays closed after Cancel, across tabs
  // fails_when: the edit param stays in the URL and Goal buckets opens the form again
  await login(page);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-grid')).toBeVisible();
  await page.locator('[data-testid^="gm-menu-g-"]').first().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(page).toHaveURL(/\/simple\/priorities\?/);
  const form = page.getByRole('heading', { name: 'Edit goal' });
  await expect(form).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Goal', exact: true })).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]edit=/);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);

  await page.getByRole('tab', { name: 'Ranked list' }).click();
  await expect(page.getByTestId('prio-row').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  await expect(page.getByRole('button', { name: /^Edit / }).first()).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]edit=/);
});

test('Edit on the goal after the linked form is closed opens it in place: the name does not take the focus back or scroll', async ({
  page,
}) => {
  // protects: useLinkedGoalEdit clears `linked` on a later open or close (priorities.tsx ~157)
  // fails_when: the form opened again by Edit refocuses its name and scrolls to it as the linked open does
  await login(page);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-grid')).toBeVisible();
  await page.locator('[data-testid^="gm-menu-g-"]').first().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const form = page.getByTestId('goal-form');
  const name = page.getByRole('textbox', { name: 'Goal', exact: true });
  await expect(form).toBeVisible();
  await expect(name).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]edit=/);
  const goal = await page
    .getByTestId('goal-bucket')
    .filter({ has: form })
    .getAttribute('data-goal-id');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);

  // The clock holds still while the person opens the form again, clicks away and scrolls, then
  // runs on past the linked open's delay (GoalForm's 300 ms refocus).
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const bucket = page.locator(`[data-testid="goal-bucket"][data-goal-id="${goal}"]`);
  await bucket.getByRole('button', { name: /^Edit / }).click();
  await expect(bucket.getByTestId('goal-form')).toBeVisible();
  await page.getByRole('tab', { name: 'Goal buckets' }).click();
  await expect(name).not.toBeFocused();
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const at = await page.evaluate(() => window.scrollY);
  await page.clock.runFor(1000);
  await expect(name).not.toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(at);
});
