import { COMPANY_TITLE, OLD_ITEM, SHARED_CODE_SCENARIO } from '../lib/api/mock/one-roadmap';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test } from './test';

import type { Page } from '@playwright/test';

/*
 * codes-at-write (the owner, Nov 23: "Number them at write"). Simple › Priorities, as the owner,
 * on the "shared-code" scenario (invented data): Trusted seller badge takes F-40 from its PRD
 * section, and Seller ratings on the company roadmap shows F-40 already. The owner's move adds
 * the badge to the company roadmap; it shows its own number at once, never a second F-40, and
 * the move is not refused.
 */

async function setUp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      SHARED_CODE_SCENARIO,
    ] as const);
  await login(page);
  await page.goto('/simple/priorities');
  await expect(page.getByTestId('simple-priorities')).toBeVisible();
  await expect(page.getByText('Loading priorities…')).toHaveCount(0);
}

const rowByTitle = (page: Page, title: string) =>
  page.getByTestId('prio-row').filter({ has: page.getByTestId('prio-title').getByText(title) });

test('a feature added from Priorities while its code is shown on the roadmap gets its own number', async ({
  page,
}) => {
  await setUp(page);
  const badge = rowByTitle(page, OLD_ITEM);
  await expect(badge.getByTestId('prio-adds')).toHaveText(
    `Not on ${COMPANY_TITLE} yet: moving it adds it there, under Later.`,
  );
  await badge.getByRole('button', { name: /^Drag .* to reorder$/ }).focus();
  await page.keyboard.press('ArrowUp');
  const dialog = page.getByRole('dialog', { name: /^Why move / });
  await dialog.getByLabel('Reason').fill('Sellers asked for it at the example.com meetup');
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(badge.getByTestId('prio-adds')).toHaveCount(0);
  const own = badge.getByTestId('prio-own-key');
  await expect(own).toHaveText(/^F-\d+$/);
  await expect(own).not.toHaveText('F-40');
  // Seller ratings keeps F-40: one item, one code.
  await expect(rowByTitle(page, 'Seller ratings').getByTestId('prio-own-key')).toHaveText('F-40');
  const code = (await own.textContent())!.trim();
  // The company roadmap reads the badge with its own number.
  await page
    .getByRole('link', { name: 'Roadmap', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page
      .getByTestId('simple-roadmap')
      .getByRole('button', { name: `${code} ${OLD_ITEM}`, exact: true })
      .first(),
  ).toBeAttached();
  await expect(
    page
      .getByTestId('simple-roadmap')
      .getByRole('button', { name: `F-40 ${OLD_ITEM}`, exact: true }),
  ).toHaveCount(0);
});
