import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * H11 Autonomy wired into H4 Strategy and vision and into the words Oracle drafts for people
 * outside the company (external_messages): Settings › Autonomy shows them in effect, and at
 * Observe the Strategy sheet, New update and the launch kit stop Oracle drafting there.
 * Driven through the UI on the mock layer, as an owner would.
 * Each test's card: protects=...; fails_when=...; no_claim=...
 */

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

async function openAutonomy(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

/** An owner sets one responsibility to Observe on Settings › Autonomy, with a reason. */
async function setObserve(page: Page, key: string, title: string) {
  await openAutonomy(page);
  await step(page, key, "Observe").click();
  const sheet = page.getByRole("dialog", { name: `Change ${title}` });
  await sheet.getByLabel("Why").fill("We write these ourselves this quarter");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, key, "Observe")).toHaveAttribute("aria-pressed", "true");
}

// protects=Shape product strategy, Draft the vision and Words for people outside show as in
// effect: no "Takes effect when ..." chip; fails_when=any of the three still waits on a pick;
// no_claim=what each level does (the tests below and pytest).
test("autonomy: strategy, vision and words for people outside are in effect", async ({ page }) => {
  await login(page);
  await openAutonomy(page);
  for (const [key, title] of [
    ["strategy", "Shape product strategy"],
    ["vision", "Draft the vision"],
    ["external_messages", "Words for people outside"],
  ]) {
    await expect(row(page, key)).toContainText(title);
    await expect(row(page, key).getByTestId("autonomy-pending")).toHaveCount(0);
  }
});

// protects=with Shape product strategy at Observe, Draft next version on Company › Strategy
// says Oracle drafts none and offers no Draft with Oracle, while the vision still drafts;
// fails_when=Draft with Oracle is offered for the strategy, or the vision loses it;
// no_claim=the API's 409 (pytest covers it).
test("autonomy: at Observe the strategy sheet drafts nothing with Oracle", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "strategy"), MOCK_SCENARIO_KEY);
  await login(page);
  await setObserve(page, "strategy", "Shape product strategy");
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  const root = page.getByTestId("strategy-page").filter({ visible: true });
  await root.getByTestId("strategy-card").getByRole("button", { name: "Draft next version" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft next version" });
  await expect(sheet.getByTestId("strategy-observing")).toContainText("Oracle is set to observe the product strategy, so it drafts none.");
  await expect(sheet.getByRole("button", { name: "Draft with Oracle" })).toHaveCount(0);
  await sheet.getByTestId("strategy-observing").getByRole("link", { name: "Settings, Autonomy" }).click();
  await expect(page).toHaveURL(/\/settings\/autonomy$/);

  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  // Following the link closed the sheet: coming back finds it closed.
  await expect(page.getByRole("dialog", { name: "Draft next version" })).toHaveCount(0);
  await page.getByTestId("strategy-page").filter({ visible: true }).getByTestId("vision-card").getByRole("button", { name: "Draft next version" }).click();
  const vision = page.getByRole("dialog", { name: "Draft next version" });
  await expect(vision.getByTestId("strategy-observing")).toHaveCount(0);
  await expect(vision.getByRole("button", { name: "Draft with Oracle" })).toBeVisible();
});

// protects=with Words for people outside at Observe, New update says Oracle drafts no update and
// Start from the template opens the new update with no run; fails_when=Draft with Oracle is
// offered, or no update is made; no_claim=the update's template text.
test("autonomy: at Observe New update starts from the template, with no Oracle draft", async ({ page }) => {
  await login(page);
  await setObserve(page, "external_messages", "Words for people outside");
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-updates").click();
  await expect(page).toHaveURL(/\/company\/updates$/);
  await page.getByRole("button", { name: "New update" }).click();
  const dialog = page.getByRole("dialog", { name: "New update" });
  await expect(dialog.getByTestId("update-observing")).toContainText("Oracle is set to observe words for people outside, so it drafts no update.");
  await expect(dialog.getByRole("button", { name: "Draft with Oracle" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start from the template" }).click();
  await expect(page).toHaveURL(/\/documents\/investor-update-[a-z0-9-]+$/);
});

// protects=with Words for people outside at Observe, a launch's Draft with Oracle drafts the
// internal tasks only and says so; release notes and the customer email stay to do;
// fails_when=an external task is drafted or the note is missing; no_claim=the real kit run's
// import (pytest covers it).
test("autonomy: at Observe the launch kit drafts internal texts only", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "launches"), MOCK_SCENARIO_KEY);
  await login(page);
  await setObserve(page, "external_messages", "Words for people outside");
  await page.goto("/plan/documents");
  await page.getByTestId("roadmap-launches-link").click();
  await expect(page).toHaveURL(/\/roadmap\/launches$/);
  await page.getByTestId("launch-filters").getByRole("button", { name: /^Planned/ }).click();
  await page.getByTestId("launch-row").filter({ hasText: "Weekly usage digest" }).click();
  const inspector = page.getByTestId("launch-inspector").filter({ visible: true });
  await expect(inspector.getByTestId("launch-observing")).toContainText("so it drafts internal texts only");
  await inspector.getByTestId("draft-kit").click();
  const task = (key: string) => inspector.locator(`[data-testid="launch-task"][data-key="${key}"]`);
  await expect(task("internal_announcement")).toHaveAttribute("data-status", "drafted");
  await expect(task("support_notes")).toHaveAttribute("data-status", "drafted");
  for (const key of ["release_notes", "customer_email", "in_app_message"]) {
    await expect(task(key)).toHaveAttribute("data-status", "todo");
  }
});
