import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';

import { login, openRoadmapItem } from './helpers';
import { expect, test } from './test';

/*
 * panel-target (#1907): the mock's "panel-words-live" scenario (invented data) ends the goal's
 * target the way the live one does, each milestone code followed by a word or a number:
 * "70% of teams (M1 pilot, M2 40)". The feature panel's Target and Reading lines drop it.
 */

test.use({ viewport: { width: 1512, height: 756 } });

test('Target and Reading drop a milestone bracket whose codes carry words', async ({
  context,
  page,
}) => {
  await context.addInitScript(
    (key) => localStorage.setItem(key, 'panel-words-live'),
    MOCK_SCENARIO_KEY,
  );
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-digest');
  const panel = page.getByTestId('floating-card');
  await expect(panel).toBeVisible();
  await expect.soft(panel.getByTestId('card-goal-target')).toHaveText('70% of teams');
  const reading = panel.getByTestId('card-goal-reading');
  await expect(reading).toContainText('target 70% of teams by');
  await expect(reading).not.toContainText('M1');
  await expect(reading).not.toContainText('M2');
});
