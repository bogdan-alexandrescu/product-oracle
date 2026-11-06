import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { WEBHOOKS_SCENARIO } from "../lib/api/mock/webhooks";
import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/** Visual QA pass F, Settings › API tokens, Webhooks and Claude accounts. */

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);
const tokenRows = (page: Page) => page.getByTestId("token-row");

test("F-19, F-67: the API tokens (i) says what each kind is for in plain words, and no panel of sentences sits above the list", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  await expect(page.getByRole("heading", { level: 1, name: "API tokens" })).toBeVisible();
  await expect(page.getByText("Where tokens come from")).toHaveCount(0);
  await page.getByRole("button", { name: "About API tokens" }).click();
  const tip = page.getByTestId("tokens-made-where");
  await expect(tip).toContainText("Personal: a member's own key");
  await expect(tip).toContainText("MCP client: an AI tool a member let connect to Oracle");
  for (const jargon of ["po_", "ort_", "poa_", "OAuth", "scopes"]) await expect(tip).not.toContainText(jargon);
  // The kind filter names it the same way.
  await expect(page.getByTestId("kind-mcp_client")).toHaveText("MCP client");
});

test("F-66: the title's badges filter the tokens to the ones they count, and again shows all", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  await expect(tokenRows(page).first()).toBeVisible();
  const all = await tokenRows(page).count();
  const expired = page.getByTestId("expired-count");
  await expect(expired).toHaveText("1 expired");
  await expired.click();
  await expect(expired).toHaveAttribute("aria-pressed", "true");
  await expect(tokenRows(page)).toHaveCount(1);
  await expect(tokenRows(page)).toContainText("staging sync");
  await page.getByTestId("revoked-count").click();
  await expect(tokenRows(page).first()).toContainText("Revoked");
  await expect(tokenRows(page).filter({ hasNotText: "Revoked" })).toHaveCount(0);
  await page.getByTestId("revoked-count").click();
  await expect(tokenRows(page)).toHaveCount(all);
});

test("F-66: a pressed badge stays shown at 0 when the kind changes, so the filter can be turned off", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  const expired = page.getByTestId("expired-count");
  await expect(expired).toHaveText("1 expired");
  await expired.click();
  await expect(tokenRows(page)).toHaveCount(1);
  // Service tokens have no expired one: the list is empty and says why, and the pressed badge stays.
  await page.getByTestId("kind-service").click();
  await expect(page.getByText("No expired tokens")).toBeVisible();
  await expect(expired).toHaveText("0 expired");
  await expect(expired).toHaveAttribute("aria-pressed", "true");
  await expired.click();
  await expect(expired).toHaveCount(0);
  await expect(tokenRows(page).first()).toBeVisible();
});

test("F-67: a long token name wraps in the Name column instead of being cut", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  const name = tokenRows(page).first().getByRole("cell").first().locator("span").first();
  await expect(name).toBeVisible();
  await expect(name).not.toHaveClass(/\btruncate\b/);
});

test("F-20, F-64, F-65: Webhooks says it in plain words: no file or header names, Format version, no HTTP numbers, no cross on a retry", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page);
  await page.goto("/settings/webhooks");
  await page.getByRole("button", { name: "About Webhooks" }).click();
  const tip = page.getByRole("tooltip").or(page.getByRole("dialog")).filter({ hasText: "signs each event" });
  await expect(tip).toBeVisible();
  for (const jargon of ["docs/", "runbook", "webhook-signature", "Standard Webhooks"]) await expect(tip).not.toContainText(jargon);
  await page.keyboard.press("Escape");

  const deploy = page.getByTestId("webhook-row").filter({ hasText: "Deploy notifier" });
  // Its last delivery is still being retried: no failure cross, no 500.
  await expect(deploy).toContainText("Retrying · 4 h ago");
  await expect(deploy).not.toContainText("✕");
  await expect(deploy).not.toContainText("500");
  await deploy.click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector).toContainText("Format version");
  await expect(inspector).not.toContainText("Payload format");
  await expect(inspector).not.toContainText("The layout of the JSON");
  await expect(inspector).toContainText("Private details");
  await expect(inspector).not.toContainText("Owners-and-approvers");
  const log = page.getByRole("list", { name: "Delivery log" });
  await expect(log.getByTestId("delivery-row").first()).toContainText("Server answered with an error");
  await expect(log.getByTestId("delivery-row").first()).not.toContainText("HTTP");
});

test("F-7: an owner's webhook rows count in the Inbox's header and rail badge, and resuming one takes it off every count", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page);
  await page.goto("/inbox");
  const webhooks = page.getByTestId("inbox-webhooks");
  const failing = webhooks.getByRole("row").filter({ hasText: "Webhook Deploy notifier paused: failing for 3 days" });
  await expect(failing).toBeVisible();
  const header = page.getByText(/^\d+ waiting$/).first();
  const badge = page.getByTestId("nav-inbox-badge").filter({ visible: true });
  const before = Number((await header.textContent())!.split(" ")[0]);
  await expect(badge).toHaveText(String(before));
  // The two webhook rows are among the counted ones: the header counts what is shown.
  await expect(page.getByTestId("inbox-needs")).toContainText(String(before));
  // F-21: the Kind cell reads whole: one short word, never cut.
  const moved = webhooks.getByRole("row").filter({ hasText: "changed where" });
  await expect(moved.getByRole("cell").filter({ hasText: /^Webhook$/ })).toHaveCount(1);
  await expect(moved).not.toContainText("Webhook address");
  await failing.getByRole("button", { name: "Resume" }).click();
  await expect(failing).toHaveCount(0);
  await expect(header).toHaveText(`${before - 1} waiting`);
  await expect(badge).toHaveText(String(before - 1));
});

test("F-25: a viewer's Inbox lists no webhook rows they could not open", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page);
  await page.goto("/inbox");
  // The owner's webhook notice is in their Inbox ...
  await expect(page.getByTestId("inbox-webhooks").getByText("Webhook Deploy notifier paused")).toBeVisible();
  // ... and once they are a viewer the API still sends it to them (as it does a member whose
  // role went down): the Inbox, not the API, leaves it out.
  await page.evaluate(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY]);
  await page.reload();
  // Its rows have loaded (the header counts them) before looking for what is left out.
  await expect(page.getByText(/^\d+ waiting$/).first()).toBeVisible();
  await expect(page.getByText("Webhook Deploy notifier paused")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open" }).filter({ hasText: "Open" }).and(page.locator('[href^="/settings/webhooks"]'))).toHaveCount(0);
});

test("F-77: a commenter turned away from Webhooks is told an approver or owner can use it", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/settings/webhooks");
  const gate = page.getByTestId("not-for-role");
  await expect(gate).toContainText("An approver or owner can set up webhooks");
  await expect(gate).not.toContainText("Ask an owner (");
});

test("F-73, F-66: Claude accounts says sign-in in plain words, and its 'needs a sign-in' badge opens that account", async ({ page }) => {
  await login(page);
  await page.goto("/settings/claude-accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
  await expect(page.getByText("refresh token", { exact: false })).toHaveCount(0);
  await expect(page.getByText("setup-token", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "work", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "work", exact: true })).toBeVisible();
  await page.getByTestId("needs-signin-count").click();
  await expect(page.getByRole("heading", { name: "old-laptop", exact: true })).toBeVisible();
  // No row stays chosen while the Add panel is open.
  await page.getByRole("button", { name: "+ Add account" }).click();
  await expect(page.locator('[aria-current="true"]').filter({ hasText: "old-laptop" })).toHaveCount(0);
  await expect(page.getByText("Adds the account signed in on Claude's page").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("To add a different one", { exact: false }).filter({ visible: true })).toHaveCount(0);
});

test("F-51: My account's token parts use plain names and keep their reasons behind an (i)", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY]);
  await login(page);
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Create a token" });
  await expect(form.getByRole("textbox", { name: "Name" })).toHaveAttribute("placeholder", "e.g. My laptop");
  await expect(form.getByRole("group", { name: "What it can do" })).toBeVisible();
  // Why Write is narrow for a viewer: behind the (i), not a line on the page.
  await expect(form.getByTestId("write-scope-note")).toBeHidden();
  await form.getByRole("button", { name: "About what Write allows" }).click();
  await expect(form.getByTestId("write-scope-note")).toBeVisible();
  await expect(page.getByTestId("password-revokes")).toBeHidden();
  // Owner's decision (Nov 5): the credentials people authorize for AI tools stay "MCP clients".
  await expect(page.getByTestId("clients-panel")).toContainText("MCP clients");
  await expect(page.getByText("Connected app", { exact: false })).toHaveCount(0);
});

test("Owner's decision (Nov 5): the webhook switch is 'Private details', and its (i) and the lock say it is what only owners and approvers can see", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await login(page);
  await page.goto("/settings/webhooks");
  const tipText = "What only owners and approvers can see in Oracle.";
  // The New webhook switch, with its (i).
  await page.getByRole("button", { name: "New webhook" }).click();
  const sheet = page.getByRole("dialog", { name: "New webhook" });
  await expect(sheet.getByRole("switch", { name: "Private details", exact: true })).toBeVisible();
  await expect(sheet).not.toContainText("Include private details");
  await sheet.getByRole("button", { name: "About private details" }).click();
  await expect(page.getByText(tipText).filter({ visible: true })).toBeVisible();
  await sheet.getByLabel("Name").fill("Team channel");
  await sheet.getByLabel("URL").fill("https://hooks.example.test/team");
  await sheet.getByRole("checkbox", { name: "All Approvals" }).check();
  await sheet.getByRole("switch", { name: "Private details", exact: true }).click();
  await sheet.getByLabel("Why").fill("The team channel is owners and approvers only");
  await sheet.getByRole("button", { name: "Create" }).click();
  await page.getByRole("dialog", { name: "Webhook created" }).getByRole("button", { name: "Done" }).click();
  // The list's lock says what it means.
  const row = page.getByTestId("webhook-row").filter({ hasText: "Team channel" });
  await expect(row.getByTestId("approvers-content-lock")).toHaveAttribute("title", "Sends private details: what only owners and approvers can see");
  // The panel's row, with the same (i).
  await row.click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector.getByTestId("approvers-content")).toHaveText("On");
  await inspector.getByRole("button", { name: "About private details" }).click();
  await expect(page.getByText(tipText).filter({ visible: true })).toBeVisible();
});
