import fs from 'node:fs';
import path from 'node:path';

import { ADMIN, login, signOut } from './helpers';
import { expect, test, type Page } from './test';

// Owner's order (Nov 23): connecting an AI tool over MCP, from the app.
const ADDRESS = 'https://oracle.example.com/mcp';

const userMenu = (page: Page) =>
  page.getByTestId('user-menu').or(page.getByTestId('phone-user-menu')).locator('visible=true');

async function openConnect(page: Page) {
  await userMenu(page).click();
  await page.getByTestId('nav-connect-mcp').locator('visible=true').click();
  await expect(page).toHaveURL(/\/account#connect$/);
  await expect(page.getByTestId('mcp-guide')).toBeVisible();
  await expectPanelHeadShown(page, 'mcp-guide', 'Connect an AI tool');
}

/** The panel's heading is in the viewport and nothing (the phone's header) covers it. */
async function expectPanelHeadShown(page: Page, testId: string, title: string) {
  const heading = page.getByTestId(testId).getByRole('heading', { name: title });
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      heading.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top === el || el.contains(top);
      }),
    )
    .toBe(true);
}

/** Counts this page's reads of the connected clients (the mock API answers in the page). */
async function countListReads(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { listReads: number };
    w.listReads = 0;
    const Native = window.Request;
    window.Request = class extends Native {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        if (this.method === 'GET' && new URL(this.url).pathname.endsWith('/v1/me/oauth-clients'))
          w.listReads += 1;
      }
    };
  });
  return () => page.evaluate(() => (window as unknown as { listReads: number }).listReads);
}

/** Approves the example client in another tab, as the browser that opens does. */
async function approveInAnotherTab(page: Page) {
  const tab = await page.context().newPage();
  // The same browser: already signed in.
  await tab.goto('/oauth/consent?request=mock-handle');
  await tab.getByRole('button', { name: 'Approve' }).click();
  // Approved: the browser returns to the client.
  await expect(tab).not.toHaveURL(/oauth\/consent/);
  await tab.close();
  await page.bringToFront();
}

/** Every API action's name in openapi.json, which is its MCP tool's name. */
function apiActions(): Set<string> {
  const spec = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../lib/api/openapi.json'), 'utf8'),
  ) as { paths: Record<string, Record<string, { operationId?: string }>> };
  return new Set(
    Object.values(spec.paths).flatMap((p) => Object.values(p).map((op) => op.operationId ?? '')),
  );
}

test('Detailed: the account menu opens Connect an AI tool; the Claude Code command copies with the API address', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await openConnect(page);
  const guide = page.getByTestId('mcp-guide');
  await expect(guide.getByTestId('mcp-address')).toContainText(ADDRESS);
  const command = guide.getByTestId('mcp-command');
  await expect(command).toContainText(`claude mcp add --transport http oracle ${ADDRESS}`);
  await command.getByRole('button', { name: 'Copy' }).click();
  await expect(command.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `claude mcp add --transport http oracle ${ADDRESS}`,
  );
  await expect(guide.getByTestId('mcp-steps-code')).toContainText(
    'In Claude Code, run /mcp and choose oracle',
  );
  await guide
    .getByRole('group', { name: 'Your tool' })
    .getByRole('button', { name: 'Claude app' })
    .click();
  await expect(guide.getByTestId('mcp-steps-app')).toContainText(ADDRESS);
  // The owner's changes apply at once; the most used tools are behind their control.
  await expect(guide.getByTestId('mcp-role-access')).toContainText('Changes apply at once');
  await expect(guide.getByTestId('mcp-most-used')).toBeHidden();
  await guide.getByText('Most used tools').click();
  const mostUsed = page.getByTestId('mcp-most-used');
  await expect(mostUsed).toContainText('get_simple_roadmap: Read the roadmap');
  await expect(mostUsed).toContainText('create_simple_change: Change a roadmap item');
  const tools = await mostUsed.locator('code').allTextContents();
  expect(tools.length).toBeGreaterThan(0);
  const actions = apiActions();
  expect(tools.filter((t) => !actions.has(t))).toEqual([]);
  await page.keyboard.press('Escape');
  // Connected clients sit right under it, with the personal tokens linked.
  const clients = page.getByTestId('clients-panel');
  await expect(clients.getByTestId('my-client-row')).toHaveCount(1);
  await expect(clients.getByTestId('my-client-row')).toContainText('Your computer');
  await clients.getByTestId('mcp-tokens-link').click();
  await expect(page).toHaveURL(/\/account#tokens-panel$/);
  await expectPanelHeadShown(page, 'tokens-panel', 'Personal API tokens');
});

test('Simple: the account menu opens Connect an AI tool too', async ({ page }) => {
  await login(page);
  await page.goto('/simple');
  await openConnect(page);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1512, height: 982 },
  { width: 390, height: 844 },
])
  test(`${viewport.width}x${viewport.height}: the menu and the tokens chip land with the panel's heading in view`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await login(page);
    await openConnect(page);
    // Wide: the page title stays above the panel, as in the picked design.
    if (viewport.width > 390)
      await expect(page.getByRole('heading', { name: 'My account', level: 1 })).toBeInViewport({
        ratio: 1,
      });
    await page.getByTestId('mcp-tokens-link').click();
    await expectPanelHeadShown(page, 'tokens-panel', 'Personal API tokens');
    // A link straight to the guide lands the same way.
    await page.goto('/account#connect');
    await page.reload();
    await expectPanelHeadShown(page, 'mcp-guide', 'Connect an AI tool');
  });

test('the check strip waits, then shows the client approved in another tab, and so does the table', async ({
  page,
}) => {
  const listReads = await countListReads(page);
  await login(page, 'approver@example.com');
  await page.goto('/account');
  const check = page.getByTestId('mcp-check');
  await expect(check).toContainText('Waiting for your first client');
  await expect(page.getByTestId('my-client-row')).toHaveCount(0);

  await approveInAnotherTab(page);
  // The next read of the list (every few seconds while waiting).
  await page.clock.runFor(3_000);

  await expect(check).toContainText('Example Agent');
  await expect(check).toContainText('Connected');
  await expect(check).toContainText('Used just now');
  const row = page.getByTestId('my-client-row').filter({ hasText: 'Example Agent' });
  await expect(row).toContainText('Your computer');
  await expect(row).toContainText('Read & write');

  // It has its answer: the list is not read again.
  const reads = await listReads();
  await page.clock.runFor(30_000);
  expect(await listReads()).toBe(reads);
});

test('after five minutes the strip says the sign-in timed out, with /mcp to copy, and the list is read no more', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const listReads = await countListReads(page);
  await login(page, 'approver@example.com');
  await page.goto('/account');
  const check = page.getByTestId('mcp-check');
  await expect(check).toContainText('Waiting for your first client');

  await expect(page.getByTestId('clients-panel')).toContainText('None yet');

  // Read every few seconds, for five minutes.
  const atOpen = await listReads();
  await expect
    .poll(async () => {
      await page.clock.runFor(3_000);
      return listReads();
    })
    .toBeGreaterThan(atOpen);
  await page.clock.runFor(4 * 60_000);
  await expect(check).toContainText('Waiting for your first client');

  await page.clock.runFor(60_000 + 5_000);
  await expect(check).toContainText('Sign-in timed out');
  await expect(check).toContainText('Run /mcp again and Approve straight away');
  await check.getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/mcp');

  const reads = await listReads();
  await approveInAnotherTab(page);
  await page.clock.runFor(60_000);
  expect(await listReads()).toBe(reads);
  await expect(check).toContainText('Sign-in timed out');
  await expect(page.getByTestId('my-client-row')).toHaveCount(0);
});

test('the strip dates a client last used over a day ago, month first', async ({ page }) => {
  await login(page);
  await page.goto('/account');
  await expect(page.getByTestId('mcp-check')).toContainText('Used on Oct 20, 2026');
});

test('Revoke asks once, then the client leaves the table', async ({ page }) => {
  await login(page);
  await page.goto('/account');
  const row = page.getByTestId('my-client-row').filter({ hasText: 'Claude Desktop' });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Revoke Claude Desktop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke this client?' });
  await expect(dialog).toContainText('It stops working at once.');
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('clients-panel').getByTestId('panel-count')).toHaveText('0');
});

test('a viewer reads only; a commenter’s changes become proposals', async ({ page }) => {
  await login(page, 'viewer@example.com');
  await page.goto('/account');
  await expect(page.getByTestId('mcp-role-access')).toContainText('Read only');

  await signOut(page);
  await login(page, 'commenter@example.com');
  await page.goto('/account');
  await expect(page.getByTestId('mcp-role-access')).toContainText('Changes become proposals');
  await expect(page.getByTestId('my-client-row')).toContainText('cursor.example.com');
});

test('the owner sees MCP across the company in Settings > Connections; an approver does not', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings/connections');
  const company = page.getByTestId('mcp-company');
  await expect(company.getByTestId('mcp-company-count')).toHaveText(/^2 of \d+ people connected$/);
  const me = company.getByTestId('mcp-company-row').filter({ hasText: ADMIN.email });
  await expect(me).toContainText('Owner');
  await expect(me).toContainText('1');

  await signOut(page);
  await login(page, 'approver@example.com');
  await page.goto('/settings/connections');
  await expect(page.getByTestId('mcp-company')).toHaveCount(0);
});

test('the consent screen links back to your connected clients', async ({ page }) => {
  await login(page);
  await page.goto('/oauth/consent?request=mock-handle');
  await page.getByRole('link', { name: 'Your connected clients' }).click();
  await expect(page).toHaveURL(/\/account#connect$/);
  await expect(page.getByTestId('mcp-guide')).toBeVisible();
});
