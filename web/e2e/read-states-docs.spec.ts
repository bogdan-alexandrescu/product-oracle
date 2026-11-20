import { expect, test, type Page } from './test';

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';

/*
 * #1586, documents and runs: "could not ask" and "the answer is none" never look alike. Each
 * case is checked both ways: first answered (the content, no load error), then the read made
 * to fail, where the page says so with its reason behind an (i) and keeps the rest.
 */

const failGets = (page: Page, path: string) =>
  page.evaluate((p) => localStorage.setItem('po-mock-fail', p), path);
const scenario = (page: Page, s: string) =>
  page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);

/** The path of the first mock GET (query left off) that matches `re`, once it was made. */
async function calledPath(page: Page, re: RegExp): Promise<string> {
  const handle = await page.waitForFunction(
    (src) =>
      ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])
        .map((l) => l.replace(/^GET /, '').split('?')[0])
        .find((p) => new RegExp(src).test(p)),
    re.source,
  );
  return (await handle.jsonValue()) as string;
}

/** The visible load error saying "Could not load `what`.", with the mock's reason behind its (i). */
async function expectFailed(page: Page, what: string) {
  const failed = page
    .getByTestId('load-error')
    .filter({ visible: true })
    .filter({ hasText: `Could not load ${what}.` });
  await expect(failed).toHaveCount(1);
  await failed.getByRole('button', { name: 'About the error' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Mock failure');
}

const noLoadError = (page: Page) =>
  expect(page.getByTestId('load-error').filter({ visible: true })).toHaveCount(0);

test('Quality: sections that could not be read say so in the rating form, never no sections to pick', async ({
  page,
}) => {
  await scenario(page, 'quality');
  await page.addInitScript((key) => localStorage.setItem(key, 'commenter'), MOCK_ROLE_KEY);
  await login(page);
  await page.goto('/documents/team-invites/v/2/quality');
  const row = page.locator('[data-testid="criterion-row"][data-key="alternatives_tradeoffs"]');
  await row.click();
  const form = page.getByTestId('quality-inspector').getByTestId('rating-form');
  await expect(form.getByLabel('Add a section')).toBeVisible();
  await expect(form.getByLabel('Add a section').locator('option[value="problem"]')).toBeAttached();
  await noLoadError(page);
  const path = await calledPath(page, /^\/v1\/documents\/[^/]+\/versions\/2$/);

  await failGets(page, path);
  await page.reload();
  await page.locator('[data-testid="criterion-row"][data-key="alternatives_tradeoffs"]').click();
  const failedForm = page.getByTestId('quality-inspector').getByTestId('rating-form');
  await expect(failedForm.getByTestId('load-error')).toContainText('Could not load the sections.');
  await expect(failedForm.getByLabel('Add a section')).toHaveCount(0);
  await expectFailed(page, 'the sections');
});

test('Draft: new items in your sources that could not be counted say so, never no line', async ({
  page,
}) => {
  await scenario(page, 'draft-new-items');
  await login(page);
  await page.goto('/settings/sources');
  const source = page.getByRole('listitem', { name: 'Product chat' });
  await source.getByRole('button', { name: 'Sync now' }).click();
  await expect(source.getByRole('status')).toContainText('Synced:');
  await page.goto('/documents/usage-alerts/v/2');
  const banner = page.getByTestId('draft-new-items').filter({ visible: true });
  await expect(banner).toContainText(
    '1 new or changed item in your sources since draft v2 read them',
  );
  await noLoadError(page);
  const path = await calledPath(page, /^\/v1\/documents\/[^/]+\/versions\/2\/new-items$/);

  await failGets(page, path);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: /^Usage alerts PRD/ })).toBeVisible();
  await expectFailed(page, 'the new items');
  await expect(page.getByTestId('draft-new-items').filter({ visible: true })).toHaveCount(0);
});

test('Design: a PRD that could not be read says so, the design still shown', async ({ page }) => {
  await login(page, 'approver@example.com');
  await page.goto(
    '/specs/c3000000-0000-4000-8000-000000000001/design/c3000000-0000-4000-8000-000000000012',
  );
  const stale = page.getByTestId('stale-notice').filter({ visible: true });
  await expect(stale).toContainText('Section "5.2 Billing step" changed in Annual billing PRD');
  await noLoadError(page);
  await calledPath(page, /^\/v1\/documents\/annual-billing$/);

  await failGets(page, '/v1/documents/annual-billing');
  await page.reload();
  await expectFailed(page, 'the PRD');
  await expect(page.getByTestId('stale-notice').filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId('stale-notice').filter({ visible: true })).not.toContainText(
    '5.2 Billing step',
  );
});

test.describe('Roadmap items', () => {
  const ITEMS = '/documents/usage-alerts-roadmap/v/1/items';
  const behaviourPrd = (page: Page) =>
    page
      .locator('[data-testid="roadmap-item-row"][data-key="item-behaviour"]')
      .filter({ visible: true })
      .getByRole('link', { name: /^§/ });

  test.beforeEach(async ({ page }) => {
    await scenario(page, 'roadmap-items');
    await login(page);
    await page.goto(ITEMS);
  });

  test("the PRD's section names that could not be read say so, the items still listed", async ({
    page,
  }) => {
    await expect(behaviourPrd(page)).toHaveText('§ 1. Behaviour');
    await noLoadError(page);
    const path = await calledPath(page, /^\/v1\/documents\/usage-alerts\/versions\/1$/);

    await failGets(page, path);
    await page.reload();
    await expect(page.getByTestId('items-summary').filter({ visible: true })).toHaveText(
      '2 items · 1 Now · 1 Next · 0 Later',
    );
    await expectFailed(page, "the PRD's section names");
    await expect(behaviourPrd(page)).not.toHaveText('§ 1. Behaviour');
  });

  test('milestone references that could not be read say so, the items still listed', async ({
    page,
  }) => {
    const row = page
      .locator('[data-testid="roadmap-item-row"][data-key="item-behaviour"]')
      .filter({ visible: true });
    await row.click();
    const milestone = page
      .getByTestId('roadmap-item-inspector')
      .filter({ visible: true })
      .getByTestId('item-milestone');
    await expect(milestone).toContainText('ENG-412');
    await noLoadError(page);
    await calledPath(page, /^\/v1\/schedule-bases$/);

    await failGets(page, '/v1/schedule-bases');
    await page.reload();
    await expect(page.getByTestId('items-summary').filter({ visible: true })).toHaveText(
      '2 items · 1 Now · 1 Next · 0 Later',
    );
    await expectFailed(page, 'the milestone references');
  });
});

test('Runs: document names that could not be read say so, the runs still listed', async ({
  page,
}) => {
  await login(page);
  await page.goto('/runs');
  const named = page
    .locator('[data-testid="run-row"][data-document="team-onboarding"]')
    .getByRole('link')
    .first();
  await expect(named).toHaveText('Team onboarding PRD');
  await noLoadError(page);
  await calledPath(page, /^\/v1\/documents$/);

  await failGets(page, '/v1/documents');
  await page.reload();
  await expect(page.getByTestId('run-row')).toHaveCount(5);
  await expectFailed(page, 'the document names');
});
