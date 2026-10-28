import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { POOL_SPENT_SCENARIO } from "../lib/api/mock/claude-accounts";

import { login } from "./helpers";

/*
 * QA findings on /design, Settings > Claude accounts, Settings > API tokens, My account and
 * the OAuth consent screen (qa-settings-8, 11, 14-18, 32), through the UI on the mock.
 */

const PHONE = { width: 390, height: 844 };

const row = (page: Page, label: string) => page.getByTestId(`account-row-${label}`);
const detail = (page: Page) => page.getByTestId("account-detail");

async function openAccounts(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-claude-accounts").click();
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
}

/** Whether an element shows all of its text (nothing cut off). */
const fits = (el: Locator) => el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1);

test.describe("qa-settings-8: /design for a role that cannot use it", () => {
  for (const email of ["viewer@example.com", "commenter@example.com"]) {
    test(`${email.split("@")[0]}: says it is not available, not an empty page`, async ({ page }) => {
      await login(page, email);
      await page.goto("/design");
      await expect(page.getByRole("heading", { name: "Design system (developers)", exact: true })).toBeVisible();
      const locked = page.getByTestId("not-for-role");
      await expect(locked).toContainText("Not available for your role");
      await expect(locked).toContainText("for owners");
      await expect(page.getByTestId("design-gallery")).toHaveCount(0);
    });
  }

  test("on a phone, too", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, "viewer@example.com");
    await page.goto("/design");
    await expect(page.getByTestId("not-for-role")).toBeVisible();
    await expect(page.getByTestId("not-for-role").getByRole("link", { name: "Open Home" })).toBeVisible();
  });
});

test("qa-settings-11: a state confirm opens on its Reason, Escape cancels it, and the page answers after Pause", async ({ page }) => {
  await openAccounts(page);
  await row(page, "personal").getByRole("button").click();
  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: "personal" })).toBeVisible();

  // Drain: focus on Reason; Escape closes and puts focus back on a state button.
  await pane.getByRole("button", { name: "Drain", exact: true }).click();
  const drain = pane.getByRole("dialog", { name: "Drain personal?" });
  await expect(drain.getByLabel("Reason (required)")).toBeFocused();
  await expect(drain.getByTestId("state-reason-hint")).toHaveText("Say why before you drain it.");
  await page.keyboard.press("Escape");
  await expect(drain).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "Pause", exact: true })).toBeFocused();

  // Pause: focus on Reason, a reason, Enter.
  await pane.getByRole("button", { name: "Pause", exact: true }).click();
  const pause = pane.getByRole("dialog", { name: "Pause personal?" });
  await expect(pause.getByLabel("Reason (required)")).toBeFocused();
  await page.keyboard.type("over budget");
  await page.keyboard.press("Enter");
  await expect(pause).toHaveCount(0);
  await expect(row(page, "personal")).toContainText("Paused");
  await expect(pane.getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
  await expect(pane.getByRole("button", { name: "Pause", exact: true })).toHaveAttribute("title", "Already paused.");

  // The page still answers at once: Make available opens on its Reason and goes through.
  await pane.getByRole("button", { name: "Make available" }).click({ timeout: 5_000 });
  const back = pane.getByRole("dialog", { name: "Make available personal?" });
  await expect(back.getByLabel("Reason")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(back).toHaveCount(0);
  await pane.getByRole("button", { name: "Make available" }).click({ timeout: 5_000 });
  await back.getByRole("button", { name: "Make available" }).click({ timeout: 5_000 });
  await expect(row(page, "personal")).toContainText("Available", { timeout: 5_000 });
});

test("qa-settings-14: the inspector shows no id, names Anthropic, and the header says when usage was checked", async ({ page }) => {
  await openAccounts(page);
  await expect(page.getByTestId("refresh-sweep")).toHaveText(/^Usage checked \d+m ago$/);
  await expect(page.getByTestId("accounts-summary")).not.toContainText("sweep");

  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: "old-laptop" })).toBeVisible();
  await expect(pane).toContainText("Anthropic · Claude subscription");
  await expect(pane).not.toContainText("anthropic ·");
  await expect(pane).not.toContainText("a1111111-0000-4000-8000-000000000004");
  await expect(pane.getByText(/^Id$/)).toHaveCount(0);
});

test("qa-settings-15: plain column headers, no repeated 'clears', one date format", async ({ page }) => {
  await openAccounts(page);
  const table = page.getByTestId("account-list");
  await expect(table.getByRole("columnheader", { name: "5-hour use" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Resets in" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "5h", exact: true })).toHaveCount(0);
  await expect(row(page, "personal").getByTestId("clears")).toHaveText(/^1h \d\dm · 5-hour$/);
  await expect(row(page, "spare").getByTestId("clears")).toHaveText("—");
  await expect(table).not.toContainText("clears");
  await expect(table).not.toContainText("given out");
});

test("qa-settings-15: Spent until uses the page's one date format", async ({ page }) => {
  await page.addInitScript(([key, name]) => localStorage.setItem(key, name), [MOCK_SCENARIO_KEY, POOL_SPENT_SCENARIO]);
  await openAccounts(page);
  const state = row(page, "weekly");
  await expect(state).toContainText("Spent until");
  // "Oct 25, 1:00 AM PDT", as formatDateTime writes it; no weekday in front.
  await expect(state).toContainText(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d\d [AP]M P[DS]T/);
  await expect(state).not.toContainText(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
});

test("qa-settings-16: scopes in words, the codes in the title, nothing cut off", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  const run = page.getByTestId("token-row").filter({ hasText: "Run · baseline to prd" });
  const scopes = run.getByTestId("scopes");
  await expect(scopes).toHaveText("Read the baseline, Read documents, Read sources, Write drafts");
  await expect(scopes).toHaveAttribute("title", "read:baseline, read:documents, read:sources, write:drafts");
  expect(await fits(scopes)).toBe(true);
  await expect(page.getByTestId("token-row").filter({ hasText: "agent-track" }).getByTestId("scopes")).toHaveText("Read and write");
  await expect(page.getByTestId("token-row").filter({ hasText: "ci-export" })).toContainText("Acts as viewer");
  await expect(page.getByRole("table", { name: "API tokens" })).not.toContainText(/oracle:|read:|write:/);

  await page.goto("/account");
  const form = page.getByRole("form", { name: "Create a token" });
  await expect(form.getByRole("checkbox", { name: "Read", exact: true })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "Write", exact: true })).not.toBeChecked();
  await expect(form).not.toContainText("oracle:");
  const client = page.getByTestId("my-client-row").filter({ hasText: "Claude Desktop" });
  await expect(client.getByTestId("scopes")).toHaveText("Read and write");
  await expect(client.getByTestId("scopes")).toHaveAttribute("title", "oracle:read, oracle:write");
  await expect(page.getByTestId("my-token-row").filter({ hasText: "staging sync" }).getByTestId("scopes")).toHaveText("Read");
});

test("qa-settings-17: dates in the token and MCP client tables fit, without this year", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const used = page.getByTestId("my-token-row").filter({ hasText: "staging sync" }).getByText("Sep 28", { exact: true });
  await expect(used).toBeVisible();
  expect(await fits(used.locator("xpath=ancestor::td[1]"))).toBe(true);
  const client = page.getByTestId("my-client-row").filter({ hasText: "Old notebook agent" });
  for (const day of ["Sep 12", "Sep 30"]) {
    const cell = client.getByText(day, { exact: true });
    await expect(cell).toBeVisible();
    expect(await fits(cell.locator("xpath=ancestor::td[1]"))).toBe(true);
  }
  await expect(page.getByRole("table", { name: "MCP clients" })).not.toContainText("2026");
});

test("qa-settings-18: My account counts read as active", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  // Two rows each (one live, one expired or revoked): the count says it counts the live ones.
  await expect(page.getByTestId("my-token-row")).toHaveCount(2);
  await expect(page.getByTestId("tokens-panel").getByTestId("panel-active-count")).toHaveText("1 active");
  await expect(page.getByTestId("my-client-row")).toHaveCount(2);
  await expect(page.getByTestId("clients-panel").getByTestId("panel-active-count")).toHaveText("1 active");
  await expect(page.getByTestId("stat-tokens")).toContainText("Active tokens");
  await expect(page.getByTestId("stat-clients")).toContainText("Active MCP clients");
});

test("qa-settings-32: Create token and Change password say what is missing", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Create a token" });
  const create = form.getByRole("button", { name: "Create token" });
  await expect(create).toBeDisabled();
  await expect(form.getByTestId("token-missing")).toHaveText("Name the token first");
  await form.getByLabel("Name").fill("nightly export");
  await form.getByRole("checkbox", { name: "Read", exact: true }).uncheck();
  await expect(form.getByTestId("token-missing")).toHaveText("Choose Read, Write or both");
  await form.getByRole("checkbox", { name: "Write", exact: true }).check();
  await expect(form.getByTestId("token-missing")).toHaveCount(0);
  await expect(create).toBeEnabled();

  const password = page.getByRole("form", { name: "Change password" });
  const change = password.getByRole("button", { name: "Change password" });
  await expect(change).toBeDisabled();
  await expect(password.getByTestId("password-missing")).toHaveText("Enter your current password");
  await password.getByLabel("Current password").fill("old-password-1");
  await expect(password.getByTestId("password-missing")).toHaveText("Enter a new password");
  await password.getByLabel(/New password · \d+\+ characters/).fill("a-long-new-password");
  await expect(password.getByTestId("password-missing")).toHaveText("Enter the new password again");
  await password.getByLabel("New password again").fill("a-long-new-password");
  await expect(password.getByTestId("password-missing")).toHaveCount(0);
  await expect(change).toBeEnabled();
});

test("qa-settings-32: on a phone the reason sits with the button", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Create a token" });
  await expect(form.getByTestId("token-missing")).toBeVisible();
  await expect(form.getByTestId("token-missing")).toHaveText("Name the token first");
});
