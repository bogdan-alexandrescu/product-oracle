import { expect, test, type Page } from "./test";

import { login, standInClaudePage } from "./helpers";

async function openAccounts(page: Page) {
  await standInClaudePage(page);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-claude-accounts").click();
  await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
}

test("qa4-settings-17: template and theme inspectors show names, not internal keys", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates");
  await page.getByTestId("template-row-ai-feature").click();
  const template = page.getByTestId("template-inspector");
  await expect(template.getByRole("heading", { name: "AI feature PRD" })).toBeVisible();
  await expect(template).not.toContainText("ai-feature");
  await expect(template).not.toContainText("technical-spec");

  await page.goto("/settings/themes");
  await page.getByTestId("theme-row-clean-document").click();
  const theme = page.getByTestId("theme-inspector");
  await expect(theme.getByRole("heading", { name: "Clean document" })).toBeVisible();
  await expect(theme).not.toContainText("clean-document");
});

test("qa4-settings-18: the theme preview is large enough to read and shows no citation tokens", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await login(page);
  await page.goto("/settings/themes");
  await page.getByTestId("theme-row-clean-document").click();
  const frame = page.frameLocator('[data-testid="theme-inspector-preview"]');
  await expect(frame.getByRole("heading", { level: 1 })).toBeVisible();
  // The page is shown at no less than six tenths of its size (a full-page thumbnail was under half).
  const box = page.getByTestId("theme-inspector-preview").locator("..");
  await expect.poll(async () => Number(await box.getAttribute("data-scale"))).toBeGreaterThanOrEqual(0.6);
  await expect(frame.getByRole("heading", { name: "Sources and data points" })).toBeVisible();
  await expect(frame.locator("body")).not.toContainText(/\bc\d+:|\[c:/);
});

test("qa4-settings-42: a template created from the starter saves no placeholder 'suggested when' text", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates");
  await page.getByRole("link", { name: "New template" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New template" })).toBeVisible();
  await page.getByLabel("Key").fill("travel-brief");
  await page.getByLabel("Name").fill("Travel brief");
  await expect(page.getByTestId("validation-ok")).toBeVisible();
  await page.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/settings\/templates\/travel-brief$/);
  await expect(page.getByRole("heading", { level: 1, name: "Travel brief" })).toBeVisible();
  await expect(page.getByTestId("suggest-when")).toHaveCount(0);
  await expect(page.getByText("right pick")).toHaveCount(0);
  await expect(page.getByLabel("Template body")).not.toHaveValue(/right pick/);
});

test("qa4-settings-43: Key and Name placeholders read as examples", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/new");
  await expect(page.getByLabel("Key")).toHaveAttribute("placeholder", "e.g. launch-brief");
  await expect(page.getByLabel("Name")).toHaveAttribute("placeholder", "e.g. Launch brief");
  await page.goto("/settings/themes/new");
  await expect(page.getByLabel("Key")).toHaveAttribute("placeholder", "e.g. company-brand");
  await expect(page.getByLabel("Name")).toHaveAttribute("placeholder", "e.g. Company brand");
});

test("qa4-settings-33: the header names the sign-in check, the foot the usage reading", async ({ page }) => {
  await openAccounts(page);
  await expect(page.getByTestId("refresh-sweep")).toHaveText(/^Sign-ins checked \d+ min ago$/);
  await expect(page.getByTestId("accounts-foot")).toContainText(/Usage read \d+–\d+ min ago/);
});

test("qa4-settings-34: Claude accounts use plain labels and show no raw-ID button", async ({ page }) => {
  await openAccounts(page);
  const table = page.getByTestId("account-list");
  await expect(table.getByRole("columnheader", { name: "Last used" })).toBeVisible();
  await expect(table).not.toContainText(/given out/i);
  await page.getByTestId("account-row-personal").getByRole("button").click();
  const pane = page.getByTestId("account-detail");
  await expect(pane.getByRole("heading", { name: "personal" })).toBeVisible();
  await expect(pane.getByTestId("tile-Last given out")).toContainText("Last used by a job");
  await expect(pane.getByText("Facts", { exact: true })).toHaveCount(0);
  await expect(pane.getByText("Details", { exact: true })).toBeVisible();
  await expect(pane.getByRole("tab", { name: "Running now (1)" })).toBeVisible();
  await expect(pane).not.toContainText(/Holding now|given out|Drain/i);
  await expect(pane.getByRole("button", { name: "Copy ID" })).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "Move jobs off", exact: true })).toBeVisible();
});
