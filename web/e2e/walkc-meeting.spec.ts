import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type BrowserContext, type Locator, type Page } from "./test";

/**
 * walkc-meeting: a live Simple review meeting, as an end-to-end walk ran it, on the mock's
 * invented PRD "Guided setup", as the company's owner, desktop and phone.
 *
 * Card approve-problems: protects = an Approve the importer refuses lists its problems in
 * plain words, each with what to do, at most six and "And 2 more like these", under one
 * line that says it was not approved and how many problems there are; fails_when = the page
 * shows the raw "draft rejected: 8 problem(s)" or nothing; no_claim = the importer's checks
 * (api tests/test_walkc_meeting.py).
 *
 * Card propose-names-who (the "simple-chat" scenario's Weekly plan review, everyone may
 * change things): protects = a commenter's card says who Propose asks before Propose
 * ("Propose asks Avery Stone to decide.", the meeting's decider), and once proposed it
 * reads "Proposed to Avery Stone by you" even after the page is opened again; fails_when =
 * the card is silent before Propose, or says "Proposed to the decider" after a reload;
 * no_claim = who outside a meeting is asked (api tests/test_walkc_meeting.py routes the
 * proposal to the meeting's deciders, never an owner outside it).
 *
 * Card publish-end-delivery: protects = the Publish dialog counts the draft's edits and
 * says the lines below are the changes that made them ("with 1 edit, made by this change
 * in this meeting"); End meeting warns that the meeting's edits are not approved yet; the
 * Delivery step says the Decisions page shows the minutes already (Send marks them sent);
 * fails_when = End says nothing of the unapproved edit, or Delivery says Send posts to the
 * Decisions page; no_claim = what Approve publishes (simple-meetings-approve.spec.ts).
 *
 * Card task-for-in-name: protects = after the owner renames an item to "Setup for teams",
 * "add a task 'Write the FAQ' to Setup for teams for Theo Brandt" gives a card on that
 * item for Theo Brandt; fails_when = the line splits at the name's own " for " (no card,
 * or "Which item?"); no_claim = other phrases.
 *
 * Card fixes-on-working-state (the "simple-chat" scenario's Weekly plan review): protects =
 * an open card's fix buttons are checked again on the meeting's working state, so once a
 * fix applied in the meeting mends a broken link, an earlier card on that item shows no
 * fix buttons, even after the page is opened again; fails_when = the earlier card still
 * offers the fixes it had when it was made; no_claim = the fixes' dates (api
 * tests/test_walkc_meeting.py reads the meeting's working state).
 *
 * Card cut-with-dependents-asks (the "simple-chat" scenario's Weekly plan review, everyone
 * may change things): protects = a commenter's cut card with dependents says who "Propose:
 * cut it and its dependents" asks, besides who Propose asks; fails_when = the card names
 * only who the cut alone asks; no_claim = who that is when the items' deciders differ (api
 * tests/test_walkc_meeting.py works it out from every item cut).
 */

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

async function startWithAnEdit(page: Page) {
  await login(page);
  await page.goto("/simple/prds/guided-setup");
  await page.getByRole("button", { name: "Start review" }).click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill("A checklist that names the next step");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
}

const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function attend(page: Page, email: string, first: boolean): Promise<Page> {
  const tab = first ? page : await page.context().newPage();
  const size = tab.viewportSize();
  if (!first) {
    // Signing out uses the desktop header's account menu; the tab is put back after.
    await tab.setViewportSize({ width: 1366, height: 820 });
    await tab.goto("/home");
    await signOut(tab);
  }
  await tab.goto("/login");
  await tab.getByLabel("Email").fill(email);
  await tab.getByLabel("Password").fill(ADMIN.password);
  await tap(tab.getByRole("button", { name: "Sign in" }));
  await expect(tab).not.toHaveURL(/\/login/);
  if (size) await tab.setViewportSize(size);
  await tab.goto(MEETING);
  await expect(tab.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  return tab;
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 } });

    test(`a refused Approve lists its problems in plain words (${where})`, async ({ page, context }) => {
      await flags(context, "approve-problems");
      await startWithAnEdit(page);
      await page.getByRole("button", { name: /^Approve and publish one-pager edits/ }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Approve and publish" }).click();
      const said = page.getByTestId("approve-problems");
      await expect(said).toContainText("Not approved: the draft has 8 problems to fix first.");
      await expect(said.getByRole("listitem")).toHaveCount(6);
      await expect(said.getByRole("listitem").first()).toContainText("The date Nov 20 (in What we will build) is not backed by a confirmed schedule");
      await expect(said.getByRole("listitem").first()).toContainText("record its basis on the roadmap or drop the date");
      await expect(said).toContainText("And 2 more like these.");
      await expect(page.getByText(/draft rejected/)).toHaveCount(0);
    });

    test(`Publish counts edits, End warns of unapproved edits, Delivery says the truth (${where})`, async ({ page }) => {
      await startWithAnEdit(page);
      await page.getByRole("button", { name: /^Approve and publish one-pager edits/ }).click();
      const ask = page.getByRole("alertdialog");
      await expect(ask).toContainText("This publishes Guided setup with 1 edit, made by this change in this meeting:");
      await ask.getByRole("button", { name: "Back" }).click();
      await expect(ask).toHaveCount(0);
      await page.getByRole("button", { name: "End meeting" }).click();
      await expect(ask).toContainText("The edit made in this meeting is not approved yet: it stays in a working draft until the decider approves.");
      await ask.getByRole("button", { name: "End meeting" }).click();
      await expect(page.getByTestId("end-screen")).toBeVisible();
      await expect(page.getByRole("region", { name: "Delivery" })).toContainText("Decisions page · shows them already; Send marks them sent");
    });

    test(`a task line finds an item whose name holds "for" (${where})`, async ({ page, context }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      const owner = await attend(page, ADMIN.email, true);
      const chat = owner.getByTestId("meeting-chat");
      const say = async (text: string) => {
        await chat.getByLabel("Message Oracle").fill(text);
        await tap(chat.getByRole("button", { name: "Send" }));
      };
      await say("rename Setup checklist to Setup for teams");
      const renamed = chat.getByTestId("chat-card").filter({ hasText: "Rename Setup checklist to “Setup for teams”" });
      await tap(renamed.getByRole("button", { name: "Apply" }));
      await expect(renamed.getByTestId("chat-card-outcome")).toContainText("Applied by you");
      await say("add a task 'Write the FAQ' to Setup for teams for Theo Brandt");
      await expect(chat.getByTestId("chat-card").filter({ hasText: "Add the task “Write the FAQ” to Setup for teams for Theo Brandt" })).toBeVisible();
    });

    test(`a meeting card says who Propose asks, before and after (${where})`, async ({ page, context }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      const owner = await attend(page, ADMIN.email, true);
      await owner.getByLabel("Who changes things").selectOption("everyone");
      await expect(owner.getByLabel("Who changes things")).toHaveValue("everyone");
      const theo = await attend(page, "commenter@example.com", false);
      const chat = theo.getByTestId("meeting-chat");
      await chat.getByLabel("Message Oracle").fill("rename Setup checklist to First-run checklist");
      await tap(chat.getByRole("button", { name: "Send" }));
      const card = chat.getByTestId("chat-card").filter({ hasText: "Rename Setup checklist to “First-run checklist”" });
      await expect(card.getByRole("button", { name: "Propose" })).toBeEnabled();
      await expect(card.getByTestId("chat-card-asks")).toHaveText("Propose asks Avery Stone to decide.");
      await tap(card.getByRole("button", { name: "Propose" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to Avery Stone by you");
      await theo.reload();
      const again = theo.getByTestId("meeting-chat").getByTestId("chat-card").filter({ hasText: "Rename Setup checklist to “First-run checklist”" });
      await expect(again.getByTestId("chat-card-outcome")).toContainText("Proposed to Avery Stone by you");
    });

    test(`a fix applied in the meeting clears an earlier card's fixes (${where})`, async ({ page, context }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      const owner = await attend(page, ADMIN.email, true);
      const chat = owner.getByTestId("meeting-chat");
      const say = async (text: string) => {
        await chat.getByLabel("Message Oracle").fill(text);
        await tap(chat.getByRole("button", { name: "Send" }));
      };
      const card = (name: string) => owner.getByTestId("meeting-chat").getByTestId("chat-card").filter({ hasText: name });
      await say("move Alert rules engine to next quarter");
      await tap(card("Move Alert rules engine to Jan 1").getByRole("button", { name: "Apply", exact: true }));
      await expect(card("Move Alert rules engine to Jan 1").getByTestId("chat-card-outcome")).toContainText("Applied by you");
      // A card's fixes name the item as the card would leave it.
      const fix = /^Start (Weekly|Alert) digest after Alert rules engine ends$/;
      await say("rename Weekly alert digest to Weekly digest");
      const earlier = card("Rename Weekly alert digest to “Weekly digest”");
      await expect(earlier.getByTestId("chat-card-fix").filter({ hasText: fix })).toHaveCount(1);
      await say("rename Weekly alert digest to Alert digest");
      const later = card("Rename Weekly alert digest to “Alert digest”");
      await tap(later.getByTestId("chat-card-fix").filter({ hasText: fix }));
      await expect(later.getByTestId("chat-card-outcome")).toContainText("Applied by you");
      await owner.reload();
      await expect(earlier.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
      await expect(earlier.getByTestId("chat-card-fix")).toHaveCount(0);
    });

    test(`a cut card says who its cut with dependents asks (${where})`, async ({ page, context }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      const owner = await attend(page, ADMIN.email, true);
      await owner.getByLabel("Who changes things").selectOption("everyone");
      await expect(owner.getByLabel("Who changes things")).toHaveValue("everyone");
      const theo = await attend(page, "commenter@example.com", false);
      const chat = theo.getByTestId("meeting-chat");
      await chat.getByLabel("Message Oracle").fill("cut Alert rules engine");
      await tap(chat.getByRole("button", { name: "Send" }));
      const card = chat.getByTestId("chat-card").filter({ hasText: "Cut Alert rules engine" });
      await expect(card.getByRole("button", { name: "Propose: cut it and its dependents" })).toBeEnabled();
      await expect(card.getByTestId("chat-card-asks")).toHaveText("Propose asks Avery Stone to decide.");
      await expect(card.getByTestId("chat-card-asks-dependents")).toHaveText("Cutting it with its dependents asks Avery Stone to decide.");
    });
  });
}
