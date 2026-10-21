import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

// D15: Oracle's own jobs live once, in the version view's History, under plain names;
// the PRD overview shows versions only and links there. Each test runs on a laptop and a phone.

const PLAIN = ["Suggest changes from feedback", "Write reports", "Rewrite sections and build drafts", "Quality review"];
const OLD = ["Built-in jobs", "Handle new feedback", "Review comments", "Reporting"];

/** The version view's History tab; on a phone it lives in the Review sheet. */
async function openHistory(page: Page, phone: boolean) {
  if (phone) await page.getByTestId("phone-review").click();
  await page.getByRole("tab", { name: /^History/ }).filter({ visible: true }).click();
}

const oracleWork = (page: Page) => page.getByTestId("history-jobs").filter({ visible: true });
const jobsPanel = (page: Page) => page.getByTestId("jobs-panel").filter({ visible: true });
/** A job row by its plain name. */
const job = (page: Page, name: string) =>
  jobsPanel(page).getByTestId("llm-job").filter({ has: page.getByTestId("job-kind").getByText(name, { exact: true }) });

for (const width of [1366, 390]) {
  const phone = width < 640;
  const size = { width, height: phone ? 844 : 820 };

  test.describe(`${width} px`, () => {
    test.use({ viewport: size });

    test("the PRD overview shows versions only, no Oracle machinery", async ({ page }) => {
      await login(page);
      await page.goto("/documents/team-workspaces");
      await expect(page.getByTestId("versions-table")).toBeVisible();
      await expect(page.getByTestId("version-inspector")).toBeVisible();
      await expect(page.getByTestId("jobs-panel")).toHaveCount(0);
      await expect(page.getByTestId("llm-job-settings")).toHaveCount(0);
      const main = page.locator("main");
      for (const text of ["Built-in jobs", "Handle new feedback"]) await expect(main).not.toContainText(text);
      await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toHaveCount(0);
    });

    test("History has Oracle's work: plain switches an owner toggles", async ({ page }) => {
      await login(page);
      await page.goto("/documents/team-workspaces/v/2");
      await openHistory(page, phone);
      const fold = oracleWork(page);
      await expect(fold.getByRole("button", { name: "Oracle's work", exact: true })).toHaveAttribute("aria-expanded", "true");
      const settings = fold.getByTestId("llm-job-settings");
      await expect(settings.locator("legend")).toContainText("Oracle does on its own");
      for (const label of PLAIN) await expect(settings.getByLabel(label, { exact: true })).toBeChecked();
      for (const text of OLD) await expect(fold).not.toContainText(text);

      // Turning "Suggest changes from feedback" off switches review_comments off: the queue refuses it.
      const suggest = settings.getByLabel("Suggest changes from feedback", { exact: true });
      await suggest.uncheck();
      await expect(suggest).not.toBeChecked();
      await jobsPanel(page).getByRole("button", { name: "Suggest changes now", exact: true }).click();
      await expect(jobsPanel(page).getByRole("alert").filter({ hasText: "turned off" })).toBeVisible();
      await page.reload();
      await openHistory(page, phone);
      await expect(oracleWork(page).getByLabel("Suggest changes from feedback", { exact: true })).not.toBeChecked();
      await expect(oracleWork(page).getByLabel("Write reports", { exact: true })).toBeChecked();
    });

    test("an approver sees Oracle's switches disabled, and the tip says who turns them off", async ({ page }) => {
      await login(page, "approver@example.com");
      await page.goto("/documents/team-workspaces/v/2");
      await openHistory(page, phone);
      const theirs = oracleWork(page).getByTestId("llm-job-settings");
      for (const label of PLAIN) await expect(theirs.getByLabel(label, { exact: true })).toBeDisabled();
      await theirs.getByTestId("info-tip").click();
      await expect(page.getByRole("tooltip").filter({ visible: true })).toHaveText(
        "Oracle reads new feedback and writes reports by itself. Owners turn each off.",
      );
    });

    test("Suggest changes now and Write reports now queue jobs named in plain words", async ({ page }) => {
      await login(page);
      await page.goto("/documents/checkout-redesign/v/2");
      await openHistory(page, phone);
      const panel = jobsPanel(page);
      await expect(panel).toContainText("Oracle hasn't worked on this version yet.");
      await panel.getByRole("button", { name: "Suggest changes now", exact: true }).click();
      await expect(job(page, "Suggestions")).toHaveCount(1);
      await panel.getByRole("button", { name: "Write reports now", exact: true }).click();
      await expect(job(page, "Reports")).toHaveCount(1);
      await expect(panel.getByTestId("llm-job")).toHaveCount(2);
      await expect(panel).not.toContainText("Review comments");
      await expect(panel).not.toContainText("Reporting");
    });

    test("a job's account, tokens and cost show only after Details", async ({ page }) => {
      await login(page);
      await page.goto("/documents/team-workspaces/v/2");
      await openHistory(page, phone);
      const row = job(page, "Suggestions");
      await expect(row).toContainText("3 feedback items handled · 1 pushback");
      await expect(row.getByTestId("job-account")).toBeHidden();
      await expect(row.getByTestId("job-cost")).toBeHidden();
      await expect(row.getByTestId("job-tokens")).toBeHidden();
      await row.getByText("Details", { exact: true }).click();
      await expect(row.getByTestId("job-account")).toHaveText("personal");
      await expect(row.getByTestId("job-cost")).toHaveText("$0.03");
      await expect(row.getByTestId("job-cost")).toHaveAttribute("data-cost", "small");
      await expect(row.getByTestId("job-tokens")).toBeVisible();
    });

    test("the overview inspector links to Oracle's work on the version, for approvers", async ({ page }) => {
      await login(page);
      await page.goto("/documents/team-workspaces");
      const link = page.getByTestId("version-inspector").getByRole("link", { name: "Oracle's work on v2" });
      await expect(link).toHaveAttribute("href", "/documents/team-workspaces/v/2?tab=history#oracle-work");
      await link.click();
      await expect(page).toHaveURL(/\/documents\/team-workspaces\/v\/2\?tab=history#oracle-work$/);
      const fold = oracleWork(page);
      await expect(fold.getByRole("button", { name: "Oracle's work", exact: true })).toBeVisible();
      await expect(fold.getByTestId("llm-job-settings")).toBeInViewport();
      await expect(page.getByRole("tab", { name: /^History/ }).filter({ visible: true })).toHaveAttribute("aria-selected", "true");
    });

    test("a commenter does not run Oracle's work, so the overview offers no link", async ({ page }) => {
      await login(page, "commenter@example.com");
      await page.goto("/documents/team-workspaces");
      await expect(page.getByTestId("version-inspector")).toBeVisible();
      await expect(page.getByRole("link", { name: /^Oracle's work on/ })).toHaveCount(0);
    });
  });
}
