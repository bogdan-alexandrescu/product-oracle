import { login, signOut } from './helpers';
import { expect, test, type Page } from './test';

/*
 * Comments on a feature (#1553): everyone who can open the app comments in the one feature
 * panel. A viewer opens a Now / Next / Later card, comments (Enter sends) and sees it at once;
 * an owner replies; the card shows the count; each edits and deletes their own. Driven against
 * the mock's default scenario (Weekly alert digest).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const card = (page: Page) => page.locator('[data-testid="board-card"][data-item="alert-digest"]');
const panel = (page: Page) => page.getByTestId('floating-card');
const comments = (page: Page) => panel(page).getByTestId('feature-comment');

async function openDigest(page: Page, email: string, again = false) {
  if (again) {
    await page.goto('/home');
    await signOut(page);
  }
  await login(page, email);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('format-board').click();
  await card(page).getByTestId('board-card-name').click();
  await expect(panel(page).getByTestId('feature-comments')).toBeVisible();
}

test('a viewer comments, an owner replies, the card counts them, each edits and deletes their own', async ({
  page,
}) => {
  await openDigest(page, 'viewer@example.com');
  await expect(card(page).getByTestId('comment-count')).toHaveCount(0);
  const field = panel(page).getByLabel('Add a comment');
  await field.fill('Can this ship before the');
  await field.press('Shift+Enter');
  await field.pressSequentially('pilot? See https://example.com/pilot');
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(comments(page)).toHaveCount(1);
  await expect(comments(page).first()).toContainText('Lena Ortiz');
  await expect(comments(page).first()).toContainText('Can this ship before the\npilot?');
  await expect(
    comments(page).first().getByRole('link', { name: 'https://example.com/pilot' }),
  ).toHaveAttribute('href', 'https://example.com/pilot');
  // Month first, never ISO: "Nov 23, 2:10 AM" style.
  await expect(comments(page).first()).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
  await expect(card(page).getByTestId('comment-count')).toHaveText('1');

  // The owner replies; the viewer's comment is theirs to delete, not to edit.
  await openDigest(page, 'admin@example.com', true);
  await expect(comments(page)).toHaveCount(1);
  const first = comments(page).first();
  await expect(first.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(first.getByRole('button', { name: 'Delete' })).toBeVisible();
  await panel(page).getByLabel('Add a comment').fill('Yes, after the pilot');
  await panel(page).getByLabel('Add a comment').press('Enter');
  await expect(comments(page)).toHaveCount(2);
  await expect(comments(page).nth(1)).toContainText('Yes, after the pilot');
  await expect(card(page).getByTestId('comment-count')).toHaveText('2');

  // The owner edits their own.
  await comments(page).nth(1).getByRole('button', { name: 'Edit' }).click();
  const edit = panel(page).getByLabel('Edit comment');
  await edit.fill('Yes, right after the pilot');
  await edit.press('Enter');
  await expect(comments(page).nth(1)).toContainText('Yes, right after the pilot');
  await expect(comments(page).nth(1)).toContainText('edited');

  // The viewer sees the reply, cannot edit or delete it, and deletes their own.
  await openDigest(page, 'viewer@example.com', true);
  await expect(comments(page)).toHaveCount(2);
  await expect(comments(page).nth(1)).toContainText('Yes, right after the pilot');
  await expect(comments(page).nth(1).getByRole('button')).toHaveCount(0);
  await comments(page).first().getByRole('button', { name: 'Edit' }).click();
  await panel(page).getByLabel('Edit comment').fill('Can this ship first?');
  await panel(page).getByLabel('Edit comment').press('Enter');
  await expect(comments(page).first()).toContainText('Can this ship first?');
  await comments(page).first().getByRole('button', { name: 'Delete' }).click();
  await expect(comments(page)).toHaveCount(1);
  await expect(card(page).getByTestId('comment-count')).toHaveText('1');

  // Still there after a reload: the mock kept them.
  await page.reload();
  await page.getByTestId('format-board').click();
  await expect(card(page).getByTestId('comment-count')).toHaveText('1');
});

test('a refused comment is taken back with the error, and the count shows only near the cap', async ({
  page,
}) => {
  await openDigest(page, 'viewer@example.com');
  const field = panel(page).getByLabel('Add a comment');
  await field.fill('x'.repeat(1700));
  await expect(panel(page).getByTestId('comment-count-left')).toHaveCount(0);
  await field.fill('x'.repeat(1850));
  await expect(panel(page).getByTestId('comment-count-left')).toHaveText('1850/2000');
  const id = await card(page).getAttribute('data-bar-id');
  await page.evaluate(
    (k) => localStorage.setItem('po-mock-fail-once', k),
    `POST /v1/simple/roadmap/items/${id}/comments`,
  );
  await field.fill('Refused one');
  await field.press('Enter');
  await expect(page.getByText('Mock failure')).toBeVisible();
  await expect(comments(page)).toHaveCount(0);
  await expect(field).toHaveValue('Refused one');
});
