import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * B2 Baseline review from this run: the Inbox's Review opens the Baseline filtered to the run
 * (the band, the From this run tab), each row with its reasons and actions; Approve baseline
 * waits until every goal is decided (confirmed, rejected or left proposed with a reason).
 * Driven through the UI over the mock API ("baseline-review" scenario: a Build the baseline
 * run of Oct 20 that created two goals, a feature with low confidence serving no goal, a
 * duplicate of Saved carts, and proposed a change to the locked Guided setup). Made-up data.
 */

const RUN = "7a11c0de-0000-4000-8000-0000000000b2";
const GATE = "2 blocking problems left";

async function seeded(page: Page, scenario = "baseline-review", email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

/** The Inbox row's Review, as a person opens the review. */
async function fromInbox(page: Page) {
  await page.goto("/inbox");
  const row = page.locator("tr[data-row]").filter({ has: page.locator(`a[href="/baseline?run=${RUN}"]`) }).filter({ visible: true });
  await expect(row).toContainText("Confirm the baseline · 4 need you · 2 not decided");
  await row.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(new RegExp(`/baseline\\?run=${RUN}$`));
}

const row = (page: Page, title: string) => page.getByTestId("from-run-row").filter({ hasText: title });
const bar = (page: Page) => page.getByTestId("from-run-bar");

async function leaveProposed(page: Page, title: string, reason: string) {
  await row(page, title).getByRole("button", { name: "Leave proposed…" }).click();
  await row(page, title).getByLabel("Why leave it proposed").fill(reason);
  await row(page, title).getByRole("button", { name: "Leave proposed", exact: true }).click();
  await expect(row(page, title)).toContainText(`Left proposed: ${reason}`);
}

async function lookAgain(page: Page, title: string, note: string) {
  await row(page, title).getByRole("button", { name: `More actions for ${title}` }).click();
  await row(page, title).getByRole("button", { name: "Look again…" }).click();
  await row(page, title).getByLabel("What should the agents look at").fill(note);
  await row(page, title).getByRole("button", { name: "Look again", exact: true }).click();
  await expect(row(page, title).getByTestId("look-again-chip")).toBeVisible();
}

// Card gate-opens: protects = owner call c3 at Baseline confirm: Approve baseline is disabled,
// listing what is left, while goals from the run are undecided, and opens once one is confirmed
// and the other left proposed with a reason; fails_when = Approve is clickable while blocked,
// the rows or chips are wrong, or the band does not say who approved; no_claim = mock layer.
test("the Inbox's Review opens the run's rows, and Approve baseline waits until every goal is decided", async ({ page }) => {
  await seeded(page);
  await fromInbox(page);
  await expect(page.getByTestId("from-run-band")).toContainText("From run · Build the baseline");
  await expect(page.getByRole("tab", { name: /From this run/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("from-run-row")).toHaveCount(4);
  await expect(row(page, "Activate new stores in their first week").getByTestId("reason-chip")).toHaveText(["Not decided"]);
  await expect(row(page, "Bring buyers back").getByTestId("reason-chip")).toHaveText(["Not decided", "Not measurable"]);
  await expect(row(page, "Bring buyers back").getByTestId("reason-chip").nth(1)).toHaveAttribute("title", "Missing: unit, comparison, target, owner");
  await expect(row(page, "Gift notes").getByTestId("reason-chip")).toHaveText(["Low confidence 32", "No evidence", "Serves no goal"]);
  await expect(row(page, "Guided setup").getByTestId("reason-chip")).toHaveText(["Changes a locked item"]);
  await page.getByRole("button", { name: /All from this run/ }).click();
  await expect(page.getByTestId("from-run-row")).toHaveCount(5);
  await expect(row(page, "Carts for later").getByTestId("reason-chip")).toHaveCount(0);
  await page.getByRole("button", { name: /Needs you/ }).click();

  const approve = bar(page).getByRole("button", { name: "Approve baseline" });
  await expect(approve).toBeDisabled();
  await expect(bar(page).getByTestId("bar-gate")).toContainText(GATE);
  await expect(bar(page).getByTestId("bar-gate")).toContainText("Not decided · Bring buyers back");

  // The drawer's Why it needs you card, first, with its fixes.
  await row(page, "Activate new stores in their first week").getByRole("button", { name: "Activate new stores in their first week", exact: true }).click();
  const why = page.getByTestId("entity-drawer").getByTestId("why-card");
  await expect(why).toContainText("nobody decided it");
  await page.getByTestId("entity-drawer").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("band-not-decided")).toHaveText("1 not decided");
  await leaveProposed(page, "Bring buyers back", "Revisit after the board meeting");
  await expect(page.getByTestId("band-not-decided")).toHaveText("0 not decided");
  await expect(bar(page).getByTestId("bar-tally")).toHaveText("3 of 5 handled · 0 not decided");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByTestId("band-decided")).toContainText("Approved by");
  await expect(bar(page)).toHaveCount(0);
});

// Card merge: protects = Merge into… moves a duplicate's evidence into the target and removes
// its row; fails_when = the row stays or the target's evidence count does not grow;
// no_claim = edges and refusals (pytest has them).
test("Merge into… on the duplicate removes its row and the target shows the moved evidence", async ({ page }) => {
  await seeded(page);
  await page.goto(`/baseline?run=${RUN}`);
  const evidence = async () => {
    await page.getByRole("tab", { name: "Graph" }).click();
    await page.getByTestId("feature-f.saved-carts").click();
    const stat = page.getByTestId("entity-drawer").getByText("Evidence", { exact: true }).locator("xpath=ancestor::div[1]");
    await expect(stat).toContainText(/\d/);
    const n = Number((await stat.innerText()).match(/\d+/)![0]);
    await page.getByTestId("entity-drawer").getByRole("button", { name: "Close" }).click();
    await page.getByRole("tab", { name: /From this run/ }).click();
    return n;
  };
  const before = await evidence();
  await page.getByRole("button", { name: /All from this run/ }).click();
  const twin = row(page, "Carts for later");
  await twin.getByRole("button", { name: "More actions for Carts for later" }).click();
  await twin.getByRole("button", { name: "Merge into…" }).click();
  await twin.getByLabel("Merge into").selectOption({ label: "Saved carts" });
  await twin.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByText("Merged “Carts for later” into “Saved carts”.")).toBeVisible();
  await expect(row(page, "Carts for later")).toHaveCount(0);
  await expect(page.getByTestId("from-run-row")).toHaveCount(4);
  expect(await evidence()).toBe(before + 2);
});

// Card proposal: protects = Accept on the run's proposal applies it and shows the result in
// place; fails_when = the row shows no result or keeps Accept; no_claim = B4's sentence.
test("Accept on the proposal row applies it and the row shows ✓ Accepted", async ({ page }) => {
  await seeded(page);
  await page.goto(`/baseline?run=${RUN}`);
  await row(page, "Guided setup").getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: /All from this run/ }).click();
  await expect(row(page, "Guided setup").getByTestId("row-result")).toContainText("✓ Accepted");
  await expect(row(page, "Guided setup").getByRole("button", { name: "Accept" })).toHaveCount(0);
});

// Card send-back: protects = staged look agains go back as one structured note the run page
// shows; fails_when = Send back is offered with nothing staged, or the note misses an item;
// no_claim = what the agents do with it.
test("Look again on two rows then Send back: the band says Sent back and the run page shows the note", async ({ page }) => {
  await seeded(page);
  await page.goto(`/baseline?run=${RUN}`);
  const send = bar(page).getByRole("button", { name: "Send back to agents" });
  await expect(send).toBeDisabled();
  await lookAgain(page, "Activate new stores in their first week", "two sources give different targets");
  await lookAgain(page, "Gift notes", "looks like a duplicate of an older idea");
  await expect(bar(page).getByTestId("bar-look-again")).toHaveCount(2);
  // A look again does not decide a goal: the gate stays closed.
  await expect(page.getByTestId("band-not-decided")).toHaveText("2 not decided");
  await expect(bar(page).getByRole("button", { name: "Approve baseline" })).toBeDisabled();
  await send.click();
  await expect(page.getByTestId("band-decided")).toContainText("Sent back by");
  await page.getByTestId("from-run-band").getByRole("link", { name: "Build the baseline" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}`));
  const note = page.getByTestId("sent-back-note").filter({ visible: true });
  await expect(note).toContainText("Look again at these items:");
  await expect(note).toContainText("- goal g.first-week-stores (Activate new stores in their first week): two sources give different targets");
  await expect(note).toContainText("- feature f.gift-notes (Gift notes): looks like a duplicate of an older idea");
});

// Card commenter: protects = a commenter reads the reasons and may only suggest a look again;
// fails_when = Confirm, Reject, Merge or Leave proposed shows for a commenter; no_claim = viewers
// (the API's 403s are pytest's).
test("a commenter sees the reasons, suggests a Look again, and has no decision controls", async ({ page }) => {
  await seeded(page, "baseline-review", "commenter@example.com");
  await page.goto(`/baseline?run=${RUN}`);
  await expect(row(page, "Bring buyers back").getByTestId("reason-chip").first()).toHaveText("Not decided");
  const main = page.getByRole("tabpanel");
  for (const name of ["Confirm", "Reject", "Leave proposed…", "Merge into…", "Approve baseline"]) {
    await expect(main.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /More actions/ })).toHaveCount(0);
  await row(page, "Gift notes").getByRole("button", { name: "Look again…" }).click();
  await row(page, "Gift notes").getByLabel("What should the agents look at").fill("check the interviews");
  await row(page, "Gift notes").getByRole("button", { name: "Suggest" }).click();
  await expect(row(page, "Gift notes").getByTestId("look-again-chip")).toContainText("Suggested by");
});

// Card reload: protects = every decision and staged action is stored, not page state;
// fails_when = a reload loses one; no_claim = another reviewer's concurrent edits.
test("reload keeps every decision and staged action", async ({ page }) => {
  await seeded(page);
  await page.goto(`/baseline?run=${RUN}`);
  await row(page, "Activate new stores in their first week").getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("band-not-decided")).toHaveText("1 not decided");
  await leaveProposed(page, "Bring buyers back", "After the board meeting");
  await lookAgain(page, "Gift notes", "check the interviews");
  await page.reload();
  await page.getByRole("button", { name: /All from this run/ }).click();
  await expect(row(page, "Activate new stores in their first week").getByTestId("row-result")).toContainText("✓ Rejected");
  await expect(row(page, "Bring buyers back").getByTestId("row-result")).toContainText("Left proposed: After the board meeting");
  await expect(row(page, "Gift notes").getByTestId("look-again-chip")).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Approve baseline" })).toBeEnabled();
});

// Card console-held: protects = D3 "Console gate" at Baseline confirm: a console MERGE given
// while goals are undecided is held in the Inbox, and Confirm stays disabled until the last goal
// is decided; fails_when = Confirm is enabled with a goal undecided; no_claim = the real console.
test("a console approval is held while a goal is undecided, and deciding the last one enables Confirm", async ({ page }) => {
  await seeded(page, "baseline-review-console");
  await page.goto("/inbox");
  const inboxRow = page.locator("tr[data-row]").filter({ has: page.locator(`a[href="/baseline?run=${RUN}"]`) }).filter({ visible: true });
  await expect(inboxRow).toContainText("Console approval held");
  await expect(inboxRow).toContainText("Blocking problems are open: fix or waive them, then confirm");
  await page.goto(`/runs/${RUN}`);
  const decide = page.getByRole("group", { name: "Decide: Confirm the baseline" });
  const confirm = decide.getByRole("button", { name: "Confirm approval" });
  await expect(confirm).toBeDisabled();
  await decide.getByRole("link", { name: /Review in Baseline · 4 need you/ }).click();
  await row(page, "Activate new stores in their first week").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("band-not-decided")).toHaveText("1 not decided");
  await page.goto(`/runs/${RUN}`);
  await expect(confirm).toBeDisabled();
  await page.goto(`/baseline?run=${RUN}`);
  await row(page, "Bring buyers back").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("band-not-decided")).toHaveText("0 not decided");
  await page.goto(`/runs/${RUN}`);
  await expect(confirm).toBeEnabled();
});

// Card subgoal-tree: protects = Subgoals (#469) in the run's rows: a goal moved under another
// in the drawer is listed right after its parent, indented, "Subgoal of …", and stays a goal
// to decide before Approve; fails_when = the rows ignore the tree or the subgoal drops out of
// the gate; no_claim = baseline.yaml writing parents.
test("a subgoal of the run follows its parent goal and still waits to be decided", async ({ page }) => {
  await seeded(page);
  await page.goto(`/baseline?run=${RUN}`);
  const sub = "Activate new stores in their first week";
  await row(page, sub).getByRole("button", { name: sub, exact: true }).click();
  const drawer = page.getByTestId("entity-drawer");
  await drawer.getByLabel("Parent goal").selectOption({ label: "Bring buyers back" });
  await drawer.getByRole("button", { name: "Move", exact: true }).click();
  await drawer.getByRole("button", { name: "Close" }).click();
  const goals = page.getByRole("region", { name: "Goals" }).getByTestId("from-run-row");
  await expect(goals.nth(0)).toContainText("Bring buyers back");
  await expect(goals.nth(1)).toContainText(sub);
  await expect(goals.nth(1).getByTestId("subgoal-of")).toHaveText("Subgoal of Bring buyers back");
  await expect(goals.nth(1).getByTestId("reason-chip").first()).toHaveText("Not decided");
  await goals.nth(0).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("band-not-decided")).toHaveText("1 not decided");
  await expect(bar(page).getByRole("button", { name: "Approve baseline" })).toBeDisabled();
  await expect(bar(page).getByTestId("bar-gate")).toContainText(`Not decided · ${sub}`);
});

// Card phone: protects = at 390 px rows are cards and the bottom bar keeps the tally and
// Approve; fails_when = rows lay out as a table row or the bar loses Approve; no_claim = the sheet.
test("at 390 px rows are cards and the bottom bar shows the tally and Approve", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seeded(page);
  await page.goto(`/baseline?run=${RUN}`);
  await expect(row(page, "Gift notes")).toHaveCSS("flex-direction", "column");
  await expect(bar(page).getByTestId("bar-tally")).toHaveText("1 of 5 handled · 2 not decided");
  await expect(bar(page).getByRole("button", { name: "Approve baseline" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Send back to agents" })).toBeHidden();
});
