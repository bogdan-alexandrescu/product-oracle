import { expect, test, type Page } from "./test";

import { login } from "./helpers";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

/*
 * The scheduled Baseline rebuild (oracle.rituals.rebuild): a built-in ritual, off by default,
 * that starts B1's Build the baseline run on its cadence under H11 "Keep the baseline current".
 * Driven through the UI on the mock layer (lib/api/mock/rituals.ts): an owner turns it on and
 * prepares the next occurrence now, as the ticker would at the first Monday 09:00. Made-up
 * people only. Each test's card: protects=...; fails_when=...; no_claim=...
 */

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });

/** A company whose Build the baseline is priced at `usd` (the mock's "rebuild-costly" or
 * "rebuild-over-approval"), with one finished build on 20 October. */
async function withScenario(page: Page, scenario: "rebuild-costly" | "rebuild-over-approval") {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario]);
}

async function openRituals(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId("company-tab-rituals").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/rituals$/);
}

/** The owner turns the Baseline rebuild on and prepares its next occurrence now. */
async function resumeAndPrepare(page: Page) {
  await openRituals(page);
  const row = ritualRow(page, "Baseline rebuild");
  await expect(row).toContainText("Paused");
  await row.click();
  await inspector(page).getByRole("button", { name: "Resume" }).click();
  await expect(ritualRow(page, "Baseline rebuild")).not.toContainText("Paused");
  await inspector(page).getByRole("button", { name: "Prepare now" }).click();
  await expect(page).toHaveURL(/\/company\/rituals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline rebuild" })).toBeVisible();
}

// protects=at the default level (Act) the occurrence starts B1's build with its estimate shown,
// the card opens the run, and the owner's Inbox has the Oracle did row naming the estimate;
// fails_when=the ritual is not listed paused, no run starts, the estimate is missing, or the owner
// is not told; no_claim=the run's segment work (pytest tests/test_rituals_baseline_rebuild.py).
test("baseline rebuild: an owner turns it on and Oracle starts the build with its estimate", async ({ page }) => {
  await login(page);
  await resumeAndPrepare(page);
  const card = page.getByTestId("occurrence-rebuild");
  await expect(card).toContainText("Oracle started the baseline build · Estimate $7.00 at standard depth. Its proposals wait for your review.");
  await expect(page.getByTestId("occurrence-summary")).toHaveCount(0);
  await card.getByRole("link", { name: "Open run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Build the baseline" })).toBeVisible();
  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Started the baseline rebuild" });
  await expect(did).toContainText("Started the baseline rebuild · Estimate $7.00");
  await expect(did).not.toContainText("limit");
  await expect(did).toContainText("Keep the baseline current");
});

// protects=at Observe Oracle only reminds: no build starts, the card says why, and its Build the
// baseline button opens B1's sheet with the estimate; fails_when=a run starts, no reason is
// shown, or the button does not reach the sheet; no_claim=the sheet's own rules
// (baseline-build.spec.ts).
test("baseline rebuild: at Observe the occurrence only reminds and links the Build the baseline sheet", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await page.getByTestId("autonomy-row-baseline").getByRole("group").getByRole("button", { name: "Observe", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Change Keep the baseline current" });
  await sheet.getByLabel("Why").fill("We rebuild by hand this quarter");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await resumeAndPrepare(page);
  const card = page.getByTestId("occurrence-rebuild");
  await expect(card).toContainText("Not started: Oracle is set to observe the baseline. Build it from the Baseline page.");
  await expect(page.getByTestId("ritual-block").filter({ hasText: "Estimate $7.00 at standard depth" })).toBeVisible();
  await card.getByRole("link", { name: "Build the baseline" }).click();
  await expect(page).toHaveURL(/\/baseline\?build=1$/);
  const build = page.getByRole("dialog", { name: "Build the baseline" });
  await expect(build).toContainText("$7.00 estimated · below the $50 approval line");
});

// protects=the rebuild has no ritual cost cap: a build priced $14.00 (above Run rituals' default
// $10 a run, under $50) starts and the owner's Oracle did row names only the estimate; the
// pre-read's Last built row opens that run and reads in the Company time zone;
// fails_when=the old $10 limit holds it back, or Last built links the run list or shows UTC;
// no_claim=P3's over-$50 approval (next test).
test("baseline rebuild: a $14 build starts with no ritual cost cap", async ({ page }) => {
  await withScenario(page, "rebuild-costly");
  await login(page);
  await resumeAndPrepare(page);
  const card = page.getByTestId("occurrence-rebuild");
  await expect(card).toContainText("Oracle started the baseline build · Estimate $14.00 at standard depth. Its proposals wait for your review.");
  const last = page.getByTestId("ritual-block").getByRole("link", { name: /^Last built / });
  await expect(last).toHaveText("Last built 2026-10-20 09:00 PDT");
  await last.click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Build the baseline" })).toBeVisible();
  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Started the baseline rebuild" });
  await expect(did).toContainText("Started the baseline rebuild · Estimate $14.00");
  await expect(did).not.toContainText("limit");
});

// protects=P3: a build over $50 waits for an owner's approval; the card and the Oracle did row say
// so, and once the owner approves on the run the card no longer says it waits;
// fails_when=it is not started, runs unapproved, or the card never says why it waits;
// no_claim=the runtime's segment work (pytest).
test("baseline rebuild: a $70 build waits for the owner's approval", async ({ page }) => {
  await withScenario(page, "rebuild-over-approval");
  await login(page);
  await resumeAndPrepare(page);
  const card = page.getByTestId("occurrence-rebuild");
  await expect(card).toContainText("Waiting for an owner's approval: the estimate $70.00 is over $50");
  const occurrence = page.url();
  await card.getByRole("link", { name: "Open run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Approve $70.00 and start" }).click();
  await expect(page.getByRole("button", { name: "Approve $70.00 and start" })).toHaveCount(0);
  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Started the baseline rebuild" });
  await expect(did).toContainText("Started the baseline rebuild · Estimate $70.00 · Waits for an owner's approval");
  await page.goto(occurrence);
  await expect(page.getByTestId("occurrence-rebuild")).toContainText("Oracle started the baseline build · Estimate $70.00 at standard depth. Its proposals wait for your review.");
});
