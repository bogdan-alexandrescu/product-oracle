import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { SLACK_SCENARIO } from "../lib/api/mock/slack";
import { login } from "./helpers";

/*
 * Slack pings through My account, on the mock layer: Slack itself is never called. The API's
 * rules (who is pinged, DM or channel, approvers-only titles, the outbox) are covered by
 * api/tests/test_slack_pings.py.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>.
 */

const panel = (page: Page) => page.getByTestId("slack-pings");
const ping = (page: Page, key: string) => panel(page).getByTestId(`ping-${key}`);
const withScenario = (page: Page) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, SLACK_SCENARIO]);

// protects=the defaults and a member's own choice: "a review or decision is asked of me" and
// "a draft is ready for my review" on, the rest off, and a choice made on My account is kept
// after a reload; fails_when=another default shows, or the choice is lost; no_claim=what
// Slack shows.
test("a member chooses their Slack pings on My account", async ({ page }) => {
  await withScenario(page);
  await login(page);
  await page.goto("/account");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText("direct message");
  await expect(panel(page).getByTestId("slack-pings-off")).toHaveCount(0);
  for (const key of ["review_requested", "draft_ready"]) await expect(ping(page, key)).toBeChecked();
  for (const key of ["comments", "feedback_wanted", "published"]) await expect(ping(page, key)).not.toBeChecked();

  await panel(page).getByText("A draft is ready for my review", { exact: true }).click();
  await expect(ping(page, "draft_ready")).not.toBeChecked();
  await panel(page).getByText("Comments and replies", { exact: true }).click();
  await expect(ping(page, "comments")).toBeChecked();
  // The box flips once the choice is saved, so click it and wait for the new state.
  await ping(page, "review_requested").click();
  await expect(ping(page, "review_requested")).not.toBeChecked();
  await expect(ping(page, "review_requested")).toBeEnabled();

  await page.reload();
  await expect(ping(page, "draft_ready")).not.toBeChecked();
  await expect(ping(page, "comments")).toBeChecked();
  await expect(ping(page, "review_requested")).not.toBeChecked();
});

// protects=a viewer chooses too, and without the company's Slack the panel says an owner
// connects it in Settings › Notifications; fails_when=the panel is hidden from a viewer, or
// the notice is missing; no_claim=the owner's Slack card.
test("without Slack connected a viewer still chooses and is told who connects it", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY]);
  await login(page);
  await page.goto("/account");
  await expect(panel(page).getByTestId("slack-pings-off")).toContainText("an owner connects it in Settings › Notifications");
  await ping(page, "published").click();
  await expect(ping(page, "published")).toBeChecked();
  await page.reload();
  await expect(ping(page, "published")).toBeChecked();
});
