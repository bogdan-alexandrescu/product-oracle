import { REPLACED_PRD_SCENARIO } from '../lib/api/mock/replaced-prd';
import { GOAL_BUCKETS_KR_TARGET_SCENARIO, MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login, openRoadmapItem } from './helpers';
import { expect, test, type Page } from './test';

/*
 * #1586 on Simple's lists and sheets: a read that failed says so (Could not ..., its reason behind
 * an (i)), never reads as "none": no code on a waiting row or an Inbox row, nothing removed, no
 * PRDs you started, no goals, no approved PRDs to replace, no proposals waiting. Each case is
 * checked both ways: answered, then failed; where the read can answer none, that is its empty
 * line with no error. A read still in flight says loading, never none. Against the mock's
 * invented data.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const failGets = (page: Page, path: string) =>
  page.evaluate((p) => localStorage.setItem('po-mock-fail', p), path);

const loadError = (page: Page, text: string) =>
  page.getByTestId('load-error').filter({ hasText: text });

const scenario = (page: Page, name: string) =>
  page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, name] as const);

async function reason(page: Page, at: ReturnType<Page['getByTestId']>) {
  await at.getByRole('button', { name: 'About the error' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Mock failure');
}

test('Home: a waiting row whose roadmap could not be read says its code could not be checked, never no code', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple');
  const list = page.getByTestId('home-also-waiting-list');
  const health = () => list.getByTestId('waiting-item').filter({ hasText: 'Health log' }).first();
  await expect(health()).toContainText('F-03');
  await expect(list.getByTestId('item-ref-failed')).toHaveCount(0);

  await failGets(page, '/v1/simple/roadmap');
  await page.reload();
  const failed = health().getByTestId('item-ref-failed');
  await expect(failed).toContainText('Could not check its code.');
  await expect(health()).not.toContainText('F-03');
  await reason(page, failed);
});

test('Inbox: a Dates row whose roadmap could not be read says its code could not be checked, never no code', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/inbox');
  const names = page.locator('[data-testid="date-suggestion-context"]').locator('xpath=..');
  await expect(names.getByTestId('feature-name').first().locator('span.simple-code')).toBeVisible();
  await expect(names.getByTestId('item-ref-failed')).toHaveCount(0);

  await failGets(page, '/v1/simple/roadmap');
  await page.reload();
  const failed = names.getByTestId('item-ref-failed').first();
  await expect(failed).toContainText('Could not check its code.');
  await expect(names.getByTestId('feature-name').first().locator('span.simple-code')).toHaveCount(
    0,
  );
  await reason(page, failed);
});

test('Roadmap: a Removed list that could not be read says so, never an empty list', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/roadmap');
  const button = page.getByTestId('removed-open');
  const list = page.getByRole('dialog', { name: 'Removed from your plans' });
  await expect(button).toHaveText(/Removed · \d+/);
  await button.click();
  await expect(list.getByTestId('removed-row').first()).toBeVisible();
  await expect(list.getByTestId('load-error')).toHaveCount(0);
  await expect(list.getByText('Nothing removed')).toHaveCount(0);
  // Answered with none: each row put back, the list says Nothing removed.
  for (;;) {
    if (!(await list.isVisible())) await button.click();
    const rows = list.getByTestId('removed-row');
    await expect(rows.first().or(list.getByText('Nothing removed'))).toBeVisible();
    if (!(await rows.count())) break;
    const was = (await button.textContent()) ?? '';
    await rows.first().getByRole('button', { name: 'Restore' }).click();
    await expect(button).not.toHaveText(was);
  }
  await expect(list.getByText('Nothing removed')).toBeVisible();
  await expect(button).toHaveText('Removed · 0');
  await expect(list.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/simple/removed');
  await page.reload();
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId('removed-open').click();
  const failed = list.getByTestId('load-error');
  await expect(failed).toContainText('Could not load what was removed.');
  await expect(list.getByTestId('removed-row')).toHaveCount(0);
  await expect(list.getByText('Nothing removed')).toHaveCount(0);
  await reason(page, failed);
});

test("Roadmap: a feature's proposals that could not be read say so, never No proposals waiting", async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/roadmap');
  await openRoadmapItem(page, 'alert-rules');
  const card = page.getByTestId('floating-card');
  await expect(card.getByText('No proposals waiting', { exact: true })).toBeVisible();
  await expect(card.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/simple/changes');
  await page.reload();
  await openRoadmapItem(page, 'alert-rules');
  const failed = page
    .getByTestId('floating-card')
    .getByTestId('load-error')
    .filter({ hasText: 'Could not load the proposals.' });
  await expect(failed).toBeVisible();
  await expect(
    page.getByTestId('floating-card').getByText('No proposals waiting', { exact: true }),
  ).toHaveCount(0);
  await reason(page, failed);
});

test("Roadmap: a feature's proposals still being read say loading, never No proposals waiting", async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('po-mock-slow', '/v1/simple/changes');
    localStorage.setItem('po-mock-slow-ms', '60000');
  });
  await page.reload();
  await openRoadmapItem(page, 'alert-rules');
  const card = page.getByTestId('floating-card');
  await expect(card.getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
  await expect(card.getByText('No proposals waiting', { exact: true })).toHaveCount(0);
  await expect(card.getByTestId('load-error')).toHaveCount(0);
});

test('Roadmap: a feature whose talk could not be read says so, never No proposals waiting', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/roadmap');
  await openRoadmapItem(page, 'alert-rules');
  const card = page.getByTestId('floating-card');
  await expect(card.getByText('No proposals waiting', { exact: true })).toBeVisible();

  await failGets(page, '/v1/simple/chat');
  await page.reload();
  await openRoadmapItem(page, 'alert-rules');
  const failed = page
    .getByTestId('floating-card')
    .getByTestId('load-error')
    .filter({ hasText: 'Could not load your talk with Oracle.' });
  await expect(failed).toBeVisible();
  await expect(
    page.getByTestId('floating-card').getByText('No proposals waiting', { exact: true }),
  ).toHaveCount(0);
  await reason(page, failed);
});

test("One-pagers: a new company's answered list says No PRDs yet, with no error", async ({
  page,
}) => {
  await scenario(page, 'empty');
  await login(page);
  await page.goto('/simple/one-pagers');
  await expect(page.getByTestId('simple-one-pagers-empty')).toContainText('No PRDs yet.');
  await expect(page.getByTestId('load-error')).toHaveCount(0);
  await expect(page.getByTestId('one-pager-row')).toHaveCount(0);
});

test('New PRD: a new company with no goals offers only Not sure yet and None: a new PRD, with no error', async ({
  page,
}) => {
  await scenario(page, 'empty');
  await login(page);
  await page.goto('/simple/one-pagers');
  await page.getByTestId('simple-one-pagers').getByRole('button', { name: 'New PRD' }).click();
  const sheet = page.getByTestId('np-sheet');
  const goals = sheet.getByRole('group', { name: 'The goals it helps' });
  await expect(goals.getByRole('button', { name: 'Not sure yet' })).toBeVisible();
  await expect(goals.getByRole('button')).toHaveCount(1);
  await expect(sheet.getByTestId('load-error')).toHaveCount(0);
  await expect(sheet.getByLabel('Approved PRD it replaces').locator('option')).toHaveText([
    'None: a new PRD',
  ]);
});

test('One-pagers: the PRDs you started that could not be read say so, never left out', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/one-pagers');
  await expect(page.getByTestId('one-pager-row').first()).toBeVisible();
  await expect(page.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/intakes');
  await page.reload();
  const failed = loadError(page, 'Could not load the PRDs you started.');
  await expect(failed).toBeVisible();
  await expect(page.getByTestId('one-pager-row').first()).toBeVisible();
  await reason(page, failed);
});

test('New PRD: goals that could not be read say so, never only Not sure yet', async ({ page }) => {
  await login(page);
  await page.goto('/simple/one-pagers');
  const open = async () => {
    await page.getByTestId('simple-one-pagers').getByRole('button', { name: 'New PRD' }).click();
    return page.getByTestId('np-sheet').getByRole('group', { name: 'The goals it helps' });
  };
  const goals = await open();
  await expect(goals.getByRole('button', { name: 'Activation' })).toBeVisible();
  await expect(goals.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/baseline/entities?type=goal&status=confirmed');
  await page.reload();
  const failedGoals = await open();
  const failed = failedGoals.getByTestId('load-error');
  await expect(failed).toContainText('Could not load the goals.');
  await expect(failedGoals.getByRole('button', { name: 'Activation' })).toHaveCount(0);
  await expect(failedGoals.getByRole('button', { name: 'Not sure yet' })).toBeVisible();
  await reason(page, failed);
});

test('New PRD: approved PRDs that could not be read say so, never only None: a new PRD', async ({
  page,
}) => {
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      REPLACED_PRD_SCENARIO,
    ] as const);
  await login(page);
  await page.goto('/simple');
  const open = async () => {
    await page.getByTestId('simple-page').getByRole('button', { name: 'New PRD' }).click();
    return page.getByTestId('np-sheet').getByRole('group', { name: /Replaces/ });
  };
  const replaces = await open();
  await expect(
    replaces
      .getByLabel('Approved PRD it replaces')
      .locator('option', { hasText: 'Usage alerts PRD' }),
  ).toHaveCount(1);
  await expect(replaces.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/documents?kind=prd');
  await page.reload();
  const failedReplaces = await open();
  const failed = failedReplaces.getByTestId('load-error');
  await expect(failed).toContainText('Could not load the approved PRDs.');
  await expect(
    failedReplaces
      .getByLabel('Approved PRD it replaces')
      .locator('option', { hasText: 'Usage alerts PRD' }),
  ).toHaveCount(0);
  await reason(page, failed);
});

test.describe('Roadmap: Needs a decision', () => {
  const tray = (page: Page) => page.getByTestId('decision-tray');

  test('proposals that could not be read say so in the tray and leave the count out, never None waiting', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/simple/roadmap');
    await expect(page.getByTestId('needs-decision')).toHaveText(/Needs a decision · \d+/);
    await page.getByTestId('needs-decision').click();
    await expect(tray(page).locator('#review-proposals')).toBeVisible();
    await expect(tray(page).locator('#review-proposals').getByTestId('load-error')).toHaveCount(0);
    // Answered with none on this roadmap: None waiting.
    await expect(tray(page).locator('#review-proposals').getByText('None waiting.')).toBeVisible();

    await failGets(page, '/v1/simple/changes');
    await page.reload();
    await expect(page.getByTestId('needs-decision')).toHaveText('Needs a decision');
    await expect(page.getByTestId('needs-decision')).not.toHaveAttribute('aria-busy', 'true');
    await page.getByTestId('needs-decision').click();
    const part = tray(page).locator('#review-proposals');
    await expect(part.getByTestId('load-error')).toContainText('Could not load the proposals.');
    await expect(part.getByText('None waiting.')).toHaveCount(0);
    await reason(page, part.getByTestId('load-error'));
  });

  test('proposals and suggested features still being read say loading in the tray, never None waiting', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/simple/roadmap');
    await expect(page.getByTestId('simple-roadmap')).toBeVisible();
    for (const path of ['/v1/simple/changes', '/v1/simple/goal-suggestions']) {
      await page.evaluate((p) => {
        localStorage.setItem('po-mock-slow', p);
        localStorage.setItem('po-mock-slow-ms', '60000');
      }, path);
      await page.reload();
      await page.getByTestId('needs-decision').click();
      const part = path.endsWith('changes')
        ? tray(page).locator('#review-proposals')
        : tray(page).getByTestId('tray-suggested');
      await expect(part.getByRole('status').filter({ hasText: 'Loading…' })).toBeVisible();
      await expect(part.getByText('None waiting.')).toHaveCount(0);
      await expect(part.getByTestId('load-error')).toHaveCount(0);
    }
  });

  test('suggested features that could not be read say so in the tray, never None waiting', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/simple/roadmap');
    await page.getByTestId('needs-decision').click();
    const suggested = tray(page).getByTestId('tray-suggested');
    await expect(suggested).toBeVisible();
    await expect(suggested.getByTestId('load-error')).toHaveCount(0);
    await expect(suggested.getByText('None waiting.')).toHaveCount(0);
    // Answered with none: each suggestion rejected, the part says None waiting.
    const flows = suggested.getByRole('button', { name: 'Show the flow' });
    while ((await flows.count()) > 0) {
      const before = await flows.count();
      await suggested.getByRole('button', { name: 'Reject' }).first().click();
      await suggested.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
      await expect(flows).toHaveCount(before - 1);
    }
    await expect(suggested.getByText('None waiting.')).toBeVisible();
    await expect(suggested.getByTestId('load-error')).toHaveCount(0);

    await failGets(page, '/v1/simple/goal-suggestions');
    await page.reload();
    await page.getByTestId('needs-decision').click();
    const part = tray(page).getByTestId('tray-suggested');
    await expect(part.getByTestId('load-error')).toContainText(
      'Could not load the suggested features.',
    );
    await expect(part.getByText('None waiting.')).toHaveCount(0);
    await reason(page, part.getByTestId('load-error'));
  });
});

test('Priorities: key results that could not be read say so, never goals with none', async ({
  page,
}) => {
  await page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [
      MOCK_SCENARIO_KEY,
      GOAL_BUCKETS_KR_TARGET_SCENARIO,
    ] as const);
  await login(page);
  await page.goto('/simple/priorities?tab=buckets');
  const krs = page
    .locator('[data-testid="plan-goal"][data-goal="Grow retention"]')
    .getByRole('list', { name: "Grow retention's key results" });
  await expect(
    krs.getByTestId('goal-kr').filter({ hasText: 'Teams read their alerts' }),
  ).toHaveCount(1);
  await expect(loadError(page, 'Could not load the key results.')).toHaveCount(0);
  // Answered with none for a goal: no key results and no error.
  await expect(
    page.locator('[data-testid="plan-goal"][data-goal="Faster activation"]').getByTestId('goal-kr'),
  ).toHaveCount(0);

  await failGets(page, '/v1/baseline/entities?type=goal');
  await page.reload();
  const failed = loadError(page, 'Could not load the key results.');
  await expect(failed).toBeVisible();
  await expect(krs.getByTestId('goal-kr')).toHaveCount(0);
  await reason(page, failed);
});

test('Priorities: goal buckets whose roadmap could not be read say so, never features with no actions', async ({
  page,
}) => {
  await scenario(page, 'simple-plan');
  await login(page);
  await page.goto('/simple/priorities?tab=buckets');
  const growth = page.locator('[data-testid="plan-goal"][data-goal="Growth"]');
  await expect(growth.getByRole('button', { name: /^Edit / }).first()).toBeVisible();
  await expect(loadError(page, 'Could not load the roadmap.')).toHaveCount(0);

  await failGets(page, '/v1/simple/roadmap');
  await page.reload();
  const failed = loadError(page, 'Could not load the roadmap.');
  await expect(failed).toBeVisible();
  await reason(page, failed);
});

test("Priorities: a goal's owner pick whose people could not be read says so, never no one to pick", async ({
  page,
}) => {
  await scenario(page, 'simple-plan');
  await login(page);
  await page.goto('/simple/priorities?tab=buckets');
  const edit = async () => {
    const card = page.locator('[data-testid="plan-goal"][data-goal="Growth"]');
    await card.getByRole('button', { name: 'Edit Growth' }).click();
    return card.getByTestId('goal-form');
  };
  const form = await edit();
  await expect(form.getByLabel('Owner').locator('option', { hasText: 'Theo Brandt' })).toHaveCount(
    1,
  );
  await expect(form.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/people');
  await page.reload();
  const failedForm = await edit();
  const failed = failedForm.getByTestId('load-error');
  await expect(failed).toContainText('Could not load the people.');
  await expect(failedForm.getByLabel('Owner')).toHaveCount(0);
  await reason(page, failed);
});

test("Roadmap: a feature's owner pick whose people could not be read says so, never no one to pick", async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/roadmap');
  const change = async () => {
    await openRoadmapItem(page, 'alert-digest');
    const card = page.getByTestId('floating-card');
    await card.getByRole('button', { name: 'Change the owner' }).click();
    return card.getByTestId('card-owner-edit');
  };
  const edit = await change();
  await expect(edit.getByLabel('Owner').locator('option').nth(1)).toBeAttached();
  await expect(edit.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/people');
  await page.reload();
  const failedEdit = await change();
  const failed = failedEdit.getByTestId('load-error');
  await expect(failed).toContainText('Could not load the people.');
  await expect(failedEdit.getByLabel('Owner')).toHaveCount(0);
  await reason(page, failed);
});

test("Roadmap: dates to confirm whose parts' dates could not be read say so, never a row with no part lines", async ({
  page,
}) => {
  await scenario(page, 'simple-plan');
  await login(page);
  await page.goto('/simple/roadmap');
  const open = async () => {
    await page.getByTestId('needs-decision').click();
    return page.getByTestId('decision-tray').locator('#tray-dates');
  };
  const dates = await open();
  const row = dates.getByTestId('tray-date').filter({ hasText: 'Self-serve checkout:' });
  await expect(row.getByTestId('tray-date-slice')).toHaveCount(2);
  await expect(dates.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/simple/roadmap/date-suggestions');
  await page.reload();
  const failedDates = await open();
  const failed = failedDates.getByTestId('load-error');
  await expect(failed).toContainText('Could not load the dates of the parts.');
  await expect(
    failedDates.getByTestId('tray-date').filter({ hasText: 'Self-serve checkout:' }),
  ).toHaveCount(1);
  await reason(page, failed);
});
