import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/*
 * H10 Reasoned no (#515 lane 2): the Disqualify form with its basis and live line, the
 * decision chip, the Why not panel (drafts, edit, copy, mark sent, skip, Tell them in Oracle,
 * Loop closed), the merge picker's declined requests (asked again), Won't do with and
 * without a note, theme problems, roles and the phone, driven through the UI as a person
 * would on the mock API ("requests-why-not" scenario, made-up askers, Company zone
 * America/Los_Angeles, the clock at Oct 23, 2026).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const ROOT = "Export every board at once";
const NOW = new Date("2026-10-23T17:00:00Z");

async function open(page: Page, email?: string) {
  await page.clock.install({ time: NOW });
  await page.addInitScript((key) => localStorage.setItem(key, "requests-why-not"), MOCK_SCENARIO_KEY);
  await login(page, email);
  await goRequests(page);
}

async function goRequests(page: Page) {
  // On a phone the rail is a menu: open Requests by its address there.
  const nav = page.getByTestId("nav-requests").filter({ visible: true });
  if (await nav.count()) await nav.first().click();
  else await page.goto("/requests");
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("request-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("request-inspector");
const whyNot = (page: Page) => page.getByTestId("why-not");
const reply = (page: Page, asker: string) => whyNot(page).getByTestId("reply").filter({ hasText: asker });

async function pick(page: Page, title: string) {
  await row(page, title).getByRole("button", { name: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
}

/** Disqualify the selected request on the stop list, as the form preselects it. */
async function sayNoOnStopList(page: Page) {
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "On the stop list" });
  await expect(panel.getByLabel("Stop choice")).toHaveValue(/.+/);
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(panel.getByTestId("decision-chip")).toHaveText(/^D-\d+ Say no to Export every board at once$/);
}

test("Say no on the stop list: decision chip, drafts for 3 askers, edit, copy, sent, skip, Tell them in Oracle, Loop closed", async ({ page, context }) => {
  // protects=#515 11a-11d (a no logs a decision and drafts one reply per asker; the promise
  // warning; every reply action; Loop closed; the Inbox rows); fails_when=the stop choice is
  // not preselected, the count of askers is wrong, no D-number shows, drafts never appear,
  // the warning does not follow the words, the loop does not close or the member's Inbox has
  // no answer, or the answer row has no Open, or stays after it (Train N, owner 2026-10-24);
  // no_claim=the real why_not_reply job's words or the API's role checks.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "approver@example.com");
  await pick(page, ROOT);
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "On the stop list" });
  await expect(panel.getByLabel("Stop choice").locator("option:checked")).toHaveText("Stop custom exports");
  await expect(panel.getByTestId("disqualify-line")).toHaveText("A decision is logged and Oracle will draft a reply to the 3 people who asked");
  await panel.getByRole("button", { name: "Disqualify request" }).click();

  await expect(panel.getByTestId("decision-chip")).toHaveText(/^D-\d+ Say no to Export every board at once$/);
  await expect(whyNot(page)).toContainText("Drafting the replies…");
  await expect(whyNot(page).getByTestId("reply")).toHaveCount(3);
  await expect(whyNot(page)).not.toContainText("Drafting the replies…", { timeout: 10_000 });
  await expect(reply(page, "An ops lead at a customer")).toContainText('"Export every board at once"');
  await expect(reply(page, "A finance manager at a shop")).toBeVisible();
  await expect(reply(page, "Commenter")).toBeVisible();

  // 11b: a promise in a person's words is flagged; taking it out clears the flag.
  const ops = reply(page, "An ops lead at a customer");
  await ops.getByRole("button", { name: "Edit" }).click();
  const text = ops.getByLabel("Reply to An ops lead at a customer");
  await text.fill(`${await text.inputValue()} We may look at it again maybe next quarter.`);
  await ops.getByRole("button", { name: "Save" }).click();
  await expect(ops.getByTestId("promise-warning")).toHaveText("Sounds like a promise");
  await ops.getByRole("button", { name: "Edit" }).click();
  await text.fill((await text.inputValue()).replace(" We may look at it again maybe next quarter.", ""));
  await ops.getByRole("button", { name: "Save" }).click();
  await expect(ops.getByTestId("promise-warning")).toHaveCount(0);

  // 11c: copy, mark sent by email today, skip with a reason, Tell them in Oracle.
  await ops.getByRole("button", { name: "Copy" }).click();
  await expect(ops).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Export every board at once");
  await ops.getByRole("button", { name: "Mark sent" }).click();
  await ops.getByLabel("Channel").selectOption({ label: "Email" });
  await expect(ops.getByLabel("Day")).toHaveValue("2026-10-23");
  await ops.getByRole("button", { name: "Save as sent" }).click();
  await expect(ops).toContainText("Sent · Email · Oct 23");

  // The decider has a Replies to send row while replies are open.
  await page.goto("/inbox");
  await expect(page.getByTestId("request-need").filter({ hasText: "Replies to send · 2 · Export every board at once" })).toBeVisible();
  await goRequests(page);
  await pick(page, ROOT);

  const finance = reply(page, "A finance manager at a shop");
  await finance.getByRole("button", { name: "Skip" }).click();
  await finance.getByLabel("Why skip it").fill("Asked anonymously");
  await finance.getByRole("button", { name: "Skip reply" }).click();
  await expect(finance).toContainText("Skipped · Asked anonymously");
  await expect(reply(page, "An ops lead at a customer").getByRole("button", { name: "Tell them in Oracle" })).toHaveCount(0);
  const member = reply(page, "Commenter");
  await member.getByRole("button", { name: "Tell them in Oracle" }).click();
  await expect(member).toContainText("Told in Oracle");
  await expect(panel.getByTestId("loop-closed")).toHaveText("Loop closed · Oct 23");

  // The row is gone from every state, not only moved off New.
  await page.goto("/inbox");
  const tabs = page.getByTestId("inbox-state-tabs");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toBeVisible();
  for (const tab of [/^New/, /^Seen/, /^Done/]) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(page.getByTestId("request-need").filter({ hasText: "Replies to send" })).toHaveCount(0);
  }

  // 11d: the member who asked reads the answer in their Inbox.
  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const answer = page.getByTestId("request-need").filter({ hasText: "Answer to your request · Download all my boards" });
  await expect(answer).toBeVisible();
  await expect(page.getByTestId("request-answer").filter({ hasText: '"Download all my boards"' })).toBeVisible();

  // Train N (owner 2026-10-24): the row stays until its Open, which opens the request and
  // marks the answer opened; then it is gone from every state, after a reload too. Seen once,
  // the row moves from New to Open, so each state tab is read.
  const answers = async () => {
    let n = 0;
    for (const tab of [/^New/, /^Seen/, /^Done/]) {
      await tabs.getByRole("tab", { name: tab }).click();
      n += await answer.count();
    }
    return n;
  };
  await page.reload();
  await expect(tabs.getByRole("tab", { name: /^New/ })).toBeVisible();
  expect(await answers()).toBe(1);
  await tabs.getByRole("tab", { name: /^New/ }).click();
  if (!(await answer.count())) await tabs.getByRole("tab", { name: /^Seen/ }).click();
  const answerRow = page.locator("tr, li, [role=row]").filter({ has: answer }).last();
  await answerRow.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/requests\?request=/);
  await expect(inspector(page)).toContainText("Download all my boards");
  await page.goto("/inbox");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toBeVisible();
  expect(await answers()).toBe(0);
  await page.reload();
  await expect(tabs.getByRole("tab", { name: /^New/ })).toBeVisible();
  expect(await answers()).toBe(0);
});

test("Asked again: merging a New request into a declined one drafts its asker's reply", async ({ page }) => {
  // protects=#515 11e (the merge picker lists a declined request with its day and decision;
  // merging into it drafts the new asker's reply under the same decision and counts asked
  // again); fails_when=the declined request is missing from the picker, no reply is created
  // or the counter stays at 0; no_claim=the Inbox alert at the threshold (API tests).
  await open(page, "approver@example.com");
  await pick(page, ROOT);
  await sayNoOnStopList(page);
  const decision = (await inspector(page).getByTestId("decision-chip").textContent())!;

  await pick(page, "Export one board to CSV");
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Merge", exact: true }).click();
  await panel.getByLabel("Merge into").selectOption({ label: `${ROOT} · Said no on Oct 23 · ${decision}` });
  await panel.getByRole("button", { name: "Merge request" }).click();
  await expect(row(page, "Export one board to CSV")).toContainText("Merged");

  await pick(page, ROOT);
  await expect(panel.getByTestId("asked-again")).toHaveText("Asked again 1");
  await expect(whyNot(page).getByTestId("reply")).toHaveCount(4);
  await expect(reply(page, "A support lead at a studio")).toContainText('"Export one board to CSV"', { timeout: 10_000 });
});

test("Won't do without a note logs nothing; with a note it is a no", async ({ page }) => {
  // protects=#515 11e2 and 11e3 (the live line follows the note; Won't do with no note shows
  // the request declined with no D-number and no Why not panel, and adds no decision; with a
  // note it does both); fails_when=the line does not change with the note, a decision or
  // panel appears without a note, or none appears with one; no_claim=the API's audit event.
  await open(page, "approver@example.com");
  await pick(page, "Print a board as a poster");
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Won't do" });
  const line = panel.getByTestId("disqualify-line");
  await expect(line).toHaveText("No note: no decision is logged and no replies are drafted");
  await panel.getByLabel("Note").fill("Not part of the product we sell");
  await expect(line).toHaveText("A decision is logged and Oracle will draft a reply to the 1 person who asked");
  await panel.getByLabel("Note").fill("");
  await expect(line).toHaveText("No note: no decision is logged and no replies are drafted");
  await panel.getByLabel("Reason").selectOption({ label: "Duplicate" });
  await expect(line).toHaveCount(0);
  await panel.getByLabel("Reason").selectOption({ label: "Won't do" });
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(row(page, "Print a board as a poster")).toContainText("Disqualified");
  await expect(panel).toContainText("Won't do");
  await expect(panel.getByTestId("no-reply-reason")).toHaveText("No note: no decision was logged and no replies were drafted");
  await expect(panel.getByTestId("decision-chip")).toHaveCount(0);
  await expect(whyNot(page)).toHaveCount(0);

  // 11e3: Won't do with a note is a no like the others.
  await pick(page, "Animated board backgrounds");
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Won't do" });
  await panel.getByLabel("Note").fill("Not part of the product we sell");
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(panel.getByTestId("decision-chip")).toHaveText(/^D-\d+ Say no to Animated board backgrounds$/);
  await expect(reply(page, "Unnamed asker")).toContainText(/not part of the product we sell/i, { timeout: 10_000 });

  await page.goto("/company/decisions?state=all");
  await expect(page.getByTestId("decision-row").filter({ hasText: "Say no to Animated board backgrounds" })).toHaveCount(1);
  await expect(page.getByTestId("decision-row").filter({ hasText: "Say no to Print a board as a poster" })).toHaveCount(0);
});

test("Themes: confirm Oracle's suggested problem; the inspector shows it", async ({ page }) => {
  // protects=#515 11f (a suggested problem is confirmed from the Themes tab and then shows
  // the problem and its definition of success, also on a request of that theme);
  // fails_when=Confirm is missing or the confirmed problem does not show; no_claim=triage's
  // import of the suggestion (API tests).
  await open(page, "approver@example.com");
  await page.getByRole("button", { name: /^Themes/ }).click();
  const theme = page.getByTestId("theme-row").filter({ hasText: "Board exports" });
  await expect(theme.getByTestId("theme-problem")).toContainText("Oracle suggests");
  await theme.getByRole("button", { name: "Confirm" }).click();
  await expect(theme.getByTestId("theme-problem")).not.toContainText("Oracle suggests");
  await expect(theme.getByTestId("theme-problem")).toContainText("Finance leads need every board's totals");
  await expect(theme.getByTestId("theme-problem")).toContainText("How we would know it is solved");
  await expect(theme.getByTestId("theme-problem")).toContainText("A month-end report takes minutes, not an afternoon.");

  await page.getByRole("button", { name: /^Queue/ }).click();
  await pick(page, ROOT);
  await expect(inspector(page).getByTestId("theme-problem")).toContainText("Finance leads need every board's totals");
});

test("A viewer reads the Why not panel and the problem with no controls", async ({ page }) => {
  // protects=#515 11g (#370: controls a role cannot use are absent, not disabled);
  // fails_when=a viewer sees Edit, Copy, Mark sent, Skip, Disqualify or Confirm;
  // no_claim=the API's 403s.
  await open(page, "approver@example.com");
  await pick(page, ROOT);
  await sayNoOnStopList(page);
  await expect(whyNot(page).getByTestId("reply").first()).toContainText("Export every board at once", { timeout: 10_000 });
  await signOut(page);
  await login(page, "viewer@example.com");
  await goRequests(page);
  await pick(page, ROOT);
  await expect(whyNot(page).getByTestId("reply")).toHaveCount(3);
  await expect(inspector(page).getByTestId("theme-problem")).toContainText("Oracle suggests");
  for (const name of ["Edit", "Copy", "Mark sent", "Skip", "Tell them in Oracle", "Disqualify", "Confirm", "Draft again with Oracle"]) {
    await expect(inspector(page).getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await page.getByRole("button", { name: /^Themes/ }).click();
  await expect(page.getByTestId("theme-row").filter({ hasText: "Board exports" }).getByRole("button", { name: "Confirm" })).toHaveCount(0);
});

test("Replies to send filter, and Oracle's decline suggestion opens the form prefilled", async ({ page }) => {
  // protects=#515 the Replies to send filter and "Oracle suggests saying no" with Use this;
  // fails_when=the filter keeps requests with nothing to send, or Use this disqualifies on
  // its own or does not prefill the reason; no_claim=triage's decline (API tests).
  await open(page, "approver@example.com");
  await pick(page, "Seasonal board colours");
  const panel = inspector(page);
  await expect(panel.getByTestId("decline-suggestion")).toHaveText(/Oracle suggests saying no: Too few would use it · One person has asked for it in a year/);
  await panel.getByRole("button", { name: "Use this" }).click();
  await expect(panel.getByLabel("Reason")).toHaveValue("few_customers");
  await expect(row(page, "Seasonal board colours")).toContainText("New");

  await pick(page, ROOT);
  await sayNoOnStopList(page);
  await page.getByTestId("request-filters").getByLabel("Replies to send").check();
  await expect(page.getByTestId("request-row")).toHaveText([new RegExp(ROOT)]);
});

test("Phone: the Why not panel stacks with no horizontal scroll", async ({ page }) => {
  // protects=#515 11h; fails_when=the panel or the page scrolls sideways at 390 px;
  // no_claim=other phone widths.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "approver@example.com");
  await pick(page, ROOT);
  await sayNoOnStopList(page);
  await expect(reply(page, "An ops lead at a customer")).toContainText('"Export every board at once"', { timeout: 10_000 });
  await whyNot(page).scrollIntoViewIfNeeded();
  const widths = await whyNot(page).evaluate((el) => ({ panel: el.scrollWidth - el.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth }));
  expect(widths).toEqual({ panel: 0, page: 0 });
});

test("Reopen, then Won't do with no note: no reversed D-number and no Why not panel", async ({ page }) => {
  // protects=#515 "a request declined without a note" after an earlier logged no (#532
  // review: only a standing decided decision shows); fails_when=the reversed decision's chip
  // or the Why not panel shows beside "No note"; no_claim=the API (its own tests).
  await open(page, "approver@example.com");
  await pick(page, "Print a board as a poster");
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Won't do" });
  await panel.getByLabel("Note").fill("Not part of the product we sell");
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(panel.getByTestId("decision-chip")).toHaveText(/^D-\d+ Say no to Print a board as a poster$/);
  await panel.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(row(page, "Print a board as a poster")).toContainText("New");

  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Won't do" });
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(row(page, "Print a board as a poster")).toContainText("Disqualified");
  await expect(panel.getByTestId("no-reply-reason")).toHaveText("No note: no decision was logged and no replies were drafted");
  await expect(panel.getByTestId("decision-chip")).toHaveCount(0);
  await expect(whyNot(page)).toHaveCount(0);
});

test("Draft again with Oracle reads Drafting the replies… and holds the button until the job ends", async ({ page }) => {
  // protects=#515 Draft again with Oracle on replies that already have words (#532 review);
  // fails_when=no Drafting line shows, or the button can be clicked again while the job
  // runs (a 409); no_claim=the real job's words.
  await open(page, "approver@example.com");
  await pick(page, ROOT);
  await sayNoOnStopList(page);
  await expect(whyNot(page)).not.toContainText("Drafting the replies…", { timeout: 10_000 });
  const again = whyNot(page).getByRole("button", { name: "Draft again with Oracle" });
  await again.click();
  await expect(whyNot(page)).toContainText("Drafting the replies…");
  await expect(again).toBeDisabled();
  await expect(whyNot(page)).not.toContainText("Drafting the replies…", { timeout: 10_000 });
  await expect(again).toBeEnabled();
  await expect(whyNot(page).getByRole("alert")).toHaveCount(0);
});

test("Asked again in the Inbox: Keep the no takes the person's own note", async ({ page }) => {
  // protects=#515 "Keep the no: records an H1 review with verdict reaffirmed and the
  // person's note" from the Inbox row (#532 review); fails_when=a fixed note is recorded or
  // the row stays; no_claim=the threshold setting.
  await open(page, "approver@example.com");
  await pick(page, ROOT);
  await sayNoOnStopList(page);
  const decision = (await inspector(page).getByTestId("decision-chip").textContent())!;
  for (const title of ["Print a board as a poster", "Animated board backgrounds", "Export one board to CSV"]) {
    await pick(page, title);
    await inspector(page).getByRole("button", { name: "Merge", exact: true }).click();
    await inspector(page).getByLabel("Merge into").selectOption({ label: `${ROOT} · Said no on Oct 23 · ${decision}` });
    await inspector(page).getByRole("button", { name: "Merge request" }).click();
    await expect(row(page, title)).toContainText("Merged");
  }

  await page.goto("/inbox");
  const need = page.locator("tr, li, [role=row]").filter({ has: page.getByTestId("request-need").filter({ hasText: `Asked again 3 times since you said no · ${ROOT}` }) }).last();
  await expect(need).toBeVisible();
  await need.getByRole("button", { name: "Keep the no" }).click();
  await need.getByLabel("Why keep the no").fill("Still on the stop list; one board exports today");
  await need.getByRole("button", { name: "Keep the no" }).click();
  await expect(page.getByTestId("request-need").filter({ hasText: "Asked again" })).toHaveCount(0);

  await page.goto("/company/decisions?state=all");
  await page.getByTestId("decision-row").filter({ hasText: `Say no to ${ROOT}` }).click();
  await expect(page.getByTestId("decision-inspector").filter({ visible: true })).toContainText("Still on the stop list; one board exports today");
});

test("The promise check leaves 24/7 and the asker's quoted later alone, and flags the company's own", async ({ page }) => {
  // protects=#515 criterion 3 without false warnings (#532 review: whole words, the asker's
  // quoted words skipped); fails_when="24/7" or the asker's quoted "later" warns, or a
  // promise of the company's own passes; no_claim=every way to promise.
  const TITLE = "Remind me later about boards";
  await open(page, "approver@example.com");
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill("Asked on a call");
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(inspector(page).getByRole("heading", { name: TITLE })).toBeVisible();
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "No goal" });
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  const theirs = whyNot(page).getByTestId("reply");
  await expect(theirs).toContainText(`"${TITLE}"`, { timeout: 10_000 });
  await expect(whyNot(page)).not.toContainText("Drafting the replies…", { timeout: 10_000 });
  await expect(theirs.getByTestId("promise-warning")).toHaveCount(0);
  await theirs.getByRole("button", { name: "Edit" }).click();
  const text = theirs.getByRole("textbox");
  await text.fill(`${await text.inputValue()} Our support team answers 24/7.`);
  await theirs.getByRole("button", { name: "Save" }).click();
  await expect(theirs).toContainText("answers 24/7");
  await expect(theirs.getByTestId("promise-warning")).toHaveCount(0);
  // The saved reply is read again (a new lock_version); edit once it has settled.
  await expect(async () => {
    await theirs.getByRole("button", { name: "Edit" }).click();
    await expect(text).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await text.fill(`${await text.inputValue()} We may build it later.`);
  await theirs.getByRole("button", { name: "Save" }).click();
  await expect(theirs.getByTestId("promise-warning")).toHaveText("Sounds like a promise");
});
