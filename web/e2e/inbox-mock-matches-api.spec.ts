import { INBOX_TWO_REVIEWERS_SCENARIO, INBOX_UNKNOWN_PROPOSER_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test } from "./test";

/**
 * inbox-meeting-proposals fix 6: the mock answers as the API does where the Inbox's own
 * proposals reach it. Desktop.
 *
 * Card inbox-approve-again: protects = a required reviewer who approved a roadmap version in
 * one tab and presses Approve again in another tab, still open from before, is told it still
 * waits for the other reviewer, as the API (drafts._approve: theirs is in already, nothing
 * changes). roadmap-decide's review order: the decider approves first (Approve and publish),
 * then the required reviewers; the last approval publishes it ("inbox-two-reviewers": two
 * required reviewers, so one reviewer's approval leaves it waiting); fails_when = the second
 * press says it could not be approved, or either press publishes it.
 *
 * Card inbox-unknown-proposer: protects = a feature suggested by someone whose account is no
 * longer there reads "A teammate suggests it" in the Inbox, as the API sends no name for them;
 * fails_when = it reads "someone suggests it".
 */

test("a required reviewer who presses Approve again in another tab is told it waits for the other reviewer", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.addInitScript((key) => localStorage.setItem(key[0], key[1]), [MOCK_SCENARIO_KEY, INBOX_TWO_REVIEWERS_SCENARIO]);
  await login(page);
  // The owner, who decides the Alerts roadmap, changes it and approves it first: it waits on its two reviewers.
  await page.goto("/simple/roadmap");
  await page.getByTestId("filter-roadmap").selectOption({ label: "Alerts roadmap" });
  const bar = page.locator('[data-testid="timeline-row"][data-item="alert-export"] [data-testid="timeline-bar"]').first();
  await expect(bar).toBeVisible();
  await bar.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("draft-count")).toHaveText("1");
  await page.getByTestId("draft-banner").getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved: Alerts roadmap waits for 2 more reviewers" })).toBeVisible();

  // The reviewer opens it from the Inbox, then opens the same page in a second tab.
  await page.goto("/home");
  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto("/inbox");
  const row = page.getByRole("row").filter({ has: page.getByTestId("simple-approval-context") });
  await row.getByRole("link", { name: /^Open Alerts roadmap version \d+ to approve it$/ }).click();
  await expect(page).toHaveURL(/\/simple\/roadmap\?roadmap=/);
  const other = await context.newPage();
  await other.goto(page.url());
  const approvalThere = other.getByTestId("draft-approval");
  await expect(approvalThere).toContainText(/Alerts roadmap version \d+ is waiting for your approval/);

  // Approved in the first tab: it waits on the other reviewer.
  await page.getByTestId("draft-approval").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved: Alerts roadmap waits for 1 more reviewer")).toBeVisible();

  // Approve again in the second tab, still open from before: the same answer, no error.
  await approvalThere.getByRole("button", { name: "Approve" }).click();
  await expect(other.getByText("Approved: Alerts roadmap waits for 1 more reviewer")).toBeVisible();
  await expect(other.getByText("Alerts roadmap could not be approved")).toHaveCount(0);
  await expect(other.getByText("Approved: Alerts roadmap is published")).toHaveCount(0);
});

test("a feature suggested by someone no longer here reads as a teammate's in the Inbox", async ({ page, context }) => {
  await context.addInitScript((key) => localStorage.setItem(key[0], key[1]), [MOCK_SCENARIO_KEY, INBOX_UNKNOWN_PROPOSER_SCENARIO]);
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Snooze digest" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("A teammate suggests it for the goal Keep alerts quiet");
  await expect(row).not.toContainText("someone");
});
