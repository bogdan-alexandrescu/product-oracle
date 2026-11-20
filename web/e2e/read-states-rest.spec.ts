import { expect, test, type Page } from './test';

import { login } from './helpers';

/*
 * #1586 (phase 2, the pages outside Home, Simple, PRDs and the Inbox): a read that failed says
 * so, with its reason behind an (i), never the empty state an answer of none would draw. Each
 * case is checked both ways: answered first, then failed.
 */

const failGets = (page: Page, path: string) =>
  page.evaluate((p) => localStorage.setItem('po-mock-fail', p), path);

/** The first GET the mock answered whose path (with its query) matches `re`. */
async function calledUrl(page: Page, re: RegExp): Promise<string> {
  const handle = await page.waitForFunction(
    (src) =>
      ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])
        .map((l) => l.replace(/^GET /, ''))
        .find((p) => new RegExp(src).test(p)),
    re.source,
  );
  return (await handle.jsonValue()) as string;
}

async function seesReason(page: Page, scope: ReturnType<Page['getByTestId']>, what: string) {
  const failed = scope.getByTestId('load-error');
  await expect(failed).toContainText(`Could not load ${what}.`);
  await failed.getByRole('button', { name: 'About the error' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Mock failure');
}

async function openActivation(page: Page) {
  await page.goto('/ground-truth');
  await page.getByTestId('goal-g.activation').getByRole('button', { name: 'Activation' }).click();
  return page.getByRole('dialog', { name: 'Activation' });
}

test("Ground Truth: a goal's values that could not be read say so, never no values yet", async ({
  page,
}) => {
  await login(page);
  let d = await openActivation(page);
  await expect(d.getByTestId('goal-measurements').getByTestId('measurement-row')).toHaveCount(7);
  await expect(d.getByTestId('goal-measurements').getByTestId('load-error')).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\/[^/?]+\/measurements/);

  await failGets(page, url.split('?')[0]);
  await page.reload();
  d = await openActivation(page);
  await seesReason(page, d.getByTestId('goal-measurements'), 'the values');
  await expect(d.getByTestId('goal-measurements')).not.toContainText(
    /No values recorded yet|No dated values yet/,
  );
  await expect(d.getByTestId('goal-measurements').getByTestId('measurement-row')).toHaveCount(0);
});

test("Ground Truth: an item's history that could not be read says so, never no changes", async ({
  page,
}) => {
  await login(page);
  let d = await openActivation(page);
  await expect(d.getByTestId('entity-history').getByRole('listitem').last()).toContainText(
    'Created',
  );
  await expect(d.getByTestId('entity-history').getByTestId('load-error')).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\/[^/?]+\/revisions/);

  await failGets(page, url.split('?')[0]);
  await page.reload();
  d = await openActivation(page);
  await seesReason(page, d.getByTestId('entity-history'), 'the history');
  await expect(d.getByTestId('entity-history')).not.toContainText('No changes recorded');
  await expect(d.getByTestId('entity-history').getByRole('listitem')).toHaveCount(0);
});

const inspector = (page: Page) => page.getByTestId('request-inspector').filter({ visible: true });

async function openRequest(page: Page) {
  await page.goto('/requests');
  const title = 'Keep the delivery address between orders';
  await page
    .getByTestId('request-row')
    .filter({ hasText: title })
    .getByRole('button', { name: title })
    .click();
  await expect(inspector(page).getByRole('heading', { name: title })).toBeVisible();
  return inspector(page).getByRole('group', { name: 'Goals' });
}

test('Requests: goals that could not be read say so, never no confirmed goals yet', async ({
  page,
}) => {
  await login(page);
  let goals = await openRequest(page);
  await expect(goals.getByRole('checkbox').first()).toBeVisible();
  await expect(goals.getByTestId('load-error')).toHaveCount(0);
  const url = await calledUrl(
    page,
    /^\/v1\/baseline\/entities\?(?=.*type=goal)(?=.*status=confirmed)/,
  );

  await failGets(page, url);
  await page.reload();
  goals = await openRequest(page);
  await seesReason(page, goals, 'the goals');
  await expect(goals).not.toContainText('No confirmed goals yet');
  await expect(goals.getByRole('checkbox')).toHaveCount(0);
});

test("Decisions: a linked item's evidence that could not be read says so, never no evidence", async ({
  page,
}) => {
  await login(page, 'commenter@example.com');
  await page.goto('/company/decisions');
  const propose = async () => {
    await page.getByRole('button', { name: 'Propose decision' }).click();
    const dialog = page.getByRole('dialog', { name: 'Propose decision' });
    const linked = dialog.getByRole('group', { name: 'Linked items' });
    await linked.getByLabel('Find an item to link').fill('checklist');
    await linked.getByRole('button', { name: /^Setup checklist · Feature/ }).click();
    return dialog.getByRole('group', { name: 'Evidence' });
  };
  let evidence = await propose();
  await expect(
    evidence.getByRole('checkbox', { name: /New accounts stall before adding a payment method/ }),
  ).toBeVisible();
  await expect(evidence.getByTestId('load-error')).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\/[^/?]+$/);

  await failGets(page, url);
  await page.reload();
  evidence = await propose();
  await seesReason(page, evidence, 'the evidence');
  await expect(evidence).not.toContainText('No evidence on this item');
  await expect(evidence.getByRole('checkbox')).toHaveCount(0);
});

test('Brief: goals that could not be read say so, never no confirmed company goal yet', async ({
  page,
}) => {
  await login(page, 'approver@example.com');
  await page.goto('/documents/new');
  await page.getByRole('textbox', { name: 'Title' }).fill('Saved carts for repeat buyers');
  await page
    .getByRole('textbox', { name: 'What problem does it solve?' })
    .fill('Returning buyers lose their cart between visits.');
  await page.getByRole('button', { name: 'Continue' }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  const goals = page.getByTestId('intake-goals');
  await expect(goals).toContainText('No goal chosen yet');
  await expect(goals.getByTestId('load-error')).toHaveCount(0);
  const url = await calledUrl(
    page,
    /^\/v1\/baseline\/entities\?(?=.*type=goal)(?=.*status=confirmed)/,
  );

  await failGets(page, url);
  await page.reload();
  await seesReason(page, page.getByTestId('intake-goals'), 'the goals');
  await expect(page.getByTestId('intake-goals')).not.toContainText(
    /No goal chosen yet|No confirmed company goal yet/,
  );
});

test('Ground Truth: a goal with no values and no history, answered, says so', async ({ page }) => {
  await login(page);
  await page.goto('/ground-truth');
  await page
    .getByTestId('goal-g.early-churn')
    .getByRole('button', { name: 'Cut early churn' })
    .click();
  const d = page.getByRole('dialog', { name: 'Cut early churn' });
  await expect(d.getByTestId('goal-measurements')).toContainText(
    'Give the goal its unit, then record values here',
  );
  await expect(d.getByTestId('entity-history')).toContainText('No changes recorded');
  await expect(d.getByTestId('load-error')).toHaveCount(0);
});

test('Decisions: a linked item with no evidence, answered, says so', async ({ page }) => {
  await login(page, 'commenter@example.com');
  await page.goto('/company/decisions');
  await page.getByRole('button', { name: 'Propose decision' }).click();
  const dialog = page.getByRole('dialog', { name: 'Propose decision' });
  const linked = dialog.getByRole('group', { name: 'Linked items' });
  await linked.getByLabel('Find an item to link').fill('churn');
  await linked.getByRole('button', { name: /^Cut early churn · Goal/ }).click();
  const evidence = dialog.getByRole('group', { name: 'Evidence' });
  await expect(evidence).toContainText('No evidence on this item');
  await expect(evidence.getByTestId('load-error')).toHaveCount(0);
});

// Review round 1: the reads the first pass missed, each answered first, then failed.

test("Requests: New request's goals that could not be read say so, never no goals yet", async ({
  page,
}) => {
  await login(page);
  await page.goto('/requests');
  const goals = async () => {
    await page.getByRole('button', { name: 'New request' }).first().click();
    return page
      .getByRole('dialog', { name: 'New request' })
      .getByRole('group', { name: 'Goal (optional)' });
  };
  let g = await goals();
  await expect(g.getByTestId('new-request-goal').first()).toBeVisible();
  await expect(g.getByTestId('load-error')).toHaveCount(0);
  const url = await calledUrl(page, /^\/v1\/baseline\/entities\?type=goal$/);

  await failGets(page, url);
  await page.reload();
  g = await goals();
  await seesReason(page, g, 'the goals');
  await expect(g).not.toContainText('No goals yet');
  await expect(g.getByTestId('new-request-goal')).toHaveCount(0);
});

test('Requests: New request with no goals, answered, says no goals yet', async ({ page }) => {
  await page.goto('/icon.svg');
  await page.evaluate(() => {
    localStorage.removeItem('po-mock-db-v2');
    localStorage.setItem('po-mock-scenario', 'empty');
  });
  await login(page);
  await page.goto('/requests');
  await page.getByRole('button', { name: 'New request' }).first().click();
  const g = page
    .getByRole('dialog', { name: 'New request' })
    .getByRole('group', { name: 'Goal (optional)' });
  await expect(g).toContainText('No goals yet');
  await expect(g.getByTestId('load-error')).toHaveCount(0);
});

test('Version: held rewrites that could not be read say so, never no held rewrites', async ({
  page,
}) => {
  await login(page);
  await page.goto('/documents/annual-billing/v/2');
  const button = page.getByRole('button', { name: /^Held rewrites/ }).filter({ visible: true });
  await expect(button.getByTestId('held-count')).toHaveText(/^[1-9]\d*$/);
  const url = await calledUrl(page, /^\/v1\/documents\/[^/?]+\/section-patches/);

  await failGets(page, url.split('?')[0]);
  await page.reload();
  await expect(page.getByTestId('document-sections')).toBeVisible();
  await expect(button.getByTestId('held-count')).toHaveCount(0);
  await button.click();
  const held = page.getByTestId('held-rewrites').filter({ visible: true });
  await seesReason(page, held, 'the held rewrites');
  await expect(held).not.toContainText('No held rewrites.');
});

test('Version: a version with no held rewrites, answered, shows no Held rewrites', async ({
  page,
}) => {
  await login(page);
  await page.goto('/documents/team-invites/v/2');
  await expect(page.getByTestId('document-sections')).toBeVisible();
  await calledUrl(page, /^\/v1\/documents\/[^/?]+\/section-patches/);
  await expect(page.getByRole('button', { name: /^Held rewrites/ })).toHaveCount(0);
  await expect(page.getByTestId('load-error')).toHaveCount(0);
});

test('Plan: the tech briefs that could not be read say so, never a lasting …', async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [
    'po-mock-scenario',
    'plan-decider',
  ] as const);
  await login(page);
  const open = async () => {
    await page.goto('/plan');
    const title = 'Threshold alerts on spend';
    await page
      .getByTestId('plan-row')
      .filter({ visible: true })
      .filter({ hasText: title })
      .getByTestId('plan-title')
      .click();
    await page
      .getByTestId('plan-inspector')
      .filter({ visible: true })
      .getByTestId('plan-spec')
      .getByRole('button', { name: 'Request spec' })
      .click();
    return page
      .getByRole('dialog', { name: 'Request an engineering spec' })
      .getByTestId('request-spec-brief');
  };
  let brief = await open();
  await expect(brief).toContainText('Feasible');
  await expect(brief.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/tech-briefs');
  brief = await open();
  await seesReason(page, brief, 'the tech briefs');
  await expect(brief).not.toContainText('…');
  await expect(brief).not.toContainText('No approved tech brief for this feature.');
});

async function openRitual(page: Page) {
  await page.goto('/company/rituals');
  await page.getByTestId('ritual-row').filter({ hasText: 'Quarterly goals review' }).click();
  return page
    .getByTestId('ritual-inspector')
    .filter({ visible: true })
    .getByTestId('ritual-occurrences');
}

test('Rituals: occurrences that could not be read say so, never nothing', async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [
    'po-mock-scenario',
    'rituals',
  ] as const);
  await login(page);
  let recent = await openRitual(page);
  // Answered: its occurrences, or that there is no pre-read yet.
  await expect(
    recent.getByRole('link').or(recent.getByText('No pre-read yet')).first(),
  ).toBeVisible();
  await expect(recent.getByTestId('load-error')).toHaveCount(0);
  // The last one read: the page may open another ritual's inspector first.
  const url = await page.evaluate(() =>
    ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])
      .map((l) => l.replace(/^GET /, ''))
      .filter((p) => /^\/v1\/rituals\/[^/?]+\/occurrences/.test(p))
      .at(-1)!,
  );

  await failGets(page, url.split('?')[0]);
  await page.reload();
  recent = await openRitual(page);
  await seesReason(page, recent, 'the occurrences');
  await expect(recent).not.toContainText('No pre-read yet');
  await expect(recent.getByRole('link')).toHaveCount(0);
});

test('Plan: date sources that could not be read say so, never no date sources yet', async ({
  page,
}) => {
  await login(page);
  await page.goto('/plan/dates');
  const table = page.getByTestId('dates-table').filter({ visible: true });
  await expect(table.locator('[data-basis]').first()).toBeVisible();

  await failGets(page, '/v1/schedule-bases');
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Mock failure' }).first()).toBeVisible();
  await expect(page.getByText('No date sources yet.')).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
});

test('Plan: roadmap items that could not be read say so, never no roadmap items yet; answered none says so', async ({
  page,
}) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [
    'po-mock-scenario',
    'plan-timeline',
  ] as const);
  await login(page);
  await page.goto('/plan');
  const bar = page.getByTestId('plan-scope-bar');
  await bar
    .getByRole('group', { name: 'Plan scope' })
    .getByRole('button', { name: 'Approved only', exact: true })
    .click();
  await expect(
    page.getByTestId('plan-table').filter({ visible: true }).getByTestId('table-empty'),
  ).toHaveText('No roadmap items yet');

  await failGets(page, '/v1/plan');
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Mock failure' }).first()).toBeVisible();
  await expect(page.getByText('No roadmap items yet')).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
});

test('Decisions: Ground Truth items that could not be read say so, never no item matches', async ({
  page,
}) => {
  await login(page, 'commenter@example.com');
  const find = async (text: string) => {
    await page.goto('/company/decisions');
    await page.getByRole('button', { name: 'Propose decision' }).click();
    const linked = page
      .getByRole('dialog', { name: 'Propose decision' })
      .getByRole('group', { name: 'Linked items' });
    await linked.getByLabel('Find an item to link').fill(text);
    return linked;
  };
  let linked = await find('zzzz');
  await expect(linked).toContainText('No Ground Truth item matches');
  await expect(linked.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/baseline/entities');
  linked = await find('checklist');
  await seesReason(page, linked, 'the Ground Truth');
  await expect(linked).not.toContainText('No Ground Truth item matches');
});

test('Priorities: a ranking that could not be read says so, never no features ranked; answered none says so', async ({
  page,
}) => {
  await page.goto('/icon.svg');
  await page.evaluate(() => {
    localStorage.removeItem('po-mock-db-v2');
    localStorage.setItem('po-mock-scenario', 'empty');
  });
  await login(page);
  await page.goto('/priorities');
  const table = page.getByTestId('priority-table').filter({ visible: true });
  await expect(table.getByTestId('table-empty')).toHaveText('No features ranked');

  await failGets(page, '/v1/priorities');
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Mock failure' }).first()).toBeVisible();
  await expect(page.getByText('No features ranked')).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
});

test('Outcomes: outcomes that could not be read say so, never none in a filter; answered none in a filter says so', async ({
  page,
}) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [
    'po-mock-scenario',
    'outcomes',
  ] as const);
  await login(page);
  await page.goto('/plan/outcomes');
  const filters = page.getByTestId('outcome-filters');
  await filters.getByRole('button', { name: /^Needs prediction/ }).click();
  await page.getByTestId('outcome-row').filter({ hasText: 'Guided setup checklist' }).click();
  const form = page
    .getByTestId('outcome-inspector')
    .filter({ visible: true })
    .getByTestId('prediction-form');
  await form.getByLabel('Predicted').fill('45');
  await form.getByRole('button', { name: 'Save prediction' }).click();
  await expect(page.getByTestId('table-empty')).toContainText('No outcomes in Needs prediction');

  await failGets(page, '/v1/outcomes');
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Mock failure' }).first()).toBeVisible();
  await expect(page.getByText(/No outcomes in/)).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
  await expect(filters.getByRole('button', { name: /^All/ })).toHaveText(/^\s*All\s*$/);
});

test('Quality: criteria that could not be read say so, never no criteria match; answered none in a filter says so', async ({
  page,
}) => {
  await page.addInitScript(
    ([rk, sk]) => {
      localStorage.setItem(rk, 'commenter');
      localStorage.setItem(sk, 'quality');
    },
    ['po-mock-role', 'po-mock-scenario'] as const,
  );
  await login(page);
  await page.goto('/documents/team-invites/v/2/quality');
  await page.locator('[data-testid="criterion-row"][data-key="scope_testability"]').click();
  await page
    .getByTestId('quality-inspector')
    .getByLabel('Hide rules, model and other people until I pick')
    .check();
  await page.getByRole('button', { name: /Model disagrees/ }).click();
  await expect(page.getByTestId('criterion-row')).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveText('No criteria match this filter');

  await failGets(page, '/v1/documents/team-invites/versions/2/readiness');
  await page.reload();
  await expect(page.getByTestId('quality-error')).toContainText('Mock failure');
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
  await expect(page.getByText('No criteria match this filter')).toHaveCount(0);
});
