import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * QA pass 4's findings on the Simple meeting screen (live and ended), driven through the UI
 * on the mock's invented PRD "Guided setup" and its past "Review: Usage alerts", desktop and
 * phone, as the company's owner (and the invented Commenter for a chat proposal).
 *
 * -2: Approve publishes, so it says so and asks first, listing the edits. -3: End says which
 * proposals still wait, and the minutes list a chat proposal under What still waits on whom.
 * -11: a question decided in the meeting keeps its code (Q5), open questions get no D- code.
 * -15/-16: the roadmap step reads Now, Next, Later, Cut, its Move buttons line up, and a move
 * says what moved. -17: the toast keeps clear of the steps and the clock. -19: the meeting's
 * one time format, no zone letters. -20: "Ended … Pacific Time". -23: attendee chips have a
 * visible Mark away / Mark here. -24: "Decisions in this meeting". -27: the back link and the
 * title share a baseline. -31: Accept and Decline one height. -32: Connect Slack looks like a
 * link. -39: a decision's link is named by its code and words.
 */

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
  await sheet.getByRole("checkbox", { name: "Commenter" }).check();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function endIt(page: Page) {
  await tap(page.getByRole("button", { name: "End meeting" }));
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

async function pastMeeting(page: Page, signedIn = false) {
  if (!signedIn) await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByTestId("meetings-past").getByRole("link", { name: "Review: Usage alerts" }).first());
  await expect(page.getByTestId("end-screen")).toBeVisible();
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

async function openPeople(page: Page) {
  const toggle = page.getByTestId("meeting-people-toggle");
  if (await toggle.isVisible()) await tap(toggle);
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1512, height: 900 } });

    test("qa4-simple-decide-2: Approve says it publishes, lists the edit and asks first", async ({ page }) => {
      await startReview(page);
      await tap(page.getByRole("button", { name: "Edit “A setup checklist that shows" }));
      await page.getByLabel("New wording for").fill("A checklist that names the next step");
      await tap(page.getByRole("button", { name: "Save" }));
      await expect(decisions(page)).toContainText("New wording for a line of Guided setup");
      const approve = page.getByRole("button", { name: "Approve and publish one-pager edits (1)" });
      await tap(approve);
      const ask = page.getByRole("alertdialog");
      await expect(ask).toContainText("This publishes Guided setup");
      await expect(ask).toContainText("New wording for a line of Guided setup");
      // Back publishes nothing.
      await ask.getByRole("button", { name: "Back" }).click();
      await expect(ask).toHaveCount(0);
      await expect(decisions(page)).not.toContainText("Approved Guided setup");
      await expect(page.getByTestId("approved-banner")).toHaveCount(0);
      await tap(approve);
      await page.getByRole("alertdialog").getByRole("button", { name: "Approve and publish" }).click();
      await expect(decisions(page)).toContainText("Approved Guided setup (published)");
    });

    test("qa4-simple-decide-3: End warns of waiting proposals; the minutes list a chat proposal as waiting", async ({ page }) => {
      await startReview(page);
      const url = page.url();
      // The commenter proposes from the meeting's chat.
      await switchTo(page, "commenter@example.com");
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
      const chat = page.getByTestId("meeting-chat");
      await chat.getByRole("textbox", { name: "Message Oracle" }).fill("move Welcome video to Now");
      await tap(chat.getByRole("button", { name: "Send" }));
      const card = chat.getByTestId("chat-card").filter({ hasText: "Welcome video" }).last();
      await expect(card).toBeVisible();
      const preview = card.getByRole("button", { name: "Preview" });
      if (await preview.isVisible()) await tap(preview);
      await tap(card.getByRole("button", { name: "Propose" }));
      await expect(card.getByRole("button", { name: "Propose" })).toHaveCount(0);
      // The owner ends the meeting: the dialog names what still waits.
      await switchTo(page, "admin@example.com");
      await page.goto(url);
      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      await expect(page.getByRole("region", { name: "Pending proposals" })).toContainText("Welcome video");
      await tap(page.getByRole("button", { name: "End meeting" }));
      const ask = page.getByRole("alertdialog");
      await expect(ask).toContainText(/\d+ proposals? still waits? for a decision/);
      await expect(ask).toContainText("Commenter proposes to move Welcome video to Now");
      await ask.getByRole("button", { name: "End meeting" }).click();
      await expect(page.getByTestId("end-screen")).toBeVisible();
      await expect(page.getByRole("region", { name: "What still waits" })).toContainText("Proposal: Moved Welcome video");
    });

    test("qa4-simple-decide-11: a decided question keeps its own code; an open question gets no decision code", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      const q5 = page.getByRole("region", { name: "On the agenda", exact: true }).locator('[data-code="Q5"]');
      await tap(q5.getByRole("button", { name: "Decide as recommended" }));
      const row = decisions(page).getByTestId("meeting-decision").filter({ hasText: "Reminder default time" });
      await expect(row).toContainText("Q5 Reminder default time");
      await expect(row).not.toContainText(/D-\d+/);
      // A past meeting's open question reads by its words.
      await pastMeeting(page, true);
      const minutes = page.getByRole("region", { name: "Minutes" });
      await expect(minutes.getByRole("link", { name: "Should muted teams still get the weekly digest?", exact: true })).toBeVisible();
      await expect(minutes).not.toContainText("D-3");
    });

    test("qa4-simple-decide-24: the sidebar says it lists this meeting's decisions", async ({ page }) => {
      await startReview(page);
      await expect(decisions(page).getByRole("heading", { name: "Decisions in this meeting" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "All decisions" })).toHaveCount(0);
    });

    test("qa4-simple-decide-20: an ended meeting reads Ended <day, time> Pacific Time, no nested brackets", async ({ page }) => {
      await pastMeeting(page);
      const ended = page.getByTestId("meeting-ended-at");
      await expect(ended).toContainText(/^Ended \w{3} \w{3} \d+, \d+:\d{2} [AP]M Pacific Time · /);
      await expect(ended).not.toContainText("(");
    });

    test("qa4-simple-decide-15: the roadmap step reads Now, Next, Later, Cut, its Move buttons in columns", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
      const slice = page.getByRole("region", { name: "Roadmap slice" });
      const rows = slice.locator("li[data-item]");
      await expect(rows.first()).toBeVisible();
      const texts = await rows.allTextContents();
      expect(texts.length).toBeGreaterThan(2);
      const rank = (t: string) => ["· Now ·", "· Next ·", "· Later ·", "· Cut ·"].findIndex((h) => t.includes(h));
      const ranks = texts.map(rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      if (!phone) {
        const xs = await Promise.all((await slice.getByRole("button", { name: /^Move .* to Later$/ }).all()).map(async (b) => Math.round((await b.boundingBox())!.x)));
        expect(xs.length).toBeGreaterThan(1);
        expect(new Set(xs).size).toBe(1);
      }
    });

    test("qa4-simple-decide-16: a roadmap move says what moved", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
      await tap(page.getByRole("button", { name: "Move Sample data import to Later" }));
      await expect(page.getByTestId("roadmap-said")).toHaveText("Moved Sample data import to Later.");
    });

    test("qa4-simple-decide-17: the Decided toast keeps clear of the steps and the clock", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      const q5 = page.getByRole("region", { name: "On the agenda", exact: true }).locator('[data-code="Q5"]');
      await tap(q5.getByRole("button", { name: "Decide as recommended" }));
      const shown = page.getByRole("status").filter({ hasText: /^Decided Q5/ });
      await expect(shown).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByTestId("meeting-screen").evaluate((el) => el.scrollTo(0, 0));
      const box = (await shown.boundingBox())!;
      for (const l of [steps(page), page.getByRole("timer", { name: "Meeting clock" })]) {
        const b = await l.boundingBox();
        if (b) expect(overlaps(box, b)).toBe(false);
      }
      // At the bottom of the screen, as on the other pages.
      expect(box.y).toBeGreaterThan((page.viewportSize()!.height * 2) / 3);
    });

    test("qa4-simple-decide-19: the meeting's times read 'Fri Oct 30, 8:18 PM', no zone letters", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
      await tap(page.getByRole("button", { name: "Move Sample data import to Later" }));
      const when = decisions(page).getByTestId("meeting-decision").first().locator("span");
      await expect(when).toHaveText(/ · [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    });

    test("qa4-simple-decide-23: an attendee chip has a visible Mark away / Mark here", async ({ page }) => {
      await startReview(page);
      await openPeople(page);
      const away = page.getByRole("button", { name: "Mark Commenter away" });
      await expect(away).toBeVisible();
      await expect(away).toHaveText("Mark away");
      await tap(away);
      const here = page.getByRole("button", { name: "Mark Commenter here" });
      await expect(here).toHaveText("Mark here");
      await expect(page.getByLabel("Attendees").locator('[data-present="false"]')).toContainText("Commenter");
      await tap(here);
      await expect(page.getByRole("button", { name: "Mark Commenter away" })).toBeVisible();
    });

    test("qa4-simple-decide-31: Accept and Decline are one height", async ({ page }) => {
      await startReview(page);
      await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
      const pending = page.getByRole("region", { name: "Pending proposals" });
      const accept = pending.getByRole("button", { name: "Accept" }).first();
      const decline = pending.getByRole("button", { name: "Decline" }).first();
      await expect(accept).toBeVisible();
      expect(Math.round((await accept.boundingBox())!.height)).toBe(Math.round((await decline.boundingBox())!.height));
    });

    test("qa4-simple-decide-39: a decision's link is named by its code and its words", async ({ page }) => {
      await pastMeeting(page);
      const taken = page.getByRole("list", { name: "Decisions taken" });
      await expect(taken.getByRole("link", { name: /^D-4 Moved / })).toBeVisible();
      await expect(taken.getByRole("link", { name: /^D-\d+$/ })).toHaveCount(0);
    });

    test("qa4-simple-decide-32: Connect Slack is drawn as a link, not grey like its note", async ({ page }) => {
      await startReview(page);
      await endIt(page);
      const d = page.getByRole("region", { name: "Delivery" });
      const link = d.getByRole("link", { name: /Connect Slack|Pick a channel/ });
      await expect(link).toBeVisible();
      const note = d.getByText(/Slack is not connected yet\.|Slack has no channel for minutes yet\./);
      const color = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
      expect(await color(link)).not.toBe(await color(note));
    });

    test("qa4-simple-decide-27: the back link and the title share one baseline", async ({ page }) => {
      await startReview(page);
      const header = page.locator('header[aria-label="Meeting"]');
      const bottoms = await header.evaluate((h) => {
        const textBottom = (el: Element | null) => {
          const r = document.createRange();
          r.selectNodeContents(el!);
          return r.getClientRects()[0]!.bottom;
        };
        return [textBottom(h.querySelector('a[href="/simple/meetings"]')), textBottom(h.querySelector("h1"))];
      });
      expect(Math.abs(bottoms[0]! - bottoms[1]!)).toBeLessThanOrEqual(4);
    });
  });
}
