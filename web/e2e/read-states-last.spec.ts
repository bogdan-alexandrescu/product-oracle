import { expect, test, type Locator, type Page } from './test';

import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';

/*
 * #1586 (last phase, the reads left after the triage): a read that failed says so, with its
 * reason behind an (i), and one still loading says loading; neither draws the empty sentence,
 * the 0 count or the guess an answer of none would. Each case is checked both ways: answered
 * first, then failed.
 */

const failGets = (page: Page, path: string) =>
  page.evaluate((p) => localStorage.setItem('po-mock-fail', p), path);
const scenario = (page: Page, name: string) =>
  page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, name] as const);

async function seesReason(page: Page, scope: Locator, what: string) {
  const failed = scope
    .getByTestId('load-error')
    .filter({ hasText: `Could not load ${what}.` })
    .first();
  await expect(failed).toBeVisible();
  await failed.getByRole('button', { name: 'About the error' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Mock failure');
}

test('Strategy: a stack line whose open findings could not be read says so, never no open findings', async ({
  page,
}) => {
  await scenario(page, 'strategy');
  await login(page);
  await page.goto('/company/strategy');
  const root = page.getByTestId('strategy-page').filter({ visible: true });
  const pick = () =>
    root
      .getByTestId('strategy-stack')
      .getByTestId('stack-row')
      .filter({ hasText: 'Retention' })
      .click();
  await pick();
  const inspector = root.getByTestId('stack-inspector');
  await expect(inspector.getByTestId('inspector-finding').first()).toBeVisible();
  await expect(inspector.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/strategy/findings?status=open');
  await page.reload();
  await pick();
  await seesReason(page, inspector, 'the findings');
  await expect(inspector).not.toContainText('No open findings');
});

test('Interviews: a list that could not be read says so, never Nothing yet', async ({ page }) => {
  await login(page);
  await page.goto('/requests/interviews');
  await expect(page.getByTestId('interview-row').first()).toBeVisible();
  await expect(page.getByTestId('load-error')).toHaveCount(0);

  await failGets(page, '/v1/interviews?kind=customer');
  await page.reload();
  await seesReason(page, page.locator('main'), 'the interviews');
  await expect(page.getByTestId('interviews-table')).not.toContainText('Nothing yet');
});

test('Launches: a list that could not be read says so, never No launches yet', async ({ page }) => {
  await scenario(page, 'launches');
  await login(page);
  await page.goto('/roadmap/launches');
  await expect(page.getByTestId('launch-row').first()).toBeVisible();

  await failGets(page, '/v1/launches');
  await page.reload();
  await expect(page.getByText('Mock failure')).toBeVisible();
  await expect(page.getByTestId('launches-table')).toBeVisible();
  await expect(page.getByTestId('launches-table')).not.toContainText('No launches');
  await expect(page.getByTestId('launch-filters').getByRole('button', { name: /^All/ })).toHaveText(
    'All',
  );
});

test('Requests: the feature Oracle suggests, when the features could not be read, says so, never Loading for ever', async ({
  page,
}) => {
  await login(page);
  await page.goto('/requests');
  const title = 'Save my card for the next order';
  const inspector = page.getByTestId('request-inspector').filter({ visible: true });
  const open = async () => {
    await page
      .getByTestId('request-row')
      .filter({ hasText: title })
      .getByRole('button', { name: title })
      .click();
    await expect(inspector.getByRole('heading', { name: title })).toBeVisible();
  };
  await open();
  await expect(inspector.getByTestId('suggested-feature')).toHaveText(/^Feature: (?!Loading)\S/);

  await failGets(page, '/v1/baseline/entities?type=feature');
  await page.reload();
  await open();
  await seesReason(page, inspector.getByTestId('suggested-feature'), 'the features');
  await expect(inspector.getByTestId('suggested-feature')).not.toContainText('Loading');
});

test('Requests: Themes that could not be read show no count, never 0', async ({ page }) => {
  await login(page);
  await page.goto('/requests');
  await page.getByTestId('requests-tab-themes').filter({ visible: true }).click();
  const panel = page
    .locator('section', { has: page.getByRole('heading', { name: 'Themes', exact: true }) })
    .first();
  await expect(page.getByTestId('theme-row').first()).toBeVisible();
  await expect(panel.getByTestId('panel-count')).not.toHaveText('0');

  await failGets(page, '/v1/request-themes?include_archived=true');
  await page.reload();
  await expect(page.getByText('Mock failure').first()).toBeVisible();
  await expect(page.getByTestId('theme-row')).toHaveCount(0);
  await expect(page.getByTestId('panel-count').filter({ hasText: /^0$/ })).toHaveCount(0);
});

test('Feedback campaigns that could not be read show no count, never 0', async ({ page }) => {
  await login(page);
  await page.goto('/documents/annual-billing');
  const panel = page.getByTestId('campaigns');
  await expect(panel.getByTestId('panel-count')).toBeVisible();

  await failGets(page, '/v1/documents/annual-billing/campaigns');
  await page.reload();
  await expect(panel.getByText('Mock failure')).toBeVisible();
  await expect(panel.getByTestId('panel-count')).toHaveCount(0);
  await expect(panel).not.toContainText('Nobody has been asked');
});

test('Share links that could not be read show no count, never 0', async ({ page }) => {
  await scenario(page, 'sharing');
  await login(page);
  await page.goto('/documents/example-labs-roadmap');
  const panel = page
    .locator('section', { has: page.getByRole('heading', { name: 'Share links', exact: true }) })
    .first();
  await expect(panel.getByTestId('share-links')).toBeVisible();
  await expect(panel.getByTestId('panel-count')).toBeVisible();

  await failGets(page, '/v1/documents/example-labs-roadmap/share-links');
  await page.reload();
  await expect(panel.getByText('Mock failure')).toBeVisible();
  await expect(panel.getByTestId('panel-count')).toHaveCount(0);
});

test('Quality: a History whose review jobs could not be read says so, never no evaluation reports', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('po-mock-role', 'commenter'));
  await login(page);
  await page.goto('/documents/team-invites/v/2/quality');
  const history = page.getByRole('region', { name: 'History' });
  await expect(history).toContainText('No evaluation reports for v2 yet');

  await failGets(page, '/v1/documents/team-invites/llm-jobs');
  await page.reload();
  await expect(history.getByText('Mock failure')).toBeVisible();
  await expect(history).not.toContainText('No evaluation reports');
  await expect(history).not.toContainText('No reports match');
});

test('Quality: a History whose readiness could not be read stops loading, never loading for ever', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('po-mock-role', 'commenter'));
  await login(page);
  await page.goto('/documents/team-invites/v/2/quality');
  const history = page.getByRole('region', { name: 'History' });
  await expect(history).toContainText('No evaluation reports for v2 yet');
  await expect(history.locator('[aria-busy=true]')).toHaveCount(0);

  await failGets(page, '/v1/documents/team-invites/versions/2/readiness');
  await page.reload();
  await expect(page.getByText('Mock failure').first()).toBeVisible();
  await expect(history).toBeVisible();
  await expect(history.locator('[aria-busy=true]')).toHaveCount(0);
  await expect(history).not.toContainText(/No evaluation reports|No reports match/);
});

test('Plan: a milestone date whose estimates could not be read says so, never that none supports it', async ({
  page,
}) => {
  await login(page);
  await page.goto('/plan');
  const track = page
    .getByTestId('plan-track')
    .filter({ visible: true })
    .filter({ hasText: 'Usage alerts' });
  const editor = page.getByTestId('plan-milestone').filter({ visible: true });
  const open = async () => {
    await track.getByTestId('track-milestone').filter({ hasText: 'First release' }).click();
    await editor.getByLabel('Date').fill('2026-12-01');
  };
  await open();
  await expect(editor.getByTestId('milestone-no-basis')).toBeVisible();

  await failGets(page, '/v1/schedule-bases');
  await page.reload();
  await open();
  await seesReason(page, editor, 'the estimates');
  await expect(editor.getByTestId('milestone-no-basis')).toHaveCount(0);
});

for (const [where, path, testId] of [
  ['Roadmap', '/simple/roadmap', 'roadmap-empty'],
  ['Priorities', '/simple/priorities', 'priorities-empty'],
] as const) {
  test(`Simple ${where}: a new company whose suggestions could not be read says so, never guesses its next step`, async ({
    page,
  }) => {
    await scenario(page, 'empty');
    await login(page);
    await page.goto(path);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByTestId('load-error')).toHaveCount(0);

    await failGets(page, '/v1/simple/goal-suggestions?status=open');
    await page.reload();
    await seesReason(page, page.locator('main'), 'the suggested features');
    await expect(page.getByTestId(testId)).toHaveCount(0);
  });
}

test('Simple Home: what waits, when the list could not be read, says it could not check, never nothing waits', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple');
  const sentence = page.getByTestId('home-sentence');
  await expect(sentence).not.toHaveText(/Checking/);
  await expect(sentence).not.toHaveText('Could not check what waits on you.');

  await failGets(page, '/v1/simple/decisions/waiting');
  await page.reload();
  await expect(sentence).toHaveText('Could not check what waits on you.');
});

test("Brief: a thread that could not be read keeps the asked count, never Oracle hasn't read this brief", async ({
  page,
}) => {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem('reads3-intake')) {
        localStorage.removeItem('po-mock-db-v2');
        sessionStorage.setItem('reads3-intake', '1');
      }
      localStorage.setItem(key, value);
      localStorage.setItem('po-interview-follow-up', 'off');
    },
    [MOCK_SCENARIO_KEY, 'empty'] as const,
  );
  await login(page);
  await page.goto('/documents/new?kind=prd');
  await page.getByRole('textbox', { name: 'Title' }).fill('Setup checklist');
  await page
    .getByRole('textbox', { name: 'What problem does it solve?' })
    .fill('Returning buyers retype their address at every checkout.');
  await page.getByRole('button', { name: 'Continue' }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  const read = page.getByTestId('intake-read');
  await expect(read).toContainText(/Oracle asked \d+ questions? from what the brief says/);
  const id = page.url().split('/').pop()!;

  await failGets(page, `/v1/intakes/${id}/question-batch?batch=1`);
  await page.reload();
  await expect(read).toContainText(/Oracle asked \d+ questions? from what the brief says/);
  await expect(read).not.toContainText("Oracle hasn't read this brief");
});
