import { expect, test, type Page } from './test';

import { ADMIN, login, signOut } from './helpers';

// Owner's order (Nov 23): connecting an AI tool over MCP, from the app.
const ADDRESS = 'https://oracle.example.com/mcp';

const userMenu = (page: Page) => page.getByTestId('user-menu').locator('visible=true');

async function openConnect(page: Page) {
  await userMenu(page).click();
  await page.getByTestId('nav-connect-mcp').locator('visible=true').click();
  await expect(page).toHaveURL(/\/account#connect$/);
  await expect(page.getByTestId('mcp-guide')).toBeVisible();
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
  await expect(page.getByTestId('mcp-most-used')).toContainText('get_simple_roadmap');
  // Connected clients sit right under it, with the personal tokens linked.
  const clients = page.getByTestId('clients-panel');
  await expect(clients.getByTestId('my-client-row')).toHaveCount(1);
  await expect(clients.getByTestId('my-client-row')).toContainText('Your computer');
  await clients.getByTestId('mcp-tokens-link').click();
  await expect(page).toHaveURL(/\/account#tokens-panel$/);
});

test('Simple: the account menu opens Connect an AI tool too', async ({ page }) => {
  await login(page);
  await page.goto('/simple');
  await openConnect(page);
});

test('the check strip waits, then shows the client approved in another tab, and so does the table', async ({
  page,
  context,
}) => {
  await login(page, 'approver@example.com');
  await page.goto('/account');
  const check = page.getByTestId('mcp-check');
  await expect(check).toContainText('Waiting for your first client');
  await expect(page.getByTestId('my-client-row')).toHaveCount(0);

  const tab = await context.newPage();
  // The same browser: already signed in.
  await tab.goto('/oauth/consent?request=mock-handle');
  await tab.getByRole('button', { name: 'Approve' }).click();
  // Approved: the browser returns to the client.
  await expect(tab).not.toHaveURL(/oauth\/consent/);
  await tab.close();
  await page.bringToFront();
  // The next read of the list (every few seconds while waiting).
  await page.clock.runFor(3_000);

  await expect(check).toContainText('Example Agent');
  await expect(check).toContainText('Connected');
  await expect(check).toContainText('Used just now');
  const row = page.getByTestId('my-client-row').filter({ hasText: 'Example Agent' });
  await expect(row).toContainText('Your computer');
  await expect(row).toContainText('Read & write');
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
