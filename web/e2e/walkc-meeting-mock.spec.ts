import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_MEETINGS_KEY } from "../lib/api/mock/simple-meetings";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type BrowserContext, type Locator, type Page } from "./test";

/**
 * walkc-meeting review minors: the mock meetings as the API serves them, on the mock's
 * invented PRD "Guided setup" and the "simple-chat" scenario's Weekly plan review, desktop
 * (the rail's Roadmap count is the desktop rail's).
 *
 * Card minutes-stuck: protects = a minutes job that never answers reads "Drafting…", then
 * "still drafting" past 2 minutes, and past 6 minutes (the API's MINUTES_STUCK) "Oracle
 * could not draft the minutes" with Draft again, which brings Oracle's minutes into the
 * fields; fails_when = the stalled job reads "Drafting…" or "still drafting" for ever, with
 * no Draft again; no_claim = the job runner and the cancelled job (api tests/test_walkc_meeting.py).
 *
 * Card meeting-proposal-stays: protects = a proposal made in a meeting stays with the
 * meeting's decider (Avery Stone, the owner) after the item gets another decider, on
 * another tab and after the page is opened again: the owner's Roadmap count still counts
 * it; fails_when = the mock forgets which proposals were made in a meeting (kept only in
 * one tab's memory, or across companies), so the proposal moves to the new decider and the
 * owner's count drops back; no_claim = who Propose asks before Propose (walkc-meeting.spec.ts).
 *
 * Not shown here: the mock's meeting deciders now follow the API's rule (service.can_decide:
 * an owner, the item's or roadmap's decider, else its track owner while an approver) rather
 * than "an owner, or someone the proposal would go to anyway". For a proposal on an item the
 * two give the same people (who it would go to is exactly the item's deciders, else the
 * owners), and the only proposals they differ on (new items, with nobody in the meeting
 * counted as their decider) need a roadmap decider who is not in the meeting, which no
 * mock meeting a person can start has; so no person-driven case fails without it.
 */

test.use({ viewport: { width: 1366, height: 820 } });

async function flags(context: BrowserContext, value: string) {
  await context.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_MEETINGS_KEY, value] as const);
}

const minutesRegion = (page: Page) => page.getByRole("region", { name: "Minutes" });

async function endOne(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await page.getByRole("button", { name: "Start review" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
  await page.getByRole("button", { name: "Move Setup checklist to Next" }).click();
  await expect(page.getByRole("region", { name: "Decisions in this meeting" })).toContainText("Moved Setup checklist");
  await page.getByRole("button", { name: "End meeting" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** Signs in as `email` (on a new tab after the first: the tabs share one sign-in) and opens the meeting. */
async function attend(page: Page, email: string, first: boolean): Promise<Page> {
  const tab = first ? page : await page.context().newPage();
  if (!first) {
    await tab.goto("/home");
    await signOut(tab);
  }
  await tab.goto("/login");
  await tab.getByLabel("Email").fill(email);
  await tab.getByLabel("Password").fill(ADMIN.password);
  await tap(tab.getByRole("button", { name: "Sign in" }));
  await expect(tab).not.toHaveURL(/\/login/);
  await tab.goto(MEETING);
  await expect(tab.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  return tab;
}

async function say(tab: Page, text: string) {
  const chat = tab.getByTestId("meeting-chat");
  await chat.getByLabel("Message Oracle").fill(text);
  await tap(chat.getByRole("button", { name: "Send" }));
}

test("a minutes job that never answers says it failed after 6 minutes and offers Draft again", async ({ page, context }) => {
  await flags(context, "minutes-stuck");
  await endOne(page);
  const minutes = minutesRegion(page);
  await expect(minutes.getByText("Drafting…")).toBeVisible();
  await expect(minutes.getByRole("button", { name: "Draft again" })).toHaveCount(0);
  await page.clock.fastForward(3 * 60_000);
  await expect(minutes.getByTestId("minutes-slow")).toContainText("still drafting");
  await expect(minutes.getByRole("button", { name: "Draft again" })).toHaveCount(0);
  await page.clock.fastForward(4 * 60_000);
  await expect(minutes.getByTestId("minutes-failed")).toContainText("Oracle could not draft the minutes");
  await expect(minutes.getByTestId("minutes-slow")).toHaveCount(0);
  await minutes.getByRole("button", { name: "Draft again" }).click();
  await expect(minutes.getByTestId("minutes-failed")).toHaveCount(0);
  await expect(minutes.getByLabel("Summary")).toHaveValue("Oracle's minutes of Review: Guided setup: 1 decisions taken.");
});

test("a proposal made in a meeting stays with the meeting's decider after the item gets another", async ({ page, context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  const owner = await attend(page, ADMIN.email, true);
  await owner.getByLabel("Who changes things").selectOption("everyone");
  await expect(owner.getByLabel("Who changes things")).toHaveValue("everyone");
  // What waits on the owner before the meeting's proposal.
  await owner.goto("/simple/roadmap");
  const count = owner.getByTestId("simple-nav-roadmap-count");
  await expect(count).toHaveText(/^\d+$/);
  const before = Number(await count.textContent());

  // The commenter proposes in the meeting: it goes to Avery Stone, the owner in it.
  const theo = await attend(page, "commenter@example.com", false);
  await say(theo, "rename Setup checklist to First-run checklist");
  const card = theo.getByTestId("meeting-chat").getByTestId("chat-card").filter({ hasText: "Rename Setup checklist to “First-run checklist”" });
  await expect(card.getByTestId("chat-card-asks")).toHaveText("Propose asks Avery Stone to decide.");
  await tap(card.getByRole("button", { name: "Propose" }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to Avery Stone by you");

  // The owner, on another tab, names Priya Raman the item's decider.
  const back = await attend(page, ADMIN.email, false);
  await say(back, "make Priya Raman the decider of Setup checklist");
  const named = back.getByTestId("meeting-chat").getByTestId("chat-card").filter({ hasText: "Make Priya Raman the decider of Setup checklist" }).last();
  await tap(named.getByRole("button", { name: "Apply", exact: true }));
  await expect(named.getByTestId("chat-card-outcome")).toContainText("Applied by you");

  // The proposal still waits on the owner, read afresh.
  await back.goto("/simple/roadmap");
  await expect(back.getByTestId("simple-nav-roadmap-count")).toHaveText(String(before + 1));
  await back.reload();
  await expect(back.getByTestId("simple-nav-roadmap-count")).toHaveText(String(before + 1));
});
