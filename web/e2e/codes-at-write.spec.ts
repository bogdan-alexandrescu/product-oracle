import { COMPANY_TITLE, OLD_ITEM, SHARED_CODE_SCENARIO } from '../lib/api/mock/one-roadmap';
import { CODES_AT_WRITE_SCENARIO, MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login, openRoadmapItem } from './helpers';
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
  await expect(badge.getByTestId('prio-adds')).toHaveText(`Not on ${COMPANY_TITLE}`);
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

/*
 * codes-at-write on the Roadmap, as the owner, on the "codes-at-write" scenario (invented data):
 * Welcome video shows F-05 (Team invites') as its own, and Sample data import shows F-01, the code
 * Setup checklist takes from its feature. Linking a draft to Team invites, or bringing Setup
 * checklist back from Trash, gives the item its own number; neither is refused.
 */
async function onRoadmap(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      CODES_AT_WRITE_SCENARIO,
    ] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

const panel = (page: Page) => page.getByTestId('floating-card');

async function codeOf(page: Page, key: string): Promise<string> {
  await openRoadmapItem(page, key);
  const code = panel(page).getByTestId('card-code');
  await expect(code).toBeVisible();
  // The code it shows, before the note on its feature ("Part of the Ground Truth feature …").
  const text = /^[A-Z]+-\d+/.exec((await code.textContent())!.trim())?.[0] ?? '';
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  return text;
}

// protects=Merge into a feature whose code another item shows as its own links the draft and
// gives it its own number (changes._merge_plan, change.numbered); fails_when=the link is refused
// ("F-05 is already the code of ...") or two items read F-05; no_claim=a proposal (pytest).
test('a draft merged into a feature whose code another item shows gets its own number', async ({
  page,
}) => {
  await onRoadmap(page);
  await openRoadmapItem(page, 'setup-ideas');
  await panel(page).getByRole('button', { name: 'Merge into Team invites' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Merged' })).toBeVisible();
  const own = panel(page).getByTestId('card-code');
  await expect(own).toHaveText(/^F-\d+$/);
  await expect(own).not.toHaveText('F-05');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  expect(await codeOf(page, 'setup-video')).toBe('F-05');
});

// protects=Restore from Settings › Trash of an item whose feature's code another item took
// meanwhile brings it back with its own number (trash/service.restore_entry, codes.claim);
// fails_when=the restore is refused ("...: rename it first") or two items read F-01;
// no_claim=a typed code taken meanwhile (refused, every-field-kr-goal-code.spec.ts).
test('an item restored whose feature code another item shows comes back with its own number', async ({
  page,
}) => {
  await onRoadmap(page);
  const bar = page.locator(
    '[data-testid="timeline-row"][data-item="setup-checklist"] [data-testid="timeline-bar"]',
  );
  await bar.click({ button: 'right' });
  await page.getByTestId('feature-menu').getByRole('menuitem', { name: 'Delete feature' }).click();
  await expect(page.getByTestId('toasts')).toContainText('to Trash.');
  await expect(bar).toHaveCount(0);

  await page.goto('/settings/trash');
  const row = page.getByTestId('trash-entry').filter({ hasText: 'Setup checklist' });
  await row.getByRole('button', { name: /^Restore / }).click();
  await expect(row).toHaveCount(0);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  const code = await codeOf(page, 'setup-checklist');
  expect(code).toMatch(/^F-\d+$/);
  expect(code).not.toBe('F-01');
  expect(await codeOf(page, 'setup-import')).toBe('F-01');
});
