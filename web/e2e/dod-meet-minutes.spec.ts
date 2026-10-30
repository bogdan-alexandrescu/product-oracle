import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * Simple Definition of Done, item 4 (docs/simple-dod-actions-meet.md): where a meeting's
 * minutes land once its owner ends it and sends them, desktop (1440x900) and phone
 * (390x844), on the mock's invented PRD "Guided setup".
 *
 * Card dod-meet-minutes-inbox: protects = an attendee (Approver) finds the sent minutes in
 * their own Inbox as a "Meeting minutes" row naming the meeting and its decisions, shown and
 * not counted as waiting; Open leads to the Decisions page by that meeting, where the
 * minutes' summary reads; fails_when = the Inbox has no row for the minutes (the API sends
 * `simple_minutes`, the page drew none) or Open goes elsewhere; no_claim = email and Slack.
 *
 * Card dod-meet-minutes-views: protects = the minutes' summary reads beside the meeting's
 * decisions on the Decisions page's List and By meeting; the Board holds the PRDs' questions
 * only; fails_when = a view drops the minutes; no_claim = the Board's columns
 * (qa2-simple-decisions.spec.ts).
 *
 * Card dod-meet-minutes-age: protects = the minutes' Inbox row is aged from when they were
 * sent, the same moment that makes it new; fails_when = minutes sent three hours after the
 * meeting ended read "3h" in the Inbox; no_claim = the row's new/open state.
 *
 * Card dod-meet-end-no-email: protects = whoever ends the meeting cannot pick email when
 * email is not set up, on a phone too; fails_when = the box is enabled; no_claim = Slack.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1440, height: 900 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

const delivery = (page: Page) => page.getByRole("region", { name: "Delivery" });

/** The owner starts Guided setup's review, moves an item and ends the meeting. */
async function endOne(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await expect(sheet.getByRole("checkbox", { name: "Approver" })).toBeChecked();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await tap(page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }));
  await tap(page.getByRole("button", { name: "Move Setup checklist to Next" }));
  await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Moved Setup checklist");
  await tap(page.getByRole("button", { name: "End meeting" }));
  await tap(page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }));
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // card: dod-meet-minutes-inbox
    test(`an attendee's Inbox has the minutes; Open reads them on the Decisions page (${where})`, async ({ page }) => {
      await endOne(page);
      await page.getByRole("region", { name: "Minutes" }).getByLabel("Summary").fill("We moved the checklist to Next.");
      await tap(delivery(page).getByRole("button", { name: "Send" }));
      await expect(page.getByRole("status", { name: "Sent" })).toContainText("Each attendee's Inbox · posted");

      await page.goto("/simple/meetings");
      await switchTo(page, "approver@example.com");
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ hasText: "Review: Guided setup" });
      await expect(row).toContainText("Meeting minutes");
      await expect(row).toContainText("1 decision");
      await tap(row.getByRole("link", { name: "Open" }));
      await expect(page).toHaveURL(/\/simple\/decisions\?meeting=/);
      await expect(page.getByRole("region", { name: "Review: Guided setup" })).toContainText("We moved the checklist to Next.");
    });

    // card: dod-meet-minutes-age
    test(`minutes sent hours after the meeting read as just sent in the Inbox (${where})`, async ({ page }) => {
      await endOne(page);
      await page.clock.fastForward("03:00:00");
      await tap(delivery(page).getByRole("button", { name: "Send" }));
      await expect(page.getByRole("status", { name: "Sent" })).toBeVisible();
      await page.goto("/simple/meetings");
      await switchTo(page, "approver@example.com");
      await page.goto("/inbox");
      const row = page.getByRole("row").filter({ hasText: "Review: Guided setup" });
      await expect(row).toContainText("Meeting minutes");
      await expect(row.getByText(/^(now|\d{1,2}m)$/)).toBeVisible();
      await expect(row.getByText("3h", { exact: true })).toHaveCount(0);
    });

    // card: dod-meet-minutes-views
    test(`the minutes read on the Decisions page's List and By meeting (${where})`, async ({ page }) => {
      await endOne(page);
      await page.getByRole("region", { name: "Minutes" }).getByLabel("Summary").fill("We moved the checklist to Next.");
      await tap(delivery(page).getByRole("button", { name: "Send" }));
      await expect(page.getByRole("status", { name: "Sent" })).toBeVisible();
      await page.goto("/simple/decisions");
      const group = page.getByRole("region", { name: "Review: Guided setup" });
      await expect(page.getByTestId("decisions-view-list")).toHaveAttribute("aria-pressed", "true");
      await expect(group).toContainText("We moved the checklist to Next.");
      await expect(group).toContainText("Moved Setup checklist");
      await tap(page.getByTestId("decisions-view-meetings"));
      await expect(group).toContainText("We moved the checklist to Next.");
      await expect(group).toContainText("Moved Setup checklist");
      await tap(page.getByTestId("decisions-view-board"));
      await expect(group).toHaveCount(0);
    });
  });

  // card: dod-meet-end-no-email
  test(`email cannot be picked when it is not set up (${where})`, async ({ page, context }) => {
    await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, "no-email"] as const);
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await endOne(page);
    await expect(delivery(page)).toContainText("Email isn't set up");
    await expect(delivery(page).getByRole("checkbox", { name: "Email the attendees" })).toBeDisabled();
  });
}
