import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * walkc-meeting round 2: the meeting's steps after a chat card, on the mock's invented PRD
 * "Guided setup", desktop, as the company's owner (Avery Stone) and Theo Brandt.
 *
 * Card roadmap-follows-chat (5d): protects = with the Roadmap step open, a move applied
 * from the meeting's chat shows on the step at once (Welcome video reads Now), without
 * opening the page again; fails_when = the step keeps the old roadmap (Later) until a
 * reload; no_claim = the roadmap's own Move buttons (qa4-simple-decide-meeting.spec.ts).
 *
 * Card declined-card-says-so (5e): protects = a move Theo proposes from the meeting's chat
 * and the owner declines on the Decisions step is recorded as "Declined Theo Brandt's
 * proposal: move Welcome video to Now", and Theo's card then reads "Declined by Avery
 * Stone: nothing changed", even after the page is opened again; fails_when = the decision
 * reads "Moved Welcome video to Now" or the card still says "Proposed to ..."; no_claim =
 * accepted proposals (api tests/test_walkc_meeting.py covers the API's words).
 */

test.use({ viewport: { width: 1366, height: 820 } });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });
const decisions = (page: Page) => page.getByRole("region", { name: "Decisions in this meeting" });

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function switchTo(page: Page, email: string) {
  // From a fresh page: the full-screen meeting covers the rail's account menu.
  await page.goto("/simple");
  await signOut(page);
  await login(page, email);
}

/** Says `line` in the meeting's chat and returns the card on Welcome video. */
async function cardFor(page: Page, line: string): Promise<Locator> {
  const chat = page.getByTestId("meeting-chat");
  await chat.getByRole("textbox", { name: "Message Oracle" }).fill(line);
  await tap(chat.getByRole("button", { name: "Send" }));
  const card = chat.getByTestId("chat-card").filter({ hasText: "Welcome video" }).last();
  await expect(card).toBeVisible();
  const preview = card.getByRole("button", { name: "Preview" });
  if (await preview.isVisible()) await tap(preview);
  return card;
}

test("5d: a move applied from the chat shows on the open Roadmap step at once", async ({ page }) => {
  await startReview(page);
  await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
  const row = page.getByRole("region", { name: "Roadmap slice" }).getByRole("listitem").filter({ hasText: "Welcome video" });
  await expect(row).toContainText("Welcome video · Later");
  const card = await cardFor(page, "move Welcome video to Now");
  await tap(card.getByRole("button", { name: "Apply", exact: true }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");
  // The step follows the chat without opening the page again.
  await expect(row).toContainText("Welcome video · Now");
  await expect(row.getByRole("button", { name: "Move Welcome video to Later" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Move Welcome video to Now" })).toHaveCount(0);
});

test("5e: a chat proposal declined in the meeting says declined, on the card and in the decision", async ({ page }) => {
  await startReview(page);
  const url = page.url();
  // Theo proposes the move from the meeting's chat.
  await switchTo(page, "commenter@example.com");
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  const card = await cardFor(page, "move Welcome video to Now");
  await tap(card.getByRole("button", { name: "Propose" }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to");

  // The owner declines it on the Decisions step.
  await switchTo(page, "admin@example.com");
  await page.goto(url);
  await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
  const pending = page.getByRole("region", { name: "Pending proposals" }).getByRole("listitem").filter({ hasText: "Welcome video" });
  await tap(pending.getByRole("button", { name: "Decline" }));
  await expect(pending).toHaveCount(0);
  const decided = decisions(page).getByTestId("meeting-decision").filter({ hasText: "Welcome video" });
  await expect(decided).toContainText("Declined Theo Brandt's proposal: move Welcome video to Now");
  await expect(decisions(page)).not.toContainText("Moved Welcome video");

  // Theo's card says it was declined, and by whom.
  await switchTo(page, "commenter@example.com");
  await page.goto(url);
  const again = page.getByTestId("meeting-chat").getByTestId("chat-card").filter({ hasText: "Welcome video" }).last();
  await expect(again.getByTestId("chat-card-outcome")).toContainText("Declined by Avery Stone: nothing changed");
  await expect(again.getByTestId("chat-card-outcome")).not.toContainText("Proposed to");
});
