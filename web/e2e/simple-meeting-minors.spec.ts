import { expect, test, type Locator, type Page } from "./test";

import { ADMIN } from "./helpers";

/*
 * Simple meetings say what happened to a meeting and to a question (the end-to-end pass of
 * 2026-10-30). A live review of Guided setup, started through the UI by the mock's owner
 * (Admin), 60 minutes long:
 * - past its length the clock reads "Over by 30 min" and the page offers to end it;
 * - left alone past the idle limit (4 hours without a change), it has ended when opened;
 * - a question typed in its chat ("Kept as a question for the minutes…") shows under
 *   "Notes so far" at once as an open question, and the minutes list it;
 * - the idle limit counts from the last change made in it, as the API's session does: an
 *   Approve (a decision, not a change) 3 hours after an edit does not keep it open.
 * Invented example data only. Desktop (1366x820) and phone (390x844).
 */

const KEPT = "Kept as a question for the minutes. For an answer now, use Ask Oracle.";

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** The owner signs in and starts a review of Guided setup; the live meeting's URL. */
async function startReview(page: Page): Promise<string> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple/prds/guided-setup");
  await tap(page.getByRole("button", { name: "Start review" }));
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await expect(page.getByRole("timer", { name: "Meeting clock" })).toHaveText(/^0:0\d \/ 60:00$/);
  return page.url();
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 } });

    test(`an overrun meeting says "Over by 30 min" and offers to end it (${where})`, async ({ page }) => {
      // protects: past its length the clock says how far over it is in plain words (not "89:51 / 60:00") and a line offers "End it now", which ends the meeting after the usual check
      // fails_when: the clock keeps counting past the length, or nothing offers to end it
      // no_claim: the idle end (next test), who may end a meeting (simple-meeting-end.spec.ts)
      await startReview(page);
      await page.clock.fastForward(90 * 60_000);
      const clock = page.getByRole("timer", { name: "Meeting clock" });
      await expect(clock).toHaveText("Over by 30 min");
      const over = page.getByTestId("meeting-overrun");
      await expect(over).toHaveText(/This meeting ran past its 60 minutes\./);
      await tap(over.getByRole("button", { name: "End it now" }));
      await tap(page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }));
      await expect(page.getByTestId("end-screen")).toBeVisible();
    });

    test(`a meeting nobody opened for 4 hours has ended when opened (${where})`, async ({ page }) => {
      // protects: a meeting left without a change past the idle limit (as one whose start reply failed) is ended with Oracle's quick minutes, as the API's idle sweep ends it
      // fails_when: it opens live, still counting
      // no_claim: the API's sweep itself (api/tests/test_simple_meetings_minors.py)
      const url = await startReview(page);
      await page.goto("/simple/meetings");
      await page.clock.fastForward((4 * 60 + 1) * 60_000);
      await page.goto(url);
      await expect(page.getByTestId("end-screen")).toBeVisible();
      await expect(page.getByRole("timer", { name: "Meeting clock" })).toHaveCount(0);
    });

    test(`the idle limit counts from the last change, not an approval (${where})`, async ({ page }) => {
      // protects: as the API (changes.close_idle counts from the session's last change), the mock ends a meeting 4 hours after its last edit even when it was approved since; Approve is a decision, not a change
      // fails_when: the meeting is still live 4 hours after the edit because the approval came later
      // no_claim: the API's sweep (api/tests/test_simple_meetings_minors.py)
      const url = await startReview(page);
      await expect(page.getByTestId("meeting-screen").getByTestId("one-pager")).toContainText("Version 3");
      await tap(page.getByRole("button", { name: "Edit “A setup checklist that shows" }));
      await page.getByLabel("New wording for").fill("A checklist that names the next step");
      await tap(page.getByRole("button", { name: "Save" }));
      await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
      await page.clock.fastForward(3 * 60 * 60_000);
      // qa4-simple-decide-2 (#1001): Approve says it publishes, and asks first.
      await tap(page.getByRole("button", { name: /^Approve and publish one-pager edits/ }));
      await tap(page.getByRole("alertdialog").getByRole("button", { name: "Approve and publish" }));
      await expect(page.getByTestId("meeting-screen")).toContainText("Approved Guided setup");
      await page.goto("/simple/meetings");
      await page.clock.fastForward(61 * 60_000);
      await page.goto(url);
      await expect(page.getByTestId("end-screen")).toBeVisible();
    });

    test(`a kept question shows under "Notes so far" at once and the minutes list it (${where})`, async ({ page }) => {
      // protects: a question typed in the meeting chat gets "Kept as a question for the minutes…" and, at once, "Open question: <line>" under Notes so far; End meeting lists it in the minutes' open questions
      // fails_when: Notes so far still says "None yet." after the question is kept, or the minutes miss it
      // no_claim: the reader's wording for other lines (simple-chat-reader.spec.ts)
      await startReview(page);
      const notes = page.getByTestId("meeting-notes");
      await expect(notes).toContainText("None yet.");
      const line = "Can we move Setup checklist to start on Dec 1, so the pilot fits?";
      const chat = page.getByTestId("meeting-chat");
      await chat.getByRole("textbox", { name: "Message Oracle" }).fill(line);
      await tap(chat.getByRole("button", { name: "Send" }));
      await expect(chat.getByTestId("chat-message-body").filter({ hasText: KEPT }).last()).toBeVisible();
      const kept = notes.locator('[data-testid="meeting-note"][data-kind="question"]');
      await expect(kept).toHaveCount(1);
      await expect(kept).toContainText(`Open question: ${line}`);
      await expect(notes).not.toContainText("None yet.");

      await tap(page.getByRole("button", { name: "End meeting" }));
      await tap(page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }));
      await expect(page.getByTestId("end-screen")).toBeVisible();
      await expect(page.getByLabel("Open questions")).toHaveValue(line);
    });
  });
}
