import { login } from './helpers';
import { expect, test, type Locator } from './test';

/*
 * train night-m: Simple's Inbox keeps both column rules at 1512 and on a phone, as at 1440
 * (qa-leftovers): a "For" cell wraps and is never cut, and the Item cell is the row's widest
 * (#1912). Mock API, invented data.
 */

async function whole(l: Locator) {
  await expect(l).toBeVisible();
  expect(
    await l.evaluate(
      (e) => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1,
    ),
  ).toBe(true);
}

for (const size of [
  { width: 1512, height: 945 },
  { width: 390, height: 844 },
]) {
  test(`Simple Inbox at ${size.width}: the For cells wrap, never cut, and Item is the widest`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await login(page);
    await page.goto('/simple/inbox');
    const needs = page.getByTestId('inbox-needs');
    await whole(needs.locator('span[title="I lead support and need to read the PRD."]').first());
    const gt = needs.locator('.truncate', { hasText: /Ground Truth proposal · Team onboarding/ });
    await whole(gt.last());
    if (size.width < 600) return;
    const row = gt.last().locator('xpath=ancestor::tr[1]');
    const widths = await row.evaluate((r) =>
      [...r.querySelectorAll(':scope > td')].map((td) => td.getBoundingClientRect().width),
    );
    expect(widths[1], `item of ${widths.join(', ')}`).toBe(Math.max(...widths));
  });
}
