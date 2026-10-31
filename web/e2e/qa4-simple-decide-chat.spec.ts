import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * QA pass 4, simple-decide lane: the meeting chat, driven through the UI on the mock's data.
 *
 * protects = qa4-simple-decide-1 (a viewer reads an applied card with no Undo), -4 (an ended
 * meeting's chat is read-only: its lines show, no box), -5 (the rule's plain hint: who applies,
 * who proposes), -29 (a change card says its item once; Oracle's line ends as a sentence), -30
 * (a viewer's hint follows the rule in force).
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });
const chat = (page: Page) => page.getByTestId("meeting-chat");

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function meetings(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
}

/** The owner starts a review of Guided setup with `also` attending (the default rule). */
async function startReview(page: Page, also: string[] = ["Commenter"]) {
  await meetings(page);
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = sheet(page);
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  for (const who of also) await s.getByRole("checkbox", { name: who, exact: true }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

/** From the meeting screen, its chat on its own page; the page's address. */
async function chatPage(page: Page): Promise<string> {
  await tap(page.getByRole("link", { name: "Open chat on its own page" }));
  await expect(page).toHaveURL(/\/chat/);
  await expect(chat(page)).toBeVisible();
  return page.url();
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

async function switchTo(page: Page, email: string) {
  // From a fresh page: the full-screen meeting covers the rail's account menu.
  await page.goto("/simple");
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 } });

    test(`qa4-simple-decide-1: a viewer reads the owner's applied note with no Undo (${where})`, async ({ page }) => {
      // fails_when: the viewer's copy of an applied card offers "Undo this change"
      await startReview(page, ["Viewer"]);
      const url = await chatPage(page);
      await say(chat(page), "note: keep reminders quiet on weekends");
      const card = chat(page).getByTestId("chat-card").filter({ hasText: "keep reminders quiet on weekends" }).last();
      await tap(card.getByRole("button", { name: "Apply", exact: true }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");
      await expect(card.getByRole("button", { name: "Undo this change" })).toBeVisible();

      await switchTo(page, "viewer@example.com");
      await page.goto(url);
      const seen = chat(page).getByTestId("chat-card").filter({ hasText: "keep reminders quiet on weekends" }).last();
      await expect(seen.getByTestId("chat-card-outcome")).toContainText("Applied by");
      await expect(seen.getByTestId("chat-card-outcome")).not.toContainText("Applied by you");
      await expect(seen.getByRole("button", { name: "Undo this change" })).toHaveCount(0);
    });

    test(`qa4-simple-decide-4: an ended meeting's chat shows its lines and takes no new ones (${where})`, async ({ page }) => {
      // fails_when: the ended meeting's chat is empty, or still has a message box and Send
      await meetings(page);
      await tap(page.getByRole("region", { name: "Past" }).getByRole("link", { name: "Review: Usage alerts" }));
      await expect(page).toHaveURL(/\/simple\/meetings\/[0-9a-f-]{36}/);
      await page.goto(`${new URL(page.url()).pathname}/chat`);
      const box = chat(page);
      await expect(box.getByTestId("chat-message-body").filter({ hasText: "note: keep quiet hours on by default" })).toBeVisible();
      await expect(box.getByTestId("chat-ended")).toHaveText("This meeting has ended; ask Oracle instead.");
      await expect(box.getByRole("textbox", { name: "Message Oracle" })).toHaveCount(0);
      await expect(box.getByRole("button", { name: "Send" })).toHaveCount(0);
    });

    test(`qa4-simple-decide-5: the meeting chat says who applies and who proposes (${where})`, async ({ page }) => {
      // fails_when: the rule reads "Everyone except viewers" with no word that others only propose
      await startReview(page);
      await expect(chat(page).getByTestId("chat-rules")).toContainText("Everyone except viewers");
      await expect(chat(page).getByTestId("chat-rules-hint")).toHaveText("Owners and each item's decider apply; others propose.");
      await chatPage(page);
      await expect(chat(page).getByTestId("chat-rules-hint")).toHaveText("Owners and each item's decider apply; others propose.");
    });

    test(`qa4-simple-decide-29: a change card says its item once and Oracle's line ends as a sentence (${where})`, async ({ page }) => {
      // fails_when: the card reads "Move Setup checklist to Next" then "Item: Setup checklist", or Oracle's line ends in a colon
      await startReview(page);
      await say(chat(page), "move Setup checklist to Next");
      const line = chat(page).locator('[data-testid="chat-message"][data-kind="cards"]').last();
      await expect(line.getByTestId("chat-message-body")).toHaveText("I understood one change.");
      const card = line.getByTestId("chat-card");
      await expect(card).toHaveCount(1);
      await expect(card.getByTestId("chat-card-summary")).toContainText("Setup checklist");
      await expect(card).not.toContainText("Item: Setup checklist");
    });

    test(`qa4-simple-decide-30: a viewer's hint names who makes changes by the rule in force (${where})`, async ({ page }) => {
      // fails_when: under "Everyone except viewers" the viewer is told the presenter alone makes changes
      await startReview(page, ["Viewer"]);
      const url = await chatPage(page);
      await switchTo(page, "viewer@example.com");
      await page.goto(url);
      await expect(chat(page).getByTestId("chat-rules")).toContainText("Everyone except viewers");
      await expect(chat(page).getByTestId("chat-hint")).toHaveText("Viewers ask questions here; commenters and up make changes and notes.");
    });
  });
}
