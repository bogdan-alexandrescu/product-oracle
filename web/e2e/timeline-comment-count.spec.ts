import { login } from './helpers';
import { expect, test } from './test';

/*
 * timeline-order (owner, Nov 23): the Roadmap Timeline's rows show the comment count the
 * Now / Next / Later cards show, only once the feature has a comment. A viewer opens the
 * Weekly alert digest's row, comments in its feature panel and sees the count on the row.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test('a comment added in the feature panel shows its count on the Timeline row', async ({
  page,
}) => {
  await login(page, 'viewer@example.com');
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('format-timeline').click();
  const row = page.locator('[data-testid="timeline-row"][data-item="alert-digest"]').first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('comment-count')).toHaveCount(0);
  await row.getByTestId('timeline-row-label').click();
  const panel = page.getByTestId('floating-card');
  await expect(panel.getByTestId('feature-comments')).toBeVisible();
  const field = panel.getByLabel('Add a comment');
  await field.fill('Can this ship before the pilot?');
  await field.press('Enter');
  await expect(panel.getByTestId('feature-comment')).toHaveCount(1);
  await expect(row.getByTestId('comment-count')).toHaveText('1');
  await expect(page.getByTestId('timeline-row').getByTestId('comment-count')).toHaveCount(1);
});
