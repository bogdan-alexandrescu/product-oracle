import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * #348 Requests queue: the queue's filters, the inspector's actions (edit, link, qualify,
 * merge, disqualify, reopen, accept or decline Oracle's suggestion) and the Themes tab,
 * driven through the UI as a person would, on the mock API. Synthetic placeholders only.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const TITLE = "Reorder a past basket in one click";
const WHY = "Buyers order the same things every week and build the basket again by hand each time.";

async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("request-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("request-inspector");
const filter = (page: Page, name: string) => page.getByTestId("request-filters").getByLabel(name, { exact: true });

async function pick(page: Page, title: string) {
  await row(page, title).getByRole("button", { name: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
}

test("Queue: filters by state, goal and theme, searches, and shows a filed request", async ({ page }) => {
  // protects=#348 Build 1 and Done when (the queue's columns and filters; New request's
  // requests show up in it); fails_when=a filter keeps rows it should drop, a column is
  // missing, or a filed request is not in the queue; no_claim=the real API's filters.
  await login(page);
  await openRequests(page);
  const address = row(page, "Keep the delivery address between orders");
  await expect(address).toContainText("Qualified");
  await expect(address).toContainText("Faster check-out");
  await expect(address).toContainText("Support");
  await expect(address).toContainText("A buyer at a retail customer");
  await expect(address.getByTestId("request-age")).toHaveText("20d");
  await expect(address.getByTestId("goal-chip")).toHaveCount(1);

  await filter(page, "State").selectOption("qualified");
  await expect(page.getByTestId("request-row")).toHaveCount(4);
  await filter(page, "Theme").selectOption({ label: "Team sharing" });
  await expect(page.getByTestId("request-row")).toHaveCount(2);
  await filter(page, "State").selectOption("");
  await filter(page, "Theme").selectOption("");
  await filter(page, "Goal").selectOption({ label: "Raise activation" });
  await expect(row(page, "Weekly summary email")).toBeVisible();
  await expect(row(page, "Invite a whole team at once")).toHaveCount(0);
  await filter(page, "Goal").selectOption("");
  await filter(page, "Search requests").fill("dark");
  await expect(page.getByTestId("request-row")).toHaveText([/Dark mode/]);
  await filter(page, "Search requests").fill("");

  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(row(page, TITLE)).toHaveAttribute("aria-current", "true");
  await expect(row(page, TITLE).getByTestId("request-age")).toHaveText("today");
  await expect(inspector(page).getByRole("heading", { name: TITLE })).toBeVisible();
  await filter(page, "State").selectOption("new");
  await expect(row(page, TITLE)).toBeVisible();
});

test("Inspector: the filer edits a New request's words", async ({ page }) => {
  // protects=#348 Build 2 (edit); fails_when=Edit is missing for the filer or the new
  // title is not saved; no_claim=the API's filer rule.
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "New request" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();

  await inspector(page).getByRole("button", { name: "Edit" }).click();
  await inspector(page).getByLabel("Title").fill("Reorder last week's basket");
  await inspector(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(inspector(page).getByRole("heading", { name: "Reorder last week's basket" })).toBeVisible();
  await page.reload();
  await expect(row(page, "Reorder last week's basket")).toBeVisible();
});

test("Inspector: link goals, theme, feature and PRD, then qualify with a reason", async ({ page }) => {
  // protects=#348 Build 2 (link; Qualify with a reason; a state block is disabled with its
  // reason); fails_when=links are not saved or the request does not qualify;
  // no_claim=the API's confirmed-goal rule.
  await login(page);
  await openRequests(page);
  await pick(page, "Dark mode");
  const panel = inspector(page);
  await panel.getByRole("checkbox", { name: "Raise activation" }).check();
  await panel.getByRole("combobox", { name: "Theme", exact: true }).selectOption({ label: "Reporting" });
  await panel.getByLabel("Feature").selectOption({ label: "Dark mode" });
  await panel.getByLabel("PRD").selectOption({ index: 1 });
  await panel.getByRole("button", { name: "Save links" }).click();
  await expect(row(page, "Dark mode").getByTestId("goal-chip")).toHaveText(["Raise activation"]);
  await expect(row(page, "Dark mode")).toContainText("Reporting");

  await panel.getByRole("button", { name: "Qualify", exact: true }).click();
  await panel.getByLabel("Reason").fill("Asked for by every team we spoke to");
  await panel.getByRole("button", { name: "Qualify request" }).click();
  await expect(row(page, "Dark mode")).toContainText("Qualified");
  await expect(panel).toContainText("Asked for by every team we spoke to");
  await expect(panel.getByRole("button", { name: "Qualify", exact: true })).toBeDisabled();
  await expect(panel.getByTestId("decide-reason")).toHaveText("Only a New request can be qualified");
});

test("Inspector: merge into another request, disqualify with a reason, and reopen", async ({ page }) => {
  // protects=#348 Build 2 (Merge, Disqualify, Reopen); fails_when=the state does not
  // change or Reopen does not bring it back to New; no_claim=merge chains (the API's root rule).
  await login(page);
  await openRequests(page);
  await pick(page, "Bulk edit prices");
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Merge", exact: true }).click();
  await panel.getByLabel("Merge into").selectOption({ label: "Export orders to a spreadsheet" });
  await panel.getByRole("button", { name: "Merge request" }).click();
  await expect(row(page, "Bulk edit prices")).toContainText("Merged");
  await panel.getByRole("button", { name: "Reopen" }).click();
  await expect(row(page, "Bulk edit prices")).toContainText("New");

  await pick(page, "Pay by bank transfer");
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  await panel.getByLabel("Reason").selectOption({ label: "Out of scope" });
  await panel.getByLabel("Note").fill("Payments by transfer are not planned");
  await panel.getByRole("button", { name: "Disqualify request" }).click();
  await expect(row(page, "Pay by bank transfer")).toContainText("Disqualified");
  await expect(panel).toContainText("Out of scope");
  await panel.getByRole("button", { name: "Reopen" }).click();
  await expect(row(page, "Pay by bank transfer")).toContainText("New");
});

test("Inspector: accept Oracle's suggestion", async ({ page }) => {
  // protects=#348 Build 2 (accept Oracle's suggestion); fails_when=accepting does not
  // link the suggested goal and theme; no_claim=the triage that writes suggestions.
  await login(page);
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  const suggestion = inspector(page).getByTestId("request-suggestion");
  await expect(suggestion).toContainText("Faster check-out");
  await suggestion.getByRole("button", { name: "Accept suggestion" }).click();
  await expect(row(page, "Save my card for the next order")).toContainText("Faster check-out");
  await expect(row(page, "Save my card for the next order").getByTestId("goal-chip")).toHaveCount(1);
  await expect(inspector(page).getByTestId("request-suggestion")).toHaveCount(0);
});

test("Inspector: decline Oracle's suggestion; it stays declined after a reload", async ({ page }) => {
  // protects=#348 Build 2 (decline Oracle's suggestion); fails_when=the suggestion is
  // still offered or the request gains its goal or theme; no_claim=a later triage run.
  await login(page);
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  await inspector(page).getByTestId("request-suggestion").getByRole("button", { name: "Decline" }).click();
  await expect(inspector(page).getByTestId("request-suggestion")).toHaveCount(0);
  await expect(row(page, "Save my card for the next order").getByTestId("goal-chip")).toHaveCount(0);
  await page.reload();
  await pick(page, "Save my card for the next order");
  await expect(inspector(page).getByTestId("request-suggestion")).toHaveCount(0);
});

test("Themes: create, rename and archive a theme", async ({ page }) => {
  // protects=#348 Build 3; fails_when=a theme cannot be created, renamed or archived;
  // no_claim=the API's unique-title rule.
  await login(page);
  await openRequests(page);
  await page.getByRole("button", { name: "Themes" }).click();
  await page.getByLabel("New theme").fill("Payments");
  await page.getByRole("button", { name: "Create theme" }).click();
  const theme = page.getByTestId("theme-row").filter({ hasText: "Payments" });
  await expect(theme).toBeVisible();
  await theme.getByRole("button", { name: "Rename" }).click();
  // While renaming, the title is in the input, so find the row by its testid.
  const editing = page.getByTestId("theme-row").filter({ has: page.getByLabel("Theme title") });
  await editing.getByLabel("Theme title").fill("Payments and billing");
  await editing.getByRole("button", { name: "Save", exact: true }).click();
  const renamed = page.getByTestId("theme-row").filter({ hasText: "Payments and billing" });
  await expect(renamed).toBeVisible();
  await renamed.getByRole("button", { name: "Archive" }).click();
  await expect(renamed).toContainText("Archived");
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(filter(page, "Theme").locator("option", { hasText: "Payments and billing" })).toHaveCount(0);
});

test("A commenter sees no decisions, links or theme controls", async ({ page }) => {
  // protects=the #370 rule (hide controls a role can't act on); fails_when=a commenter is
  // shown Qualify, Merge, Disqualify, Save links, Accept or Create theme; no_claim=the API's 403s.
  await login(page, "commenter@example.com");
  await openRequests(page);
  await pick(page, "Save my card for the next order");
  const panel = inspector(page);
  for (const name of ["Qualify", "Merge", "Disqualify", "Save links", "Accept suggestion", "Edit"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Themes" }).click();
  await expect(page.getByTestId("theme-row").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create theme" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
});
