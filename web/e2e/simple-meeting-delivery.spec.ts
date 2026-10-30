import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { login } from "./helpers";
import { expect, test, type BrowserContext, type Page } from "./test";

/**
 * dod-delivery: how a meeting's minutes went out by email and to Slack, in plain words, and
 * Retry, on the Decisions page and on the meeting, driven through the UI on the mock's
 * invented data ("delivery-failed": the past review's email to the approver and its Slack
 * post failed after their three tries).
 *
 * Card delivery-words: protects = the Decisions page's meeting and the meeting's Delivery say
 * "Emailed 2 of 3 attendees; <name>'s didn't go through · Retry" and "Couldn't post to Slack ·
 * Retry"; Retry (the owner, who ended it) sends the email again ("Emailed all 3 attendees")
 * and posts ("Posted to #product-reviews"); fails_when = a partial failure reads "sent", a
 * failure shows no Retry, Retry does not send again, or raw statuses or errors show;
 * no_claim = the API's tries and backoff (api/tests/test_simple_meeting_delivery.py).
 *
 * Card delivery-retry-rights: protects = an attendee who did not end the meeting and is not an
 * owner reads the failure with "whoever ended the meeting or an owner can retry" and no Retry;
 * fails_when = Retry is offered to them; no_claim = the API's 403 (its tests).
 */

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

const group = (page: Page) => page.getByRole("region", { name: "Review: Usage alerts" });

for (const phone of [false, true]) {
  test.describe(`minutes delivery (${phone ? "phone" : "desktop"})`, () => {
    test.beforeEach(async ({ context, page }) => {
      await flags(context, "delivery-failed");
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    });

    test("what failed is said, and Retry sends it", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      const g = group(page);
      const email = g.getByTestId("delivery-email");
      const slack = g.getByTestId("delivery-slack");
      await expect(email).toHaveText(/^Emailed 2 of 3 attendees; \S+'s didn't go through · Retry$/);
      await expect(slack).toHaveText("Couldn't post to Slack · Retry");
      await expect(g).not.toContainText(/failed|retrying|queued/);
      await email.getByRole("button", { name: "Retry" }).click();
      await expect(email).toHaveText("Emailed all 3 attendees");
      await expect(slack).toHaveText("Couldn't post to Slack · Retry");
      // The meeting's own Delivery says the same, and its Retry posts to Slack.
      await g.getByRole("link", { name: "Review: Usage alerts" }).click();
      const sent = page.getByRole("status", { name: "Sent" });
      await expect(sent.getByTestId("delivery-email")).toHaveText("Emailed all 3 attendees");
      const post = sent.getByTestId("delivery-slack");
      await expect(post).toHaveText("Couldn't post to Slack · Retry");
      const retry = post.getByRole("button", { name: "Retry" });
      if (phone) expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(43);
      await retry.click();
      await expect(post).toHaveText("Posted to #product-reviews");
    });

    test("someone else reads who may retry", async ({ page }) => {
      await login(page, "approver@example.com");
      await page.goto("/simple/decisions");
      const g = group(page);
      await expect(g.getByTestId("delivery-email")).toHaveText(
        /^Emailed 2 of 3 attendees; \S+'s didn't go through · whoever ended the meeting or an owner can retry$/,
      );
      await expect(g.getByRole("button", { name: "Retry" })).toHaveCount(0);
    });
  });
}

/**
 * Card delivery-legacy-failed (dod-delivery review): protects = a meeting whose email failed
 * before each attendee carried a status ("delivery-legacy-failed": no attendee named) reads
 * "Couldn't email the attendees" with no Retry (nothing named is left to retry); fails_when =
 * it reads "Emailing the attendees…" as if still on its way; no_claim = the API's stored
 * count (api/tests/test_simple_meeting_delivery.py).
 */
for (const phone of [false, true]) {
  test(`an old failed email reads as failed (${phone ? "phone" : "desktop"})`, async ({ context, page }) => {
    await flags(context, "delivery-legacy-failed");
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await login(page);
    await page.goto("/simple/decisions");
    const g = group(page);
    await expect(g.getByTestId("delivery-email")).toHaveText("Couldn't email the attendees");
    await expect(g.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
}
