import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { WEBHOOK_RECEIVER, WEBHOOKS_SCENARIO } from "../lib/api/mock/webhooks";
import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4 fixes on Settings › API tokens, Settings › Webhooks and the rail's Inbox badge,
 * driven through the UI on the mock layer as a person would.
 */

/** The mock's outbox posts each delivery here; it answers 200. Without it a send can't connect. */
async function stubReceiver(page: Page) {
  await page.exposeFunction(WEBHOOK_RECEIVER, () => ({ status: 200, body: "ok" }));
}

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openSettings(page: Page, tab: "nav-webhooks" | "nav-api-tokens") {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId(tab).click();
}

async function createWebhook(page: Page, name: string, url: string) {
  await page.getByRole("button", { name: "New webhook" }).click();
  const form = page.getByRole("dialog", { name: "New webhook" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("URL").fill(url);
  await form.getByRole("checkbox", { name: "All Runs" }).check();
  await form.getByRole("button", { name: "Create" }).click();
  const made = page.getByRole("dialog", { name: "Webhook created" });
  await expect(made).toContainText("Copy it now. Oracle won't show it again.");
  return made;
}

test("qa4-settings-23: a company-owned API token reads For The company", async ({ page }) => {
  await openSettings(page, "nav-api-tokens");
  await expect(page.getByRole("heading", { level: 1, name: "API tokens" })).toBeVisible();
  const row = page.getByTestId("token-row").filter({ hasText: "ci-export" });
  await expect(row).toContainText("The company");
  await expect(row).not.toContainText("No one");
});

test("qa4-settings-25: a test send that can't reach the host says so in words and offers Try again", async ({ page }) => {
  // No receiver: the send can't connect.
  await openSettings(page, "nav-webhooks");
  const made = await createWebhook(page, "Unreachable hook", "https://hooks.example.com/oracle");
  await made.getByRole("button", { name: "Send test event" }).click();
  const result = made.getByTestId("test-result");
  await expect(result).toContainText("Couldn't reach hooks.example.com");
  await expect(result).not.toContainText("connect");
  await expect(made.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("qa4-settings-26: the Delivery log names events as the form does", async ({ page }) => {
  await stubReceiver(page);
  await openSettings(page, "nav-webhooks");
  const made = await createWebhook(page, "Plain log", "https://hooks.example.com/plain");
  await made.getByRole("button", { name: "Send test event" }).click();
  await expect(made.getByTestId("test-result")).toContainText("✓ 200");
  await made.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("webhook-row").filter({ hasText: "Plain log" }).click();
  const log = page.getByTestId("webhook-inspector").getByTestId("delivery-log");
  const row = log.getByTestId("delivery-row").first();
  await expect(row).toContainText("Test event");
  await expect(row).not.toContainText("webhook.test");
  const options = await log.getByLabel("Event").locator("option").allTextContents();
  expect(options).toContain("Test event");
  expect(options).toContain("A run started");
  expect(options.some((o) => /^[a-z]+\.[a-z_]+$/.test(o))).toBe(false);
});

test("qa4-settings-27: a test sent from the inspector updates the list's Last delivery", async ({ page }) => {
  await stubReceiver(page);
  await openSettings(page, "nav-webhooks");
  const made = await createWebhook(page, "Fresh hook", "https://hooks.example.com/fresh");
  await made.getByRole("button", { name: "Done" }).click();
  const row = page.getByTestId("webhook-row").filter({ hasText: "Fresh hook" });
  await expect(row).toContainText("None yet");
  await row.click();
  await page.getByTestId("webhook-inspector").getByRole("button", { name: "Send test event" }).click();
  await expect(page.getByTestId("webhook-inspector").getByTestId("test-result")).toContainText("✓ 200");
  await expect(row).toContainText("✓ 200");
  await expect(row).not.toContainText("None yet");
});

test("qa4-settings-28: the inspector shows the payload format as a day, not an ISO API version", async ({ page }) => {
  await scenario(page, WEBHOOKS_SCENARIO);
  await openSettings(page, "nav-webhooks");
  await page.getByTestId("webhook-row").filter({ hasText: "Deploy notifier" }).click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector).toContainText("Payload format");
  await expect(inspector.getByTestId("payload-format")).toHaveText("Oct 25, 2026");
  await expect(inspector).not.toContainText("API version");
  await expect(inspector).not.toContainText("2026-10-25");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa4-settings-29: after Create the dialog says Webhook created and shows the whole secret", async ({ page }) => {
    await login(page);
    await page.goto("/settings/webhooks");
    const made = await createWebhook(page, "Secret hook", "https://hooks.example.com/secret");
    await expect(page.getByRole("dialog", { name: "New webhook" })).toHaveCount(0);
    const field = made.getByLabel("Signing secret", { exact: true });
    await expect(field).toHaveValue(/^whsec_/);
    // Nothing cut off in the narrow field: the secret wraps instead.
    const cut = await field.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cut).toBe(false);
  });
});

test.describe("on a 900 px window", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("qa4-settings-30: New webhook keeps Create in view and names what is missing", async ({ page }) => {
    await openSettings(page, "nav-webhooks");
    await page.getByRole("button", { name: "New webhook" }).click();
    const form = page.getByRole("dialog", { name: "New webhook" });
    await expect(form.getByRole("button", { name: "Create" })).toBeInViewport();
    await expect(form.getByRole("button", { name: "Cancel" })).toBeInViewport();
    const missing = form.getByTestId("create-missing");
    await expect(missing).toHaveText("Add a name");
    await form.getByLabel("Name").fill("Footer hook");
    await expect(missing).toHaveText("Add a URL");
    await form.getByLabel("URL").fill("https://hooks.example.com/footer");
    await expect(missing).toHaveText("Pick at least one event");
    await form.getByRole("checkbox", { name: "A run started" }).check();
    await expect(missing).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Create" })).toBeEnabled();
  });
});

test("qa4-settings-31: the owners-and-approvers option says what is sent and who sees it", async ({ page }) => {
  await openSettings(page, "nav-webhooks");
  await page.getByRole("button", { name: "New webhook" }).click();
  const help = page.getByRole("dialog", { name: "New webhook" }).getByTestId("approvers-content-help");
  await expect(help).toContainText("only owners and approvers can see");
  await expect(help).toContainText("Anyone who can read the receiving tool will see them");
  await expect(help).not.toContainText("Off unless you say why");
});

test("qa4-settings-32: the rail's two-digit Inbox badge fits its number and clears the icon", async ({ page }) => {
  await login(page);
  const inbox = page.getByTestId("app-nav").getByTestId("nav-inbox");
  const badge = inbox.getByTestId("nav-inbox-badge");
  await expect(badge).toHaveText("11");
  const b = (await badge.boundingBox())!;
  const icon = (await inbox.locator("svg").first().boundingBox())!;
  expect(b.height).toBeGreaterThanOrEqual(18);
  expect(b.width).toBeGreaterThanOrEqual(b.height);
  expect(b.x).toBeGreaterThanOrEqual(icon.x + icon.width);
  expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
