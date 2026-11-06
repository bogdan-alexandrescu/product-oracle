import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/**
 * Pass F, F-1: a list that fails to load says what failed ("Could not load …") with Try again,
 * keeps the server's words behind an (i), shows no empty-state text or count under it, and
 * offers no create button that needs it. Try again, once the API answers, loads the list.
 * Driven through the UI on the mock layer: po-mock-fail makes the mock's GETs of one path fail.
 */

async function failGets(page: Page, path: string) {
  await page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);
}

async function stopFailing(page: Page) {
  await page.evaluate(() => localStorage.removeItem("po-mock-fail"));
}

/** Settings, then one of its tabs, from the app's own nav. */
async function openSettings(page: Page, tab: string) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId(`nav-${tab}`).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${tab}$`));
}

/** Company (opens on Strategy), then one of its tabs. */
async function openCompany(page: Page, tab?: string) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  if (tab) {
    await page.getByTestId(`company-tab-${tab}`).filter({ visible: true }).click();
    await expect(page).toHaveURL(new RegExp(`/company/${tab}$`));
  }
}

/** The failed list's notice: what failed in plain words, the server's words behind the (i), Try again. */
async function expectLoadError(scope: Locator, what: string) {
  const notice = scope.getByTestId("load-error").filter({ visible: true }).first();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`Could not load ${what}.`);
  await expect(notice.getByText("Mock failure")).toBeHidden();
  await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
  return notice;
}

async function retry(page: Page, notice: Locator) {
  await stopFailing(page);
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("load-error").filter({ visible: true })).toHaveCount(0);
}

const main = (page: Page) => page.getByRole("main");

test.describe("F-1: a list that fails to load says so and Try again loads it", () => {
  test("Settings › Notifications", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/company-integrations");
    await openSettings(page, "notifications");
    const notice = await expectLoadError(main(page), "your notification settings");
    await expect(page.getByRole("button", { name: "Connect Oracle to Slack" })).toHaveCount(0);
    await expect(page.getByTestId("report-schedule")).toHaveCount(0);
    await retry(page, notice);
    await expect(page.getByTestId("report-schedule")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Oracle to Slack" })).toBeVisible();
  });

  test("Settings › Sources", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/sources");
    await openSettings(page, "sources");
    const notice = await expectLoadError(main(page), "your sources");
    await expect(page.getByTestId("sources-empty")).toHaveCount(0);
    await expect(page.getByText(/No sources yet/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a source", exact: true })).toBeDisabled();
    await expect(page.getByRole("form", { name: "Add a source" })).toHaveCount(0);
    await retry(page, notice);
    await expect(page.getByRole("list", { name: "My sources" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a source", exact: true })).toBeEnabled();
  });

  test("Settings › Sources: a GitHub source's code maps", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/code-maps");
    await openSettings(page, "sources");
    const row = page.getByRole("listitem", { name: "Example repo" });
    await expect(row).toBeVisible();
    const notice = await expectLoadError(row, "the code maps of Example repo");
    await expect(row.getByText("No code map yet")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Map the code" })).toHaveCount(0);
    await retry(page, notice);
    const line = row.getByTestId("code-map-example-org/example-app");
    await expect(line).toContainText("No code map yet");
    await expect(line.getByRole("button", { name: "Map the code" })).toBeVisible();
  });

  test("Sources (search and coverage)", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/sources/coverage");
    await openSettings(page, "sources");
    await main(page).getByRole("link", { name: "Search sources" }).click();
    await expect(page).toHaveURL(/\/sources$/);
    const coverage = page.getByTestId("coverage-panel");
    const notice = await expectLoadError(coverage, "your sources");
    await expect(coverage.getByTestId("table-empty")).toHaveCount(0);
    await expect(coverage.getByText("No sources yet")).toHaveCount(0);
    await expect(coverage.getByRole("link", { name: "Add a source" })).toHaveCount(0);
    await retry(page, notice);
    await expect(coverage.getByTestId("coverage-items").first()).toBeVisible();
  });

  test("Settings › Templates", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/templates");
    await openSettings(page, "templates");
    const notice = await expectLoadError(main(page), "your templates");
    await expect(page.getByText("No PRD templates", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No roadmap templates", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "New template" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New template" })).toBeDisabled();
    await retry(page, notice);
    await expect(page.locator('[data-testid^="template-row-"]').first()).toBeVisible();
    await expect(page.getByRole("link", { name: "New template" })).toBeVisible();
  });

  test("Settings › Themes", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/themes");
    await openSettings(page, "themes");
    const notice = await expectLoadError(main(page), "your themes");
    await expect(page.getByText("No themes yet", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "New theme" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New theme" })).toBeDisabled();
    await retry(page, notice);
    await expect(page.locator('[data-testid^="theme-row-"]').first()).toBeVisible();
    await expect(page.getByRole("link", { name: "New theme" })).toBeVisible();
  });

  test("Settings › Claude accounts", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/claude-accounts");
    await openSettings(page, "claude-accounts");
    const notice = await expectLoadError(main(page), "your Claude accounts");
    await expect(page.getByText("No accounts registered")).toHaveCount(0);
    await expect(page.getByTestId("accounts-summary")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "+ Add account" })).toHaveCount(0);
    await retry(page, notice);
    await expect(page.getByTestId("accounts-summary")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add account" })).toBeVisible();
  });

  test("Settings › Webhooks", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/webhooks");
    await openSettings(page, "webhooks");
    const notice = await expectLoadError(main(page), "your webhooks");
    await expect(page.getByTestId("webhooks-empty")).toHaveCount(0);
    await expect(page.getByText(/No webhooks yet/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New webhook" })).toBeDisabled();
    await retry(page, notice);
    await expect(page.getByTestId("webhooks-empty").or(page.getByTestId("webhook-row")).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New webhook" })).toBeEnabled();
  });

  test("Settings › Trash", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/trash");
    await openSettings(page, "trash");
    const notice = await expectLoadError(main(page), "the trash");
    await expect(page.getByTestId("trash-empty")).toHaveCount(0);
    await expect(page.getByText("Trash is empty.")).toHaveCount(0);
    await retry(page, notice);
    await expect(page.getByTestId("trash-empty").or(page.getByTestId("trash-entry")).first()).toBeVisible();
  });

  test("Settings › Autonomy", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/autonomy");
    await openSettings(page, "autonomy");
    const notice = await expectLoadError(main(page), "the autonomy levels");
    await expect(page.getByTestId("autonomy-stays")).toHaveCount(0);
    await retry(page, notice);
    await expect(page.getByTestId("autonomy-stays")).toBeVisible();
  });

  test("Settings › API tokens", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/api-tokens");
    await openSettings(page, "api-tokens");
    const notice = await expectLoadError(main(page), "the API tokens");
    await expect(page.getByText("No tokens", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("table-empty")).toHaveCount(0);
    await expect(page.getByTestId("active-count")).toHaveCount(0);
    await retry(page, notice);
    await expect(page.getByTestId("token-row").first()).toBeVisible();
    await expect(page.getByTestId("active-count")).toBeVisible();
  });

  test("Company › Metrics", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/metrics");
    await openCompany(page, "metrics");
    const notice = await expectLoadError(main(page), "the metrics");
    await expect(page.getByText("Nothing yet", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("metrics-empty")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add your first metric" })).toHaveCount(0);
    const add = page.getByRole("button", { name: "Add metric" }).filter({ visible: true });
    if (await add.count()) await expect(add).toBeDisabled();
    await retry(page, notice);
    await expect(page.getByTestId("metrics-empty").or(page.getByTestId("metric-row")).first()).toBeVisible();
  });

  test("Company › Strategy: the drift findings", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/strategy/findings");
    await openCompany(page);
    const drift = page.getByTestId("drift-list").filter({ visible: true });
    const notice = await expectLoadError(drift, "the drift findings");
    await expect(drift.getByTestId("drift-empty")).toHaveCount(0);
    await expect(drift.getByText("No open findings")).toHaveCount(0);
    await retry(page, notice);
    await expect(drift.getByTestId("drift-empty").or(drift.locator("ul > li")).first()).toBeVisible();
  });

  test("A document's History › Oracle's work", async ({ page }) => {
    await login(page);
    await failGets(page, "/v1/documents/team-workspaces/llm-jobs");
    // A deep page: the version view, then its History tab.
    await page.goto("/documents/team-workspaces/v/2");
    await page.getByRole("tab", { name: /^History/ }).filter({ visible: true }).click();
    const jobs = page.getByTestId("jobs-panel").filter({ visible: true });
    const notice = await expectLoadError(jobs, "Oracle's work");
    await expect(jobs.getByText("Oracle hasn't worked on this version yet.")).toHaveCount(0);
    await expect(jobs.getByRole("button", { name: "Suggest changes now", exact: true })).toBeDisabled();
    await expect(jobs.getByRole("button", { name: "Write reports now", exact: true })).toBeDisabled();
    await retry(page, notice);
    await expect(jobs.getByTestId("llm-job").first()).toBeVisible();
    await expect(jobs.getByRole("button", { name: "Suggest changes now", exact: true })).toBeEnabled();
  });
});
