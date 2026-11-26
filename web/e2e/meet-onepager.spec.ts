import { login, openRoadmapItem } from './helpers';
import { expect, test } from './test';

/**
 * meet-onepager (#1914, #1915), on the mock's invented data.
 *
 * protects = #1914: an upcoming review whose occurrence is not made yet (its pre-read is not due)
 * says nothing about its pre-read, so no row reads "Pre-read not ready yet";
 * #1915: a PRD's version reads "draft n" on One-pagers as in a feature's "From <PRD> (draft n)",
 * and the chip says when a newer draft is in progress.
 * fails_when = the row still says "not ready yet"; the chip reads "Approved" or "Approved v1";
 * the card's line has no "(draft n)" or cites a draft One-pagers does not show.
 */

test('#1914: an upcoming review with no pre-read due yet says nothing about it', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/meetings');
  const rows = page.getByTestId('meetings-upcoming-row');
  await expect(rows.first()).toBeVisible();
  const none = rows.filter({ hasNot: page.getByTestId('meetings-pre-read-link') });
  await expect(none.first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Upcoming' })).not.toContainText('not ready');
});

test('#1915: One-pagers and the feature card name the same draft wording', async ({ page }) => {
  await login(page);
  await page.goto('/simple/one-pagers');
  const row = page.getByTestId('one-pager-row').filter({ hasText: 'Usage alerts' }).first();
  const chip = row.locator('[data-status]');
  await expect(chip).toHaveText(/^Approved draft \d+( · .+)?$/);
  const [, n, newer] = /^Approved draft (\d+)( · .+)?$/.exec((await chip.textContent()) ?? '')!;
  await page.goto('/simple/roadmap');
  await openRoadmapItem(page, 'alert-digest');
  const reasons = page.getByTestId('floating-card').getByTestId('card-reasons');
  // The card cites the draft One-pagers shows, or a newer one only while the chip says so.
  if (newer) await expect(reasons).toContainText(/From Usage alerts \(draft \d+\): /);
  else await expect(reasons).toContainText(`From Usage alerts (draft ${n}): `);
});
