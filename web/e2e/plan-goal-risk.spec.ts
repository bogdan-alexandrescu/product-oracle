import { PLAN_LONG_KR } from '../lib/api/mock/baseline';
import { expect, test } from './test';

/**
 * #1742: a goal under 75% of its target (the Goal map's at risk) never shows a full confidence
 * ring on Plan, and a figure never read never says "Target met". #1788: a key result's name on
 * a goal card is shown whole, never cut with "…".
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('po-mock-scenario', 'plan-goal-risk'));
});

test('Plan goal cards: at risk wins over the evidence score; no reading is not Target met', async ({
  page,
}) => {
  await page.goto('/plan');
  const band = page.getByTestId('plan-goals').filter({ visible: true });
  const growth = band.getByTestId('home-goal-G2');
  await expect(growth.getByTestId('goal-confidence')).toHaveText('At risk');
  await expect(growth.getByRole('img', { name: /^Confidence/ })).toHaveCount(0);

  const activation = band.getByTestId('home-goal-G3');
  await expect(activation).toContainText('Activation');
  await expect(activation.getByTestId('goal-to-go')).toHaveText('No current value yet');
  await expect(activation.getByTestId('goal-confidence')).toHaveCount(0);
  await expect(band).not.toContainText('Target met');
});

test('Plan goal cards: a long key result reads in full', async ({ page }) => {
  await page.goto('/plan');
  const band = page.getByTestId('plan-goals').filter({ visible: true });
  const kr = band.getByTestId('home-goal-G2.1').getByTestId('code-name');
  await expect(kr).toHaveText(PLAN_LONG_KR);
  // Not cut: the text fits the box it is drawn in.
  const cut = await kr.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
  );
  expect(cut).toBe(false);
});
