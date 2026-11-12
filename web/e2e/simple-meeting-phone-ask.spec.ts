import { expect, test, type Locator, type Page } from "./test";

import { ADMIN } from "./helpers";

/*
 * meeting-phone-ask (#1016): on a phone the meeting screen covers the app's header, so its own
 * header carries the header's Ask Oracle button. Phone (390x844) against the mock (invented data).
 *
 * Card: protects = on a phone, from a live meeting's screen, a person opens Ask Oracle, asks,
 * and sees Oracle's private reply in the Ask chat (not in the meeting chat); the button shows
 * only on a phone; fails_when = the meeting screen has no way to open Ask on a phone; no_claim =
 * the answer's words.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const ASK = "Which part of this setup is still open?";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple/prds/guided-setup");
  await tap(page.getByRole("button", { name: "Start a review meeting" }));
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await expect(page).toHaveURL(/\/simple\/meetings\/[^/]+$/);
}

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("a meeting's screen opens Ask Oracle on a phone, and Oracle replies there", async ({ page }) => {
    test.setTimeout(90_000);
    await startReview(page);

    const head = page.getByTestId("meeting-screen").locator('header[aria-label="Meeting"]');
    const open = head.getByRole("button", { name: "Ask Oracle" });
    await expect(open).toBeVisible();
    await expect(open).toHaveText("Ask");
    await tap(open);

    const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
    await expect(sheet).toBeVisible();
    const ask = sheet.getByTestId("ask-chat");
    await expect(ask).toBeVisible();
    await ask.getByLabel("Message Oracle").fill(ASK);
    await tap(ask.getByRole("button", { name: "Send" }));
    await expect(ask.getByTestId("chat-message").filter({ hasText: ASK })).toHaveCount(1);
    await expect(ask.getByTestId("ask-answer").last()).toBeVisible();

    // Closing it leaves the meeting as it was; the question stays out of the meeting's chat.
    await tap(sheet.getByRole("button", { name: "Close Ask Oracle" }).first());
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("meeting-chat")).not.toContainText(ASK);

    // On a desktop-wide window the rail's Ask Oracle serves; the meeting header's button hides.
    await page.setViewportSize(DESKTOP);
    await expect(open).toBeHidden();
  });
});
