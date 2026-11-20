import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #1590: how-to and background text moved off the page into the (i) beside what it explains.
 * protects = each moved text is no longer visible on its page, and stays readable: clicking
 * its (i) shows it in the tip.
 * fails_when = a moved text is back on the page as plain prose, or its tip is gone or empty.
 */

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** The text is not on the page as visible prose; the (i) named by testId shows it. */
async function behindTip(page: Page, testId: string, text: string) {
  await expect(page.getByText(text).filter({ visible: true })).toHaveCount(0);
  await page.getByTestId(testId).filter({ visible: true }).first().click();
  await expect(page.getByRole("tooltip").filter({ hasText: text, visible: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

test("Quality: how checks and ratings are kept, and how to add a report, sit behind tips", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/documents/referral-link/v/2/quality");
  await expect(page.getByTestId("latest-report")).toContainText("No saved check yet");
  await behindTip(page, "latest-report-tip", "Ratings are kept on their own, in History.");
  await behindTip(page, "latest-report-tip", "Save this check to History keeps this result to compare later");
  await expect(page.getByTestId("history-empty")).toContainText("No evaluation reports for v2 yet");
  await behindTip(page, "history-empty-tip", "To add one, save this check or rate a criterion.");
});

test("Brief: what each Oracle button does sits behind a tip", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-interview-follow-up", "off"));
  await scenario(page, "before-drafting");
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByTestId("intake-read")).toBeVisible();
  await behindTip(page, "intake-oracle-tip", "Oracle reads the brief and its sources, and lists what it assumed");
  await behindTip(page, "intake-oracle-tip", "Draft with Oracle: Oracle writes the PRD from the brief");
});

test("Impact: how to read the board and what proposing does sit behind tips", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  await page.goto("/documents/annual-billing/v/2/impact");
  await expect(page.getByText("Preview: v2 marks nothing stale.")).toBeVisible();
  await behindTip(page, "impact-intro-tip", "The lines show what each output was built from in earlier versions");
  const flow = page.getByRole("complementary", { name: "Regeneration plan" }).getByTestId("plan-row").filter({ hasText: "Checkout flow" });
  await page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-output").filter({ hasText: "Checkout flow" }).click();
  await flow.getByRole("button", { name: "Accept regeneration" }).click();
  await expect(flow.getByText("Nothing is rewritten until the run starts.")).toBeVisible();
  await behindTip(page, "propose-tip", "Creates a draft run; nothing is rewritten until someone estimates and starts it.");
  await behindTip(page, "estimate-tip", "On the run page, once the draft run is proposed.");
});

test("Account: what each Slack ping covers and where the name shows sit behind tips", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  await expect(page.getByTestId("ping-draft_ready")).toBeVisible();
  await behindTip(page, "ping-draft_ready-tip", "A new draft of a document you review.");
  await behindTip(page, "ping-comments-tip", "New comments and replies on sections you own or review.");
  await behindTip(page, "account-name-tip", "Shown to your teammates instead of your email.");
});

test("Interview: why the link is shown only once sits behind a tip", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await page.getByTestId("requests-tab-interviews").filter({ visible: true }).click();
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  await expect(page.getByTestId("interview-link-note")).toContainText("Not opened yet.");
  await behindTip(page, "interview-link-tip", "For safety the link is shown only once");
  await behindTip(page, "interview-link-tip", "If Ana Lima lost it, use Make a new link; the old link stops working.");
});

test("Plan: when a draft item's finding can be waived, and how a spec is drafted, sit behind tips", async ({ page }) => {
  await scenario(page, "strategy-plan");
  await login(page);
  await page.goto("/plan");
  await page.getByTestId("plan-row").filter({ visible: true }).and(page.locator('[data-item="spend-forecast"]')).getByTestId("plan-title").click();
  await expect(page.getByTestId("plan-drift-card").filter({ visible: true })).toContainText("It serves no goal");
  await behindTip(page, "plan-drift-draft-tip", "It can be waived once the roadmap is approved.");
});

test("Request spec: how the spec is drafted sits behind a tip", async ({ page }) => {
  await scenario(page, "plan-decider");
  await login(page);
  await page.goto("/plan");
  await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Threshold alerts on spend" }).getByTestId("plan-title").click();
  await page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-spec").getByRole("button", { name: "Request spec" }).click();
  const dialog = page.getByRole("dialog", { name: "Request an engineering spec" });
  await expect(dialog).toBeVisible();
  await behindTip(page, "request-spec-tip", "Oracle drafts the spec from the approved PRD in a run.");
});

test("Market: what each empty tab is for sits behind a tip; who adds stays one line", async ({ page }) => {
  await login(page);
  await page.goto("/company/market");
  const tabs = page.getByRole("tablist", { name: "Market" });
  await expect(page.getByTestId("alternatives-empty").filter({ visible: true })).toContainText("No alternatives yet");
  await behindTip(page, "alternatives-empty-tip", "Add what a customer could use instead of you");
  await tabs.getByRole("tab", { name: "Change log" }).click();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: /^From the web/ }).click();
  await expect(page.getByTestId("findings-empty")).toContainText("Nothing from the web to vet");
  await behindTip(page, "findings-empty-tip", "Once a month Oracle searches the web for news, reviews and launches");
  await tabs.getByRole("tab", { name: "Pricing" }).click();
  await expect(page.getByTestId("pricing-empty")).toContainText("No pricing memos yet");
  await behindTip(page, "pricing-empty-tip", "A memo sets out one pricing question, two to four options");
  await tabs.getByRole("tab", { name: "Win and loss" }).click();
  await expect(page.getByTestId("deals-empty")).toContainText("No win or loss records yet");
  await behindTip(page, "deals-empty-tip", "Record why each deal was won, lost or churned");
});

test("Market: a reader who cannot add is told who does, in one line", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/company/market");
  const empty = page.getByTestId("alternatives-empty").filter({ visible: true });
  await expect(empty.getByText("Approvers and owners add them.")).toBeVisible();
  await behindTip(page, "alternatives-empty-tip", "Oracle then reads their public pages every week");
});

test("Updates: what the list holds, and who it is for, sit behind tips", async ({ page }) => {
  await scenario(page, "empty");
  await login(page);
  await page.goto("/company/updates");
  await expect(page.getByTestId("updates-empty")).toContainText("No updates yet");
  await behindTip(page, "updates-empty-tip", "Oracle drafts the board and investor updates from your goals and metrics.");
});

test("Updates: a commenter sees who the page is for, and the why behind a tip", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/company/updates");
  await expect(page.getByTestId("updates-not-found").filter({ visible: true })).toContainText("Updates are for owners and approvers");
  await behindTip(page, "updates-not-found-tip", "until an owner shares one with the whole company");
});

test("Composition: how the first revision is made sits behind a tip", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/documents/referral-link/composition?tab=history");
  await expect(page.getByTestId("history-empty")).toContainText("No revisions yet");
  await behindTip(page, "history-empty-tip", "An approver makes the first revision by choosing Use these modules");
});

// #1590 part 2: the next pages with the most prose.

test("Impact: what proposing a new version keeps sits behind a tip", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  await page.goto("/impact/changes/b7dce326-2a47-4000-8b74-562e8ac05a9c");
  await expect(page.getByText("Recorded: this change marked these outputs Potentially stale.")).toBeVisible();
  await behindTip(page, "propose-version-tip", "stays as it is until a reviewer approves the new one.");
});

test("Evidence: what a red column means and who sees the links sit behind tips", async ({ page }) => {
  await login(page);
  await page.goto("/documents/annual-billing/v/2/evidence");
  await behindTip(page, "evidence-red-tip", "A red column is a section with no links or citations");
  await behindTip(page, "evidence-links-tip", "Readers never see these links on the page");
});

test("Public version: what it is sits behind a tip; why this document has none stays", async ({ page }) => {
  await login(page);
  await page.goto("/documents/annual-billing/public");
  await expect(page.getByText("Annual billing PRD is a PRD, so it has none.")).toBeVisible();
  await behindTip(page, "public-version-tip", "A public version is the page anyone with a roadmap's public link reads.");
});

test("Roadmap: how launches and changelog entries are made sit behind tips", async ({ page }) => {
  await login(page);
  await page.goto("/roadmap/launches");
  await behindTip(page, "launches-empty-tip", "They are planned when a roadmap is approved.");
  await page.goto("/roadmap/changelog");
  await expect(page.getByText("No entries yet.").filter({ visible: true }).first()).toBeVisible();
  await behindTip(page, "changelog-empty-tip", "Oracle adds one when it drafts a launch's kit");
  await behindTip(page, "changelog-export-tip", "export gives the published public entries");
});

test("Settings: what Slack and the weekly report do, and how to save, sit behind tips", async ({ page }) => {
  await login(page);
  await page.goto("/settings/notifications");
  await expect(page.getByRole("button", { name: "Connect Oracle to Slack" })).toBeVisible();
  await behindTip(page, "slack-about-tip", "It is installed once for the company and posts as Product Oracle.");
  await behindTip(page, "weekly-report-tip", "Every week Oracle reports the roadmap against engineering for the week that ended");
  await page.goto("/settings/company");
  await behindTip(page, "company-save-tip", "Change the size or focus to save it.");
  await page.goto("/settings/templates/one-pager");
  await behindTip(page, "template-save-tip", "Change the template to save a new version.");
  await behindTip(page, "template-meta-save-tip", "Change the name or description to save them.");
  await page.goto("/settings/themes/clean-document");
  await behindTip(page, "font-fallback-tip", "without it, Helvetica, then Arial, then sans-serif.");
  await page.goto("/settings/claude-accounts");
  await expect(page.getByRole("button", { name: "Make available", exact: true })).toBeDisabled();
  await behindTip(page, "claude-account-signin-tip", "It can be made available once someone signs in to it again");
});

test("Company: the time zone note and what strategy findings are sit behind tips", async ({ page }) => {
  await login(page);
  await page.goto("/company/rituals");
  await behindTip(page, "rituals-zone-tip", "Times use Pacific Time (Los Angeles) until you set the company time zone.");
  await page.goto("/company/strategy");
  await behindTip(page, "strategy-drift-tip", "Goals and items that do not follow the strategy show here.");
});

test("Plan: how outcomes, reports and saved orders are made sit behind tips", async ({ page }) => {
  await login(page);
  await page.goto("/plan/outcomes");
  await expect(page.getByText("No outcomes yet").filter({ visible: true }).first()).toBeVisible();
  await behindTip(page, "outcomes-empty-tip", "Approving a roadmap records a prediction for each item that serves a goal.");
  await page.goto("/plan/reports");
  await expect(page.getByText("No report yet.").filter({ visible: true }).first()).toBeVisible();
  await behindTip(page, "reports-empty-tip", "Oracle makes one every week for the week that ended.");
  await page.goto("/priorities");
  await behindTip(page, "priorities-save-tip", "Save one above to keep this order and compare it later.");
  await behindTip(page, "priorities-move-tip", "Use ▲ ▼ or More actions on a row to move or pin a feature, with a reason.");
});

test("Interview and new PRD: what fills in later, and how much to write, sit behind tips", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await page.getByTestId("requests-tab-interviews").filter({ visible: true }).click();
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  await behindTip(page, "interview-snapshot-tip", "Oracle writes a snapshot here once Ana Lima finishes the interview.");
  await behindTip(page, "interview-requests-tip", "The requests Ana Lima makes show here, to decide, once they finish the interview.");
  await page.goto("/documents/new");
  await behindTip(page, "brief-length-tip", "A couple of sentences is enough (at least 20 characters).");
});
