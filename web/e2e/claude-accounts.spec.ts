import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { SETUP_TOKEN_PREFIX } from "../lib/api/mock/claude-accounts";

import { login } from "./helpers";

async function openAccounts(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-claude-accounts").click();
  await expect(page).toHaveURL(/\/settings\/claude-accounts$/);
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
}

const row = (page: Page, label: string) => page.getByTestId(`account-row-${label}`);
const detail = (page: Page) => page.getByTestId("account-detail");

test("claude accounts: rows carry the em dash, the ~ and CLEARS; the pane opens on the account that needs a sign-in", async ({
  page,
}) => {
  await openAccounts(page);
  await expect(page.getByTestId("accounts-summary")).toContainText("4 accounts · 2 available");
  await expect(page.getByTestId("accounts-summary")).toContainText("1 needs a sign-in");
  await expect(page.getByTestId("refresh-sweep")).toContainText("refresh sweep ran");
  await expect(page.getByRole("status").filter({ hasText: "old-laptop needs someone to sign in again" })).toBeVisible();

  // Measured and current: a plain figure with the window it is about.
  await expect(row(page, "personal")).toContainText("34%");
  await expect(row(page, "personal").getByTestId("clears")).toContainText(/clears 1h \d\dm · 5h/);
  // Real but old: marked ~, never shown as current.
  await expect(row(page, "work").getByTestId("tilde")).toBeVisible();
  await expect(row(page, "work")).toContainText("~61%");
  await expect(row(page, "work").getByTestId("clears")).toContainText("clears ~");
  // Never measured: an em dash, never a zero.
  await expect(row(page, "spare").getByTestId("fig-unmeasured")).toHaveText(/—/);
  await expect(row(page, "spare")).not.toContainText("0%");
  await expect(row(page, "spare").getByTestId("clears")).toContainText("clears —");
  await expect(row(page, "spare")).toContainText("never given out");
  await expect(page.getByTestId("accounts-foot")).toContainText("~ is an old reading, not current");

  // With nothing chosen, the pane shows the most urgent account.
  await expect(detail(page).getByRole("heading", { name: "old-laptop" })).toBeVisible();
  await expect(detail(page)).toContainText("Refresh failed: sign-in needed");
  // Plain labels, no raw codes; one way to sign in again in the pane.
  await expect(page.locator("body")).not.toContainText(/reauth|REAUTH/);
  await expect(row(page, "old-laptop")).toContainText("Needs sign-in");
  await expect(detail(page)).toContainText("Expired");
  await expect(detail(page)).not.toContainText("in now");
  await expect(detail(page).getByText(/^Sign in again/)).toHaveCount(1);

  // Choosing a row shows its tiles.
  await row(page, "personal").getByRole("button").click();
  await expect(detail(page).getByRole("heading", { name: "personal" })).toBeVisible();
  await expect(detail(page).getByTestId("tile-5h used")).toContainText("34%");
  await expect(detail(page).getByTestId("tile-7d used")).toContainText("12%");
  await expect(detail(page).getByTestId("tile-Clears")).toContainText("5h window");
  await row(page, "spare").getByRole("button").click();
  await expect(detail(page).getByTestId("tile-5h used")).toContainText(/not measured/i);
  // The (i) sits on the label's line, after the label.
  for (const tile of ["tile-5h used", "tile-7d used"]) {
    const label = detail(page).getByTestId(tile).locator("dt");
    const tip = label.getByTestId("info-tip");
    await expect(tip).toBeVisible();
    const [l, t] = [(await label.getByText(/used$/).boundingBox())!, (await tip.boundingBox())!];
    expect(Math.abs(l.y + l.height / 2 - (t.y + t.height / 2))).toBeLessThan(3);
    expect(t.x).toBeGreaterThan(l.x + l.width - 1);
  }
  await expect(detail(page).getByTestId("tile-Last given out")).toContainText("never");
});

test("claude accounts: holders and history tabs load when opened", async ({ page }) => {
  await openAccounts(page);
  await row(page, "personal").getByRole("button").click();
  await expect(page.getByTestId("holding-now")).toHaveCount(0);
  await detail(page).getByRole("tab", { name: "Holding now (1)" }).click();
  await expect(page.getByTestId("holding-now")).toContainText("reporting");
  await detail(page).getByRole("tab", { name: "History" }).click();
  const history = page.getByTestId("holding-history");
  await expect(history).toContainText("Five-hour window now: 34%");
  await expect(history).toContainText("review comments");
  await expect(history).toContainText("released");
  await expect(history).toContainText("holding");
});

test("claude accounts: an owner drains with a reason, refreshes, and removes only once the label is typed", async ({
  page,
}) => {
  await openAccounts(page);
  await row(page, "personal").getByRole("button").click();
  const pane = detail(page);

  await pane.getByRole("button", { name: "Drain", exact: true }).click();
  const confirm = pane.getByRole("dialog", { name: "Drain personal?" });
  await expect(confirm).toContainText("1 job on it now will be moved off at their next turn.");
  const go = confirm.getByRole("button", { name: "Drain", exact: true });
  await expect(go).toBeDisabled();
  await confirm.getByLabel("Reason (required)").fill("retiring this laptop");
  await go.click();
  await expect(row(page, "personal")).toContainText("Draining");
  await expect(pane).toContainText("retiring this laptop");

  await pane.getByRole("button", { name: "Refresh now" }).click();
  await expect(pane.getByRole("status").filter({ hasText: "Refreshed" })).toBeVisible();

  const remove = pane.getByRole("button", { name: "Remove", exact: true });
  await expect(remove).toBeDisabled();
  await pane.getByLabel("Type personal to confirm removal").fill("persona");
  await expect(remove).toBeDisabled();
  await pane.getByLabel("Type personal to confirm removal").fill("personal");
  await remove.click();
  await expect(row(page, "personal")).toHaveCount(0);
  await expect(page.getByTestId("accounts-summary")).toContainText("3 accounts");
});

test("claude accounts: add one by signing in with Claude and pasting the code", async ({ page }) => {
  await openAccounts(page);
  await page.getByRole("button", { name: "+ Add account" }).click();
  const add = page.getByTestId("add-account");
  await add.getByLabel("Label").fill("team");
  const popup = page.waitForEvent("popup");
  await add.getByRole("button", { name: "Open Claude's sign-in page" }).click();
  await (await popup).close();
  await expect(add.getByTestId("signin-link")).toHaveAttribute("href", /claude\.com\/cai\/oauth\/authorize/);

  await add.getByLabel("Code from the Claude page").fill("bad-code");
  await add.getByRole("button", { name: "Finish sign-in" }).click();
  await expect(add.getByRole("alert")).toContainText("not accepted");
  await add.getByLabel("Code from the Claude page").fill("c0de-from-claude");
  await add.getByRole("button", { name: "Finish sign-in" }).click();
  await expect(add.getByTestId("signin-done")).toContainText("team is available");
  await expect(row(page, "team")).toBeVisible();
  await expect(row(page, "team")).toContainText("—");
});

test("claude accounts: a pasted saved login must carry a refresh token; signing in again recovers", async ({
  page,
}) => {
  await openAccounts(page);
  await page.getByRole("button", { name: "+ Add account" }).click();
  const add = page.getByTestId("add-account");
  await add.getByLabel("Label").fill("laptop-2");
  await add.getByRole("radio", { name: "Paste Claude Code's saved login" }).check();
  await add.getByLabel("Saved login", { exact: true }).fill('{"claudeAiOauth": {"accessToken": "only-an-access-token"}}');
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(add.getByRole("alert")).toContainText("no refresh token");
  await add
    .getByLabel("Saved login", { exact: true })
    .fill('{"claudeAiOauth": {"accessToken": "a", "refreshToken": "r", "expiresAt": 1}}');
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(row(page, "laptop-2")).toBeVisible();

  // The expired one: its pane leads with signing in again.
  await row(page, "old-laptop").getByRole("button").click();
  const pane = detail(page);
  const popup = page.waitForEvent("popup");
  await pane.getByRole("button", { name: "Sign in again with Claude" }).click();
  await (await popup).close();
  await pane.getByLabel("Code from the Claude page").fill("fresh-code");
  await pane.getByRole("button", { name: "Finish sign-in" }).click();
  await expect(row(page, "old-laptop")).toContainText("Available");
  await expect(page.getByTestId("accounts-summary")).not.toContainText("needs a sign-in");
});

test("claude accounts: the fallback credential is set once and never shown back", async ({ page }) => {
  await openAccounts(page);
  const fallback = page.getByTestId("fallback");
  await expect(page.getByTestId("fallback-status")).toContainText("None set.");
  await fallback.getByRole("button", { name: "Set a fallback" }).click();
  await fallback.getByLabel("Setup-token or API key").fill("not-a-claude-token");
  await fallback.getByRole("button", { name: "Save" }).click();
  await expect(fallback.getByRole("alert")).toContainText("Not a Claude credential");
  await fallback.getByLabel("Setup-token or API key").fill(`${SETUP_TOKEN_PREFIX}01-example-abcd`);
  await fallback.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("fallback-status")).toContainText("Claude setup-token …abcd");
  await expect(page.locator("body")).not.toContainText(`${SETUP_TOKEN_PREFIX}01-example`);
  await fallback.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("fallback-status")).toContainText("None set.");
});

test("claude accounts: other roles read the pool and get no controls", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "approver"), MOCK_ROLE_KEY);
  await openAccounts(page);
  await expect(row(page, "personal")).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add account" })).toHaveCount(0);
  await row(page, "personal").getByRole("button").click();
  await expect(page.getByTestId("view-only")).toHaveText("View only");
  await expect(detail(page)).not.toContainText("Only an owner changes accounts.");
  await expect(detail(page).getByRole("button", { name: /^(Make available|Pause|Drain)$/ })).toHaveCount(0);
  await expect(page.getByTestId("fallback").getByRole("button")).toHaveCount(0);
});

test("runs say they execute in SwarmCloud", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-runs").click();
  await expect(page.getByTestId("runs-where")).toContainText("Runs execute in SwarmCloud");
});
