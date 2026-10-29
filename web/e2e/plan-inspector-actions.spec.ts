import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { TRACK_ALERTS_ACTIONS_SCENARIO, TRACK_ALERTS_SCENARIO } from "../lib/api/mock/roadmap";
import { login, signOut } from "./helpers";

/*
 * The Plan inspector's owed pieces, driven through the UI on the mock layer
 * (NEXT_PUBLIC_API_MOCKS=1): F2's Ask, Discuss, Open blocker and Link to item on the alert
 * cards, F1 §8's tracker events in the item's history, and H1's Record a decision from a Plan
 * item. The "track-alerts" scenario seeds ENG-405's slip on "Daily alert digest email"; the
 * "track-alerts-actions" scenario adds a blocker on "Alerts in the team chat" and a GitHub
 * issue on the track that no item names. Which actions the API offers whom is proven by
 * api/tests/test_track_alerts.py.
 */

const SLIP = "Daily alert digest email";

async function scenario(page: Page, name: string, role?: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
  if (role) await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });
const cards = (page: Page) => inspector(page).getByTestId("plan-alert");

async function openItem(page: Page, title: string) {
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: title }).getByTestId("plan-title").click();
  await expect(inspector(page)).toContainText(title);
}

// protects = the slip card offers Ask, and Ask sends the question about the item to the person
// picked, whose Inbox row names the item and opens the Plan on it; fails_when = no Ask button,
// the question is refused, or the row names another subject; no_claim = who the API offers Ask
// to (pytest) or the answer's path back.
test("Ask on the slip card asks a teammate about the item; their Inbox row names it", async ({ page }) => {
  const question = "Can ENG-405 still make Beta if we cut the digest's settings?";
  await scenario(page, TRACK_ALERTS_SCENARIO);
  await login(page);
  await openItem(page, SLIP);
  const slip = cards(page).filter({ hasText: "ENG-405 moved to Dec 9" });
  await slip.getByRole("button", { name: "Ask", exact: true }).click();
  const ask = inspector(page).getByTestId("ask-teammate");
  await expect(ask).toContainText(`Ask a teammate about “${SLIP}”`);
  await ask.getByLabel("Find a person").fill("comm");
  await ask.getByRole("option", { name: /Commenter/ }).click();
  await ask.getByLabel("Question").fill(question);
  await ask.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(ask).toContainText("Asked Commenter");

  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const row = page.locator("tr[data-row]").filter({ visible: true }).filter({ hasText: question });
  await expect(row).toContainText(`Usage alerts PRD · ${SLIP}`);
  // Open names the PRD too (two PRDs may share an item key) and selects the item.
  await row.getByRole("link", { name: `Open Usage alerts PRD · ${SLIP}` }).click();
  await expect(page).toHaveURL(/\/plan\?prd=[0-9a-f-]+&item=alert-digest$/);
  await expect(inspector(page)).toContainText(SLIP);
});

// protects = #598 review, decided 2026-10-25 "Pre-fill the only lead": with exactly one
// engineering lead, Ask on the slip card opens with that lead as the person to ask, and the
// question reaches them; with two leads the person is left for the asker to pick; fails_when =
// the form opens empty with one lead, or names a lead while there are two; no_claim = who sees
// the suggestion (pytest: only the server decides it, never from the people directory).
test("Ask on the slip card pre-fills the engineering lead when there is exactly one", async ({ page }) => {
  const leadBox = (email: string) => page.getByRole("checkbox", { name: `Engineering lead: ${email}` });
  await scenario(page, TRACK_ALERTS_SCENARIO);
  await login(page);
  await page.goto("/settings/members");
  await leadBox("approver@example.com").check();
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("1");

  await openItem(page, SLIP);
  const slip = cards(page).filter({ hasText: "ENG-405 moved to Dec 9" });
  await slip.getByRole("button", { name: "Ask", exact: true }).click();
  const ask = inspector(page).getByTestId("ask-teammate");
  // The person is set (with Change), not a picker to search.
  await expect(ask.getByRole("button", { name: "Change" })).toBeVisible();
  await expect(ask).toContainText("Approverapprover@example.com");
  await expect(ask.getByLabel("Find a person")).toHaveCount(0);
  await ask.getByLabel("Question").fill("Does ENG-405's new date hold?");
  await ask.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(ask).toContainText("Asked Approver");

  // A second lead: nobody is pre-filled.
  await page.goto("/settings/members");
  await leadBox("commenter@example.com").check();
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("2");
  await openItem(page, SLIP);
  await cards(page).filter({ hasText: "ENG-405 moved to Dec 9" }).getByRole("button", { name: "Ask", exact: true }).click();
  const again = inspector(page).getByTestId("ask-teammate");
  await expect(again.getByLabel("Find a person")).toBeVisible();
  await expect(again.getByRole("button", { name: "Change" })).toHaveCount(0);
});

// protects = Discuss on the slip card starts a discussion on the item, titled after it, and a
// commenter (who cannot accept or keep) still gets Ask and Discuss; fails_when = no Discuss, the
// discussion is about something else, or a commenter sees Accept new date; no_claim = Oracle's
// reply (discussion specs).
test("Discuss on the slip card starts a discussion on the item; a commenter gets Ask and Discuss only", async ({ page }) => {
  await scenario(page, TRACK_ALERTS_SCENARIO, "commenter");
  await login(page);
  await openItem(page, SLIP);
  const slip = cards(page).filter({ hasText: "ENG-405 moved to Dec 9" });
  await expect(slip.getByRole("button")).toHaveText(["Ask", "Discuss"]);
  await slip.getByRole("button", { name: "Discuss" }).click();
  const sheet = page.getByRole("dialog", { name: `Discuss ${SLIP}` });
  const form = sheet.getByTestId("start-discussion");
  await expect(form.getByRole("textbox", { name: "Title" })).toHaveValue(`Usage alerts PRD · ${SLIP}`);
  await form.getByRole("textbox", { name: "First message" }).fill("Is a week's slip fine for the beta customers?");
  await form.getByRole("button", { name: "Start discussion" }).click();
  await expect(sheet.getByTestId("discussion-thread").getByTestId("discussion-message").filter({ hasText: "a week's slip" })).toHaveCount(1);
});

// protects = a blocked item's card opens its blocker in Baseline; fails_when = no Open blocker,
// or it opens another page; no_claim = the Baseline blocker view itself.
test("Open blocker on a blocked item's card opens the blocker in Baseline", async ({ page }) => {
  await scenario(page, TRACK_ALERTS_ACTIONS_SCENARIO, "viewer");
  await login(page);
  await openItem(page, "Alerts in the team chat");
  const blocked = cards(page).filter({ hasText: "Chat app review takes two weeks (open)" });
  await expect(blocked.getByRole("link")).toHaveText(["Open blocker"]);
  await blocked.getByRole("link", { name: "Open blocker" }).click();
  await expect(page).toHaveURL(/\/baseline\?tab=blockers&blocker=[0-9a-f-]+$/);
});

// protects = an issue on the track that no item names shows on the track's items with Link to
// item, which opens F7's Link issue dialog searching for that issue, and links it to the item;
// fails_when = the alert is not shown, or the dialog opens empty or links elsewhere; no_claim =
// the API's link rules (test_tracker_links.py).
test("Link to item opens Link issue for the track's unplanned issue and links it here", async ({ page }) => {
  await scenario(page, TRACK_ALERTS_ACTIONS_SCENARIO);
  await login(page);
  await openItem(page, "Usage dashboard");
  const track = inspector(page).getByTestId("plan-track-alerts");
  const unplanned = track.getByTestId("plan-alert").filter({ hasText: "acme/app#425 (Usage dashboard charts) is not on the roadmap" });
  await unplanned.getByRole("button", { name: "Link to item" }).click();
  const dialog = page.getByRole("dialog", { name: "Link a GitHub issue to Usage dashboard" });
  await expect(dialog.getByRole("searchbox", { name: "Search your GitHub issues" })).toHaveValue("acme/app#425");
  await dialog.getByTestId("link-issue-result").filter({ hasText: "acme/app#425 · Usage dashboard charts" }).click();
  await dialog.getByRole("button", { name: "Link", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(inspector(page).getByTestId("plan-record")).toContainText("acme/app#425");
});

// protects = the item's history lists its tracker events in plain words with the Plan's dates;
// fails_when = the History shows only roadmap versions; no_claim = which imports write events
// (pytest).
test("the item's history lists ENG-405 moving from Nov 30 to Dec 9", async ({ page }) => {
  await scenario(page, TRACK_ALERTS_SCENARIO, "viewer");
  await login(page);
  await openItem(page, SLIP);
  const events = inspector(page).getByTestId("plan-history").getByTestId("plan-tracker-event");
  await expect(events).toHaveText(["ENG-405: date Nov 30 → Dec 9 · Oct 20"]);
  await expect(inspector(page).getByTestId("plan-tracker-older")).toHaveCount(0);
});

// protects = #577 review MAJOR 1: one line per import, naming every field it changed, and only
// the newest 20 imports, with how many earlier ones are left out; fails_when = the slip import's
// state and date are two lines, or all 23 imports are listed; no_claim = the API's grouping and
// limit (pytest test_track_alerts.py).
test("the item's history shows one line per import, the newest 20, and says how many are left out", async ({ page }) => {
  await scenario(page, "track-alerts-history", "viewer");
  await login(page);
  await openItem(page, SLIP);
  const history = inspector(page).getByTestId("plan-history");
  const events = history.getByTestId("plan-tracker-event");
  await expect(events).toHaveCount(20);
  await expect(events.first()).toHaveText("ENG-405: estimate 4 → 5 · Oct 1");
  await expect(events.last()).toHaveText("ENG-405: Open → In progress, date Nov 30 → Dec 9 · Oct 20");
  await expect(history.getByTestId("plan-tracker-older")).toHaveText("3 earlier tracker updates aren't shown.");
});

// protects = H1's entry point: Record a decision on a Plan item opens Propose decision about
// that item, and the log opened for it lists the proposal; fails_when = the subject is lost,
// or a viewer is offered it; no_claim = the decision log's own rules (decisions.spec.ts).
test("Record a decision on a Plan item opens Propose decision about the item", async ({ page, browser }) => {
  await scenario(page, TRACK_ALERTS_SCENARIO, "commenter");
  await login(page);
  await openItem(page, SLIP);
  await inspector(page).getByRole("link", { name: "Record a decision" }).click();
  await expect(page).toHaveURL(/\/company\/decisions\?subject=roadmap_item/);
  const dialog = page.getByRole("dialog", { name: "Propose decision" });
  // The dialog lists what the decision is about in its About picker (#628's links pickers).
  const about = dialog.getByRole("group", { name: "About" }).getByRole("listitem");
  await expect(about).toHaveCount(1);
  await expect(about).toContainText(`Roadmap item ${SLIP}`);
  await dialog.getByLabel("Decision", { exact: true }).fill("Ship the digest after Beta");
  await dialog.getByLabel("Option 1", { exact: true }).fill("Move Beta to Dec 9");
  await dialog.getByLabel("Option 2", { exact: true }).fill("Ship Beta without the digest");
  await dialog.getByLabel("Approver", { exact: true }).selectOption({ label: "Approver · approver@example.com" });
  await dialog.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("decision-inspector").filter({ visible: true })).toContainText(`Roadmap item ${SLIP}`);

  const viewer = await browser.newPage();
  await scenario(viewer, TRACK_ALERTS_SCENARIO, "viewer");
  await login(viewer);
  await openItem(viewer, SLIP);
  await expect(inspector(viewer).getByRole("link", { name: "Record a decision" })).toHaveCount(0);
  await viewer.close();
});
