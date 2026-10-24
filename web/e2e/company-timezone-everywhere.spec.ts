import { expect, type Page, test } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * #447: the shared formatters (lib/format.ts) show days and times in the Company time zone,
 * not the browser's. The browser is in New York and the Company in Auckland, so a time at
 * 11:00 UTC or later is the next day there (GMT+13 in October). Driven through the UI on the
 * mock layer.
 */

test.use({ timezoneId: "America/New_York" });

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function setZone(page: Page, zone: string) {
  await page.goto("/settings/company");
  await page.getByLabel("Company time zone").selectOption(zone);
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
}

/** "Oct 22, 9:05 AM GMT+13": an instant in Auckland, as the screens show it. */
const auckland = (at: Date) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Pacific/Auckland", timeZoneName: "short" })
    .format(at)
    .replace(/ at /, ", ");

// protects: the runs list's inspector and a run page show a run's times in the Company
// time zone with its short name, not the browser's.
// fails_when: a run's Created time is New York time (Oct 17, 4:00 AM) or unlabelled.
// no_claim: the API's timestamps.
test("runs list and a run page: run times in the Company time zone", async ({ page }) => {
  await login(page);
  await setZone(page, "Pacific/Auckland");
  await page.getByTestId("nav-runs").click();
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  const row = page.getByTestId("run-row").filter({ hasText: "team-onboarding" });
  // Created 08:00 UTC on Oct 17: 9:00 PM that day in Auckland.
  await row.locator("td").nth(2).click();
  const inspector = page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
  await expect(inspector).toContainText("Oct 17, 9:00 PM GMT+13");
  await expect(inspector).not.toContainText(/EDT|EST/);

  await row.getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  const details = page.getByTestId("run-details");
  await expect(details).toContainText("Oct 17, 9:00 PM GMT+13");
  await expect(details).not.toContainText(/EDT|EST/);
});

// protects: the Inbox shows a retry's deadline in the Company time zone, labelled.
// fails_when: it shows New York's day and time (Oct 20, 4:00 PM) or no zone.
// no_claim: the retry rules (inbox.spec.ts).
test("Inbox: a revoke's retry deadline in the Company time zone", async ({ page }) => {
  await scenario(page, "revoke-failures");
  await login(page);
  await setZone(page, "Pacific/Auckland");
  await page.goto("/inbox");
  const slack = page.getByTestId("inbox-revoke-failures").getByRole("row").filter({ hasText: "Slack" });
  // Retrying until 20:00 UTC on Oct 20: 9:00 AM on Oct 21 in Auckland.
  await expect(slack).toContainText("retrying until Oct 21, 9:00 AM GMT+13");
});

// protects: a document's version history shows import times and days in the Company time
// zone: v1 of Team workspaces, imported 11:00 UTC on Oct 12, is Oct 13 in Auckland.
// fails_when: the version shows Oct 12 (New York) or an unlabelled time.
// no_claim: version numbering.
test("version history: import times and days in the Company time zone", async ({ page }) => {
  await login(page);
  await setZone(page, "Pacific/Auckland");
  await page.goto("/documents/team-workspaces");
  // Imported 11:00 UTC on Oct 12: midnight starting Oct 13 in Auckland (Oct 12 in New York).
  await expect(page.getByRole("row", { name: /^Version 1 / })).toContainText("Oct 13, 12:00 AM GMT+13");
});

// protects: an invite's delivery (its email and access notifications) says when it was last
// tried in the Company time zone, set on Settings › Company.
// fails_when: it keeps the old zone (Los Angeles) or the browser's.
// no_claim: the retry itself (members-invite-last-tried.spec.ts).
test("Notifications: an invite's Last tried in the Company time zone", async ({ page }) => {
  await scenario(page, "iap-pending");
  await login(page);
  await setZone(page, "Pacific/Auckland");
  const at = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60 * 60_000);
  await page.clock.setFixedTime(at);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill("pat+tag@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  const row = page.getByTestId("invite-row").filter({ hasText: "pat+tag@example.com" });
  await expect(row.getByTestId("invite-access-detail")).toContainText(`Last tried ${auckland(at)}`);
});
