import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login, signOut } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * Simple S8 (#723): ending a review meeting (the end screen, direction A), driven through
 * the UI on the mock's invented data (./lib/api/mock/simple-meetings.ts), desktop and
 * phone, light and dark; Slack and email set through the mock's MOCK_MEETINGS_KEY.
 *
 * Card meeting-end-minutes: protects = End meeting shows Oracle's minutes at once (the
 * summary names the decisions; open questions only from the meeting's record), the decisions
 * taken and what still waits on whom; the minutes are edited before sending (an action
 * item with its owner and date) and the edit is what is sent; on a phone the screen
 * stacks minutes, waits, delivery; fails_when = the minutes are missing or not editable,
 * or the edit is lost; no_claim = the meeting_minutes job's wording (api/tests).
 *
 * Card meeting-end-delivery: protects = Decisions page and Each attendee's Inbox are always
 * on (checked, disabled); "Email the attendees" is optional and disabled with "Email isn't
 * set up" when email is not available; Slack reads "Not connected" unless connected, then
 * "Post to #product-reviews"; Send shows "Sent" with each delivery's status (not picked,
 * on its way, on its way to the channel) and links the Decisions page; fails_when = a choice is not
 * sent, a status is missing, or Slack is offered while not connected; no_claim = the email
 * and Slack sending themselves (the API's outbox).
 */

/** Signs in as someone else: the account menu lives in the desktop rail, so switch people
 * there, then back to the test's width. */
async function switchTo(page: Page, email: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

const delivery = (page: Page) => page.getByRole("region", { name: "Delivery" });

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

async function endOne(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await page.getByRole("button", { name: "Start review" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "3 Decisions" }).click();
  await page.getByRole("textbox", { name: "Comment" }).fill("Ship the checklist first");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Comment: Ship the checklist first");
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
  await page.getByRole("button", { name: "Move Setup checklist to Next" }).click();
  await expect(page.getByRole("region", { name: "All decisions" })).toContainText("Moved Setup checklist");
  await page.getByRole("button", { name: "End meeting" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("the minutes are edited and sent to the Decisions page and the Inbox only", async ({ page }) => {
        await endOne(page);
        const minutes = page.getByRole("region", { name: "Minutes" });
        await expect(minutes.getByLabel("Summary")).toHaveValue("Comment: Ship the checklist first; Moved Setup checklist.");
        await expect(minutes.getByLabel("Decisions taken")).toContainText("Moved Setup checklist");
        await expect(page.getByRole("region", { name: "What still waits" })).toContainText("Guided setup: the working draft is not approved yet");
        await minutes.getByLabel("Summary").fill("We moved the checklist to Next and keep it first.");
        await minutes.getByRole("button", { name: "Add action item" }).click();
        await minutes.getByLabel("Action item 1", { exact: true }).fill("Write the checklist copy");
        await minutes.getByLabel("Owner of action item 1").selectOption({ label: "Approver" });
        await minutes.getByLabel("Due date of action item 1").fill("2026-11-02");
        await minutes.getByRole("button", { name: "Save minutes" }).click();
        await expect(minutes.getByRole("button", { name: "Save minutes" })).toBeDisabled();
        const d = delivery(page);
        await expect(d.getByRole("checkbox", { name: "Decisions page" })).toBeChecked();
        await expect(d.getByRole("checkbox", { name: "Decisions page" })).toBeDisabled();
        await expect(d.getByRole("checkbox", { name: "Each attendee's Inbox" })).toBeChecked();
        await expect(d.getByRole("checkbox", { name: "Each attendee's Inbox" })).toBeDisabled();
        await expect(d.getByRole("checkbox", { name: "Email the attendees" })).not.toBeChecked();
        await expect(d).toContainText("Slack is not connected yet.");
        await expect(d.getByRole("link", { name: "Connect Slack" })).toBeVisible();
        await expect(d.getByRole("checkbox", { name: /Post to Slack/ })).toBeDisabled();
        if (phone) {
          const m = (await minutes.boundingBox())!;
          const w = (await page.getByRole("region", { name: "What still waits" }).boundingBox())!;
          const s = (await d.boundingBox())!;
          expect(w.y).toBeGreaterThan(m.y + m.height - 1);
          expect(s.y).toBeGreaterThan(w.y + w.height - 1);
        }
        await d.getByRole("button", { name: "Send" }).click();
        const sent = page.getByRole("status", { name: "Sent" });
        await expect(sent).toContainText("Decisions page · posted");
        await expect(sent).toContainText("Each attendee's Inbox · posted");
        await expect(sent).toContainText("Email · not sent (not picked)");
        await expect(sent).toContainText("Slack · not posted (not picked)");
        await expect(page.getByTestId("minutes-summary")).toHaveText("We moved the checklist to Next and keep it first.");
        await expect(page.getByRole("region", { name: "Minutes" })).toContainText("Write the checklist copy · Approver · by Mon Nov 2");
        await sent.getByRole("link", { name: "Open the Decisions page" }).click();
        await expect(page).toHaveURL(/\/simple\/decisions\?meeting=/);
        const group = page.getByRole("region", { name: "Review: Guided setup" });
        await expect(group).toContainText("We moved the checklist to Next and keep it first.");
        await expect(group).toContainText("Write the checklist copy · Approver · by Mon Nov 2");
        await expect(page.getByRole("region", { name: "Outside meetings" })).toHaveCount(0);
      });

      test("the attendees are emailed when chosen", async ({ page }) => {
        await endOne(page);
        await delivery(page).getByRole("checkbox", { name: "Email the attendees" }).check();
        await delivery(page).getByRole("button", { name: "Send" }).click();
        await expect(page.getByRole("status", { name: "Sent" })).toContainText("Email · on its way");
        await page.goto("/simple/meetings");
        await expect(page.getByRole("region", { name: "Past" })).toContainText("Comment: Ship the checklist first; Moved Setup checklist.");
        await switchTo(page, "approver@example.com");
        await page.goto("/simple/decisions");
        await expect(page.getByRole("region", { name: "Review: Guided setup" })).toContainText("Moved Setup checklist");
      });
    });
  }
}

test.describe("Slack connected", () => {
  test.beforeEach(async ({ context }) => flags(context, "slack"));
  for (const phone of [false, true]) {
    test(`minutes are posted to the notifications channel (${phone ? "phone" : "desktop"})`, async ({ page }) => {
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1366, height: 820 });
      await endOne(page);
      const d = delivery(page);
      await expect(d).not.toContainText("not connected");
      await d.getByRole("checkbox", { name: "Post to #product-reviews" }).check();
      await d.getByRole("button", { name: "Send" }).click();
      await expect(page.getByRole("status", { name: "Sent" })).toContainText("Slack · on its way to #product-reviews");
    });
  }
});

test.describe("email not set up", () => {
  test.beforeEach(async ({ context }) => flags(context, "no-email"));
  test("email cannot be chosen", async ({ page }) => {
    await endOne(page);
    const d = delivery(page);
    await expect(d).toContainText("Email isn't set up");
    await expect(d.getByRole("checkbox", { name: "Email the attendees" })).toBeDisabled();
  });
});
