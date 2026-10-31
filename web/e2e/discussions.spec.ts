import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, openTab, section, sectionAction, signOut } from "./helpers";

/*
 * G1 Discussion model through the UI, on the mock layer ("discussions" scenario): a thread
 * per subject, open by default, private when its starter says so, made open again by the
 * starter alone after a warning naming what it exposes. The scenario seeds one private
 * discussion the commenter started with the approver on team-workspaces v2's Problem, with
 * 3 messages from the 2 of them; checkout-redesign has none.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The real API's rules are covered by api/tests/test_discussions*.py.
 */

const DOC = "/documents/checkout-redesign/v/2";
const SEEDED = "/documents/team-workspaces/v/2";
const SEEDED_TITLE = "Problem: who owns the admin role?";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const discussionChip = (page: Page) => panel(page).getByTestId("feedback-discussions");
const rows = (page: Page) => panel(page).getByTestId("discussion-row");
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });

/** Starts a discussion on the open section of DOC from its ⋯ menu; private with the people given (found by email, picked by name). */
async function discussProblem(page: Page, opts: { private?: { email: string; name: string }[]; first?: string } = {}) {
  await page.goto(DOC);
  const s = await openSection(page, "problem");
  await sectionAction(s, "2. Problem", "Start a discussion");
  const form = page.getByTestId("start-discussion").filter({ visible: true });
  await expect(form.getByRole("textbox", { name: "Title" })).toHaveValue("Checkout redesign PRD · 2. Problem");
  if (opts.private) {
    await form.getByRole("group", { name: "Visible to" }).getByRole("button", { name: "Only people I pick" }).click();
    await expect(form).toContainText("Only the people you pick can read it. Everyone else sees that a private discussion exists.");
    for (const who of opts.private) {
      await form.getByRole("searchbox", { name: "Find a person" }).fill(who.email);
      await form.getByRole("option", { name: new RegExp(who.name) }).click();
    }
  }
  if (opts.first) await form.getByRole("textbox", { name: "First message" }).fill(opts.first);
  await form.getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page)).toBeVisible();
}

/** Opens the Feedback tab's discussions and the one titled `title` (or the only row). */
async function openDiscussion(page: Page, title?: string) {
  await openTab(page, "Feedback");
  await discussionChip(page).click();
  const row = title ? rows(page).filter({ hasText: title }) : rows(page);
  await row.first().click();
  await expect(thread(page)).toBeVisible();
}

/** Types `@<query>` in the composer and picks `name` from the mention picker. */
async function mention(page: Page, query: string, name: string) {
  const box = thread(page).getByRole("textbox", { name: "Message" });
  await box.pressSequentially(`@${query}`);
  await thread(page).getByRole("listbox", { name: "People to mention" }).getByRole("option", { name: new RegExp(`^${name}`) }).click();
}

// protects=criterion 14.1: a commenter discusses a section, mentions the approver and sees the
// @chip; the Feedback tab's Discussion chip counts it and Open feedback does not move;
// fails_when=no Discuss entry, no chip, a wrong count, or Open feedback counts the discussion;
// no_claim=the Inbox row the mention makes (G6).
test("discuss a section: the mention shows as a chip, the Discussion chip counts 1, Open feedback stays", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(DOC);
  await openSection(page, "problem");
  const openFeedback = panel(page).getByTestId("stat-open-feedback").locator("dd");
  const before = await openFeedback.textContent();
  await openTab(page, "Feedback");
  await expect(discussionChip(page)).toHaveText(/^Discussion\s*0$/);
  // The whole document has its own Discuss in the header.
  await expect(page.getByTestId("doc-discuss")).toHaveText("Discuss");

  await discussProblem(page);
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveText("Open");
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveAttribute("title", "Everyone who can see this can read it");
  await expect(thread(page).getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Reply to Oracle and the team");
  await mention(page, "appr", "Priya Raman");
  await thread(page).getByRole("textbox", { name: "Message" }).pressSequentially("can you check the drop-off numbers?");
  await thread(page).getByRole("button", { name: "Send" }).click();
  const message = thread(page).getByTestId("discussion-message").filter({ hasText: "can you check the drop-off numbers?" });
  await expect(message).toHaveCount(1);
  await expect(message.getByTestId("mention-chip")).toHaveText("@Priya Raman");
  await expect(thread(page).getByTestId("discussion-people")).toHaveText("2 people");

  await thread(page).getByRole("button", { name: "All feedback" }).click();
  await expect(discussionChip(page)).toHaveText(/^Discussion\s*1$/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Checkout redesign PRD · 2. Problem");
  await expect(openFeedback).toHaveText(before!);
});

// protects=criterion 14.2: a viewer reads the discussion and has no composer;
// fails_when=the composer shows to a viewer; no_claim=the API's 403 (pytest covers it).
test("a viewer opening the discussion reads it and has no composer", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await discussProblem(page, { first: "Is the drop-off at shipping or at payment?" });
  await signOut(page);

  await login(page, VIEWER);
  await page.goto(DOC);
  await openDiscussion(page, "Checkout redesign PRD · 2. Problem");
  await expect(thread(page).getByTestId("discussion-message").first()).toContainText("Is the drop-off at shipping or at payment?");
  // #370: a control a role can never use is hidden, with no role note: no composer, no note.
  await expect(thread(page)).not.toContainText("Viewers can read but not write here.");
  await expect(thread(page).getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(thread(page).getByRole("button", { name: "Send" })).toHaveCount(0);
});

// protects=criterion 14.3: others see only that a private discussion exists;
// fails_when=the owner's row shows its title, or the owner can open it; no_claim=a shared
// summary on the row.
test("a private discussion is one locked row for the owner, and opening it says it is private", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await discussProblem(page, { private: [{ email: "approver", name: "Priya Raman" }], first: "Between us: is the shipping step the real problem?" });
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveText("Private");
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveAttribute("title", "Only the people in it can read it");
  await signOut(page);

  await login(page);
  await page.goto(DOC);
  await openTab(page, "Feedback");
  await expect(discussionChip(page)).toHaveText(/^Discussion\s*1$/);
  await discussionChip(page).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toHaveText("Private discussion");
  await expect(rows(page).getByTestId("discussion-lock")).toBeVisible();
  await expect(panel(page)).not.toContainText("2. Problem ·");
  await rows(page).click();
  await expect(panel(page).getByText("This discussion is private")).toBeVisible();
  await expect(panel(page)).not.toContainText("Between us");
});

// protects=criterion 14.4: a non-starter cannot mention someone into a private discussion;
// fails_when=Send stays enabled or the chip is not flagged; no_claim=the API's 422.
test("in a private discussion, the approver mentioning the owner is stopped with Send disabled", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await page.goto(SEEDED);
  await openDiscussion(page, SEEDED_TITLE);
  await mention(page, "adm", "Avery Stone");
  const chip = thread(page).getByTestId("draft-mention").filter({ hasText: "Avery Stone" });
  await expect(chip).toHaveAttribute("data-blocked", "true");
  await expect(thread(page)).toContainText("Only the starter can add people to a private discussion");
  await thread(page).getByRole("textbox", { name: "Message" }).pressSequentially("what do you think?");
  await expect(thread(page).getByRole("button", { name: "Send" })).toBeDisabled();
  // Removing the mention lets the message go.
  await chip.getByRole("button", { name: "Remove Avery Stone" }).click();
  await expect(thread(page).getByRole("button", { name: "Send" })).toBeEnabled();
});

// protects=criterion 14.5: Discuss on a pending checkpoint opens the thread in a sheet;
// fails_when=no Discuss, or the sheet shows no thread; no_claim=D1's item-level Discuss tab.
test("an approver discusses a pending checkpoint in a sheet on the run page", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
  const card = page.getByTestId("checkpoint-baseline_confirm");
  await card.getByRole("button", { name: "Discuss" }).click();
  const sheet = page.getByTestId("sheet-discuss");
  await expect(sheet).toBeVisible();
  const form = sheet.getByTestId("start-discussion");
  await expect(form.getByRole("textbox", { name: "Title" })).toHaveValue(/Confirm the baseline$/);
  await form.getByRole("textbox", { name: "First message" }).fill("Is G2's target the one from the plan?");
  await form.getByRole("button", { name: "Start discussion" }).click();
  await expect(sheet.getByTestId("discussion-thread")).toBeVisible();
  await expect(sheet.getByTestId("discussion-message").first()).toContainText("Is G2's target the one from the plan?");
  await expect(sheet.getByRole("textbox", { name: "Message" })).toBeVisible();

  // Discuss again: the sheet opens on the same thread.
  await sheet.getByRole("button", { name: /^Close/ }).click();
  await card.getByRole("button", { name: "Discuss" }).click();
  await expect(page.getByTestId("sheet-discuss").getByTestId("discussion-message").first()).toContainText("Is G2's target");
});

// protects=criterion 14.6: on a phone the thread opens in the review sheet with its composer
// and nothing scrolls sideways; fails_when=the composer is hidden or the page is wider than
// 390 px; no_claim=other phone sizes.
test("at 390 px the thread opens in the review sheet with the composer and no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(DOC);
  const s = section(page, "problem");
  await page.evaluate(() => (window.location.hash = "problem"));
  await expect(s).toBeVisible();
  await sectionAction(s, "2. Problem", "Start a discussion");
  const sheet = page.getByTestId("sheet-review");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("start-discussion").getByRole("button", { name: "Start discussion" }).click();
  await expect(sheet.getByTestId("discussion-thread")).toBeVisible();
  const composer = sheet.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await composer.fill("Checking this on the bus.");
  await sheet.getByRole("button", { name: "Send" }).click();
  // Alone in it, the commenter also gets Oracle's reply (G2): the person's message is one of two.
  await expect(sheet.getByTestId("discussion-message").filter({ hasText: "Checking this on the bus." })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

// protects=criterion 14.7: only the starter makes a private discussion open, after a warning
// naming the seeded counts; Keep private changes nothing; once open the owner reads it;
// fails_when=a non-starter is offered Make open, the warning's counts are wrong, Keep private
// opens it, or the owner still sees "Private discussion"; no_claim=G5's agent view.
test("make open: only the starter, after a warning with the counts; then the owner reads it", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await page.goto(SEEDED);
  await openDiscussion(page, SEEDED_TITLE);
  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
  await expect(thread(page).getByRole("menuitem", { name: "Leave" })).toBeVisible();
  await expect(thread(page).getByRole("menuitem", { name: "Make open" })).toHaveCount(0);
  await signOut(page);

  await login(page, COMMENTER);
  await page.goto(SEEDED);
  await openDiscussion(page, SEEDED_TITLE);
  const chip = thread(page).getByTestId("discussion-visibility");
  await expect(chip).toHaveText("Private");
  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
  await thread(page).getByRole("menuitem", { name: "Make open" }).click();
  const warning = page.getByTestId("make-open-warning");
  await expect(warning).toContainText(
    "Make this discussion open? Everyone who can see Team workspaces PRD · 1. Problem will read its 3 messages from 2 people, including what was written while it was private.",
  );
  await warning.getByRole("button", { name: "Keep private" }).click();
  await expect(warning).toHaveCount(0);
  await expect(chip).toHaveText("Private");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveCount(0);

  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
  await thread(page).getByRole("menuitem", { name: "Make open" }).click();
  await page.getByTestId("make-open-warning").getByRole("button", { name: "Make open" }).click();
  await expect(chip).toHaveText("Open");
  await expect(thread(page).getByTestId("discussion-system-line")).toContainText(/^Theo Brandt made this discussion open on [A-Z][a-z]{2} \d{1,2}$/);
  await signOut(page);

  await login(page);
  await page.goto(SEEDED);
  await openTab(page, "Feedback");
  await discussionChip(page).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText(SEEDED_TITLE);
  await expect(rows(page)).not.toContainText("Private discussion");
  await rows(page).click();
  await expect(thread(page).getByTestId("discussion-message").first()).toContainText("Should the first admin be whoever creates the workspace?");
});

// protects=the warning redraws with the current counts when someone wrote after it opened
// (the 409 "Confirm what this exposes"); fails_when=a stale count is accepted or the warning
// keeps the old number; no_claim=two different people writing at once (the API test does).
test("make open: a message added after the warning opened redraws it with 4 messages", async ({ page, context }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(SEEDED);
  await openDiscussion(page, SEEDED_TITLE);
  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
  await thread(page).getByRole("menuitem", { name: "Make open" }).click();
  const warning = page.getByTestId("make-open-warning");
  await expect(warning).toContainText("its 3 messages from 2 people");

  // Meanwhile, in another tab, one more message.
  const other = await context.newPage();
  await other.goto(SEEDED);
  await openDiscussion(other, SEEDED_TITLE);
  await thread(other).getByRole("textbox", { name: "Message" }).fill("One more before it opens.");
  await thread(other).getByRole("button", { name: "Send" }).click();
  await expect(thread(other).getByTestId("discussion-message").filter({ hasText: "One more before it opens." })).toHaveCount(1);
  await other.close();

  await warning.getByRole("button", { name: "Make open" }).click();
  await expect(warning).toContainText("its 4 messages from 2 people");
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveText("Private");
  await warning.getByRole("button", { name: "Make open" }).click();
  await expect(warning).toHaveCount(0);
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveText("Open");
});
