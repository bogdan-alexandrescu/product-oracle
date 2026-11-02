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
  });
}
