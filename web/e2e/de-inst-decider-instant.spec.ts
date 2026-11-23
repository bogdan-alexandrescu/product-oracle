import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * de-inst (the owner, Nov 23): a change by a person who may decide the roadmap is instant and
 * final; a change by a person who may only propose waits for a decider. Driven on the mock's
 * default scenario's Gantt, on a desktop.
 *
 * Card de-inst-owner-date: protects = an owner's drag of a bar is the roadmap every reader
 * reads at once: a viewer signed in after it sees the new dates and no "in review" note (no
 * review is needed for it to count); a commenter's same drag is a proposal that waits in
 * Needs a decision and leaves the bar where the owner put it; fails_when = the viewer reads
 * the old dates or is told a change is in review, or the commenter's drag applies;
 * no_claim = the drag itself (dod-roadmap-actions.spec).
 */

const URL = '/simple/roadmap';
const bar = (page: Page, key: string): Locator =>
  page.locator(`g[data-testid="bar"][data-item="${key}"]`).first();

async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId('format-gantt').click();
  await expect(bar(page, 'alert-export')).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByTestId('user-menu').click();
  await page
    .getByRole('dialog', { name: 'Account' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page).toHaveURL(/\/login/);
}

async function drag(page: Page, key: string, dx: number) {
  const body = bar(page, key).locator('rect[data-body]');
  await body.scrollIntoViewIfNeeded();
  const box = (await body.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

test.use({ viewport: { width: 1440, height: 900 } });

test("an owner's date change is live for everyone at once; a commenter's waits", async ({
  page,
}) => {
  await open(page);
  const before = await bar(page, 'alert-export').getAttribute('data-start');
  await drag(page, 'alert-export', 90);
  await expect(bar(page, 'alert-export')).not.toHaveAttribute('data-start', before!);
  const moved = await bar(page, 'alert-export').getAttribute('data-start');
  await signOut(page);

  await open(page, 'viewer@example.com');
  await expect(bar(page, 'alert-export')).toHaveAttribute('data-start', moved!);
  await expect(page.getByTestId('in-review-banner')).toHaveCount(0);
  await signOut(page);

  await open(page, 'commenter@example.com');
  await expect(bar(page, 'alert-export')).toHaveAttribute('data-start', moved!);
  await drag(page, 'alert-export', 90);
  await expect(
    page.getByText(/proposed: it waits for .+ in Needs a decision/).first(),
  ).toBeVisible();
  await expect(bar(page, 'alert-export')).toHaveAttribute('data-start', moved!);
});
