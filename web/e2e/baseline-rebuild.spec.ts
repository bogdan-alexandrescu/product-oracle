import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * The scheduled Baseline rebuild (oracle.rituals.rebuild): a built-in ritual, off by default,
 * that starts B1's Build the baseline run on its cadence under H11 "Keep the baseline current".
 * Driven through the UI on the mock layer (lib/api/mock/rituals.ts): an owner turns it on and
 * prepares the next occurrence now, as the ticker would at the first Monday 09:00. Made-up
 * people only. Each test's card: protects=...; fails_when=...; no_claim=...
 */

const ritualRow = (page: Page, title: string) => page.getByTestId("ritual-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("ritual-inspector").filter({ visible: true });

async function openRituals(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
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
  await expect(page.getByText("Build the baseline").first()).toBeVisible();
  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Started the baseline rebuild" });
  await expect(did).toContainText("Started the baseline rebuild · Estimate $7.00, within your $10 limit");
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
  await expect(build).toContainText("Estimate $7.00");
});

// protects=above Run rituals' cost limit nothing starts and the card names both figures;
// fails_when=a build starts over the limit; no_claim=P3's over-$50 approval.
test("baseline rebuild: above the $5 cost limit Oracle starts nothing and says why", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await page.getByTestId("autonomy-row-rituals").getByRole("group").getByRole("button", { name: "Act", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Change Run rituals" });
  await sheet.getByLabel("Highest cost a run (USD)").fill("5");
  await sheet.getByLabel("Why").fill("Keep ritual runs small");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await resumeAndPrepare(page);
  await expect(page.getByTestId("occurrence-rebuild")).toContainText("Not started: the estimate $7.00 is above your $5 limit a run.");
  await expect(page.getByTestId("occurrence-rebuild").getByRole("link", { name: "Build the baseline" })).toBeVisible();
});
