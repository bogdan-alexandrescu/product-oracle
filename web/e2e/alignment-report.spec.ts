import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * F6 Weekly alignment report, driven through the UI as an owner would, on the mock layer.
 * A mock transport stands in for Slack (lib/api/mock/reports.ts); the real Slack API is
 * never called. The "alignment-report" scenario seeds two weekly reports (week of Oct 5,
 * read, whose Slack post failed; week of Oct 12, unread, posted to #plan) and Oracle's Slack
 * install; the default scenario has neither.
 */

const withReports = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "alignment-report"), MOCK_SCENARIO_KEY);
const tab = (page: Page, name: string) => page.getByTestId("inbox-state-tabs").getByRole("tab", { name: new RegExp(`^${name}`) });

async function expectNoSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("Inbox: the weekly report row opens the report, and moves to Done", async ({ page }) => {
  // protects=AC12, the owners' Report row (C1e); fails_when=the row is missing, not counted,
  // Open does not show the report, or the row stays New once opened; no_claim=Slack delivery.
  await withReports(page);
  await login(page);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-reports").locator("tr[data-row]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Weekly alignment · week of Oct 12");
  await expect(row).toContainText("1 at risk · 1 slip");
  const badge = page.getByTestId("nav-inbox-badge");
  const before = Number(await badge.innerText());
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
  await expect(badge).toHaveText(String(before - 1));

  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-tab-new").getByTestId("inbox-reports")).toHaveCount(0);
  await tab(page, "Done").click();
  await expect(page.getByTestId("inbox-tab-done").getByTestId("inbox-reports").locator("tr[data-row]").first()).toContainText(
    "Weekly alignment · week of Oct 12",
  );
});

test("Inbox: a report Slack refused shows with Retry, which posts it", async ({ page }) => {
  // protects=§4 delivery failures in owners' Inbox; fails_when=the failure is not shown with
  // Slack's error, or Retry leaves it there; no_claim=the 24-hour backoff (API tests).
  await withReports(page);
  await login(page);
  await page.goto("/inbox");
  const failure = page.getByTestId("inbox-report-failures").locator("tr[data-row]");
  await expect(failure).toContainText("Report not posted to Slack · channel_not_found");
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("inbox-report-failures")).toHaveCount(0);
});

test("report page: the headline, a panel per track, needs attention linking to the Plan, and the Slack post", async ({ page }) => {
  // protects=AC13, the report page (§3); fails_when=the headline, a track panel, the health
  // 'At risk, was On track', the Plan links or 'Posted to #plan' is missing, or Previous /
  // Next do not move between reports; no_claim=F1's Plan screen behind the links.
  await withReports(page);
  await login(page);
  await page.goto("/plan/reports");
  await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
  await expect(page.getByTestId("report-headline").filter({ visible: true })).toHaveText(
    // fix4 qa-plan-1: read off the tracks the Plan reads (Usage dashboard is its one Now item with no issue).
    "1 of 2 tracks at risk; 1 date slipping as of now; 1 Now item has no issue.",
  );
  const tracks = page.getByTestId("report-track").filter({ visible: true });
  await expect(tracks).toHaveCount(2);
  const first = tracks.first();
  await expect(first.getByRole("heading", { name: "Usage alerts PRD" })).toBeVisible();
  await expect(first.getByTestId("track-health")).toHaveText("At risk, was On track");
  const attention = first.getByTestId("needs-attention");
  await expect(attention).toContainText("as of now");
  // qa-plan-3: ENG-405 is the Daily alert digest email's issue, named as on the Plan.
  const link = attention.getByRole("link", { name: "Daily alert digest email" });
  await expect(link).toHaveAttribute("href", "/plan?item=usage-alerts:alert-digest");
  await expect(first).toContainText("ENG-413");
  await expect(first).toContainText("The team re-estimated");
  // Checkout redesign has a track and no approved roadmap yet, as on the Plan.
  await expect(tracks.nth(1).getByTestId("track-health")).toHaveText("No roadmap");
  await expect(page.getByTestId("report-slack").filter({ visible: true })).toContainText("Posted to #plan on Oct 19");

  // Previous and Next report.
  await page.getByRole("link", { name: "Previous report" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 5");
  await expect(page.getByTestId("report-slack").filter({ visible: true })).toContainText("channel_not_found");
  await expect(page.getByRole("link", { name: "Previous report" })).toHaveCount(0);
  await page.getByRole("link", { name: "Next report" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");

  // Printable: the print stylesheet drops the rail.
  await expect(page.getByTestId("report-rail").filter({ visible: true })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("report-rail").filter({ visible: true })).toBeHidden();
  await expect(tracks.first()).toBeVisible();
});

test("the Plan header's Alignment report opens the latest report", async ({ page }) => {
  // protects=AC14; fails_when=the header button is missing or opens another report;
  // no_claim=F1's Plan screen (the button sits on the Roadmap page, Plan's home until F1).
  await withReports(page);
  await login(page);
  await page.goto("/roadmap");
  await page.getByRole("link", { name: "Latest report" }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+\?latest$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
});

test("the Plan header's Alignment report opens the latest report when clicked before the reports load", async ({ page }) => {
  // protects=AC14 on a slow load; fails_when=a click before the latest report has loaded opens
  // the list (the button pointed at /plan/reports until it knew the id); no_claim=the list.
  await withReports(page);
  await page.addInitScript(([key, path]) => localStorage.setItem(key, path), [MOCK_SLOW_KEY, "/v1/alignment-reports"]);
  await login(page);
  await page.goto("/roadmap");
  await page.getByRole("link", { name: "Latest report" }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+\?latest$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
});

test("Settings › Notifications: connect Slack, pick a channel, send a test message, disconnect", async ({ page }) => {
  // protects=AC15, the company Slack install (§4); fails_when=Connect does not come back
  // connected, a private channel the bot was invited to is not offered, the channel is not kept, the test message does not say Sent, or Disconnect
  // clears without a confirmation; no_claim=Slack's OAuth screen (mocked return).
  await login(page);
  await page.goto("/settings");
  await page.getByTestId("settings-nav").getByRole("link", { name: "Notifications" }).click();
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  await page.getByRole("button", { name: "Connect Oracle to Slack" }).click();
  await expect(page.getByText("Slack is connected for notifications.")).toBeVisible();
  const slack = page.getByTestId("slack-notifications");
  await expect(slack).toContainText("Example Co");
  await expect(slack.getByRole("button", { name: "Connect Oracle to Slack" })).toHaveCount(0);

  await slack.getByLabel("Channel").selectOption({ label: "#plan" });
  await slack.getByRole("button", { name: "Save channel" }).click();
  await expect(slack.getByText("Reports post to #plan.")).toBeVisible();
  await slack.getByRole("button", { name: "Send test message" }).click();
  await expect(slack.getByText("Sent")).toBeVisible();

  // A private channel the bot was invited to is in the picker too (groups:read).
  await slack.getByLabel("Channel").selectOption({ label: "#leads (private)" });
  await slack.getByRole("button", { name: "Save channel" }).click();
  await expect(slack.getByText("Reports post to #leads.")).toBeVisible();
  await slack.getByRole("button", { name: "Send test message" }).click();
  await expect(slack.getByText("Sent")).toBeVisible();

  // The schedule: Monday 08:00 Pacific by default; owners change it.
  const schedule = page.getByTestId("report-schedule");
  await expect(schedule.getByLabel("Day")).toHaveValue("mon");
  await expect(schedule.getByLabel("Time", { exact: true })).toHaveValue("08:00");
  await schedule.getByLabel("Day").selectOption("tue");
  await schedule.getByRole("button", { name: "Save schedule" }).click();
  await expect(schedule.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("report-schedule").getByLabel("Day")).toHaveValue("tue");

  await page.getByTestId("slack-notifications").getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("revokes");
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect Oracle to Slack" })).toBeVisible();
  await expect(page.getByTestId("slack-notifications")).not.toContainText("Example Co");
});

test("Generate now makes an on-demand report, posted only with Post to Slack ticked", async ({ page }) => {
  // protects=AC16; fails_when=Generate now posts without the tick, or not with it;
  // no_claim=the weekly schedule.
  await withReports(page);
  await login(page);
  await page.goto("/plan/reports");
  const rows = page.getByTestId("reports-table").locator("tr[data-row]");
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Generate now" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate a report now" });
  await expect(dialog.getByLabel("Post to Slack")).not.toBeChecked();
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Alignment so far · week of /);
  await expect(page.getByTestId("report-slack").filter({ visible: true })).toHaveText("Not posted to Slack.");

  await page.goto("/plan/reports");
  await expect(rows).toHaveCount(3);
  await page.getByRole("button", { name: "Generate now" }).click();
  await page.getByRole("dialog", { name: "Generate a report now" }).getByLabel("Post to Slack").check();
  await page.getByRole("dialog", { name: "Generate a report now" }).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("report-slack").filter({ visible: true })).toContainText("Posted to #plan");
});

test("phone and themes: the report page and settings fit 390 px, light and dark without console errors", async ({ page }) => {
  // protects=AC17; fails_when=a page scrolls sideways at 390 px, panels do not stack, or a
  // theme logs a console error; no_claim=pixel comparison.
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await withReports(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("oracle-theme", t), theme);
    await page.goto("/plan/reports");
    await expect(page.getByTestId("reports-table")).toBeVisible();
    await expectNoSideScroll(page);
    await page.getByTestId("reports-table").getByRole("link", { name: /week of Oct 12/ }).first().click();
    const tracks = page.getByTestId("report-track").filter({ visible: true });
    await expect(tracks).toHaveCount(2);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const [a, b] = [await tracks.nth(0).boundingBox(), await tracks.nth(1).boundingBox()];
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
    await expectNoSideScroll(page);
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("slack-notifications")).toBeVisible();
    await expectNoSideScroll(page);
  }
  expect(errors).toEqual([]);
});
