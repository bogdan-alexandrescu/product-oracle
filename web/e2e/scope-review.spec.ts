import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { SCOPE_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, signOut } from "./helpers";

/**
 * C7 Scope review: the feature-set stop reviewed row by row at /runs/<id>/review/<checkpoint>,
 * driven through the UI over the mock API ("scope-review" scenario, web/lib/api/mock/runs.ts
 * seedScopeReviewRuns): saved-addresses (attempt 1: Bulk edit depends on the left-out Address
 * book export, Address labels serves no goal, Pick address in one step has a low confidence,
 * and a commenter suggested leaving Edit a saved address out), saved-addresses-next (attempt
 * 2) and address-book (approved in the console while Bulk edit's dependency blocks).
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";

async function seeded(page: Page, email = APPROVER) {
  await page.addInitScript((key) => localStorage.setItem(key, "scope-review"), MOCK_SCENARIO_KEY);
  await login(page, email);
}

/** From the runs list to the run, then its checkpoint row's Review feature set. */
async function openReview(page: Page, slug: string) {
  await page.getByTestId("nav-runs").click();
  await page.locator(`[data-testid="run-row"][data-document="${slug}"]`).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { level: 1, name: "Feature set" })).toBeAttached();
}

const row = (page: Page, title: string) => page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: title }) });
const bar = (page: Page) => page.getByTestId("decision-bar");

// Card c11 (criterion 11): protects = call c3 Blocking problems disable Approve at the feature
// set, and a one-click fix re-checks the set; fails_when = Needs you does not list the three
// seeded rows, Approve is enabled with the blocking dependency open, or Include <dependency>
// leaves the tally, the ✓ or Approve with 1 edit behind; no_claim = the server's gate
// (api/tests/test_scope_review.py).
test("a blocking dependency disables Approve until Include <dependency> fixes it", async ({ page }) => {
  await seeded(page);
  await openReview(page, "saved-addresses");
  await expect(page.getByTestId("scope-for")).toHaveText("For saved-addresses · attempt 1");
  await expect(page.getByRole("button", { name: /^Needs you/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scope-row")).toHaveCount(3);
  const approve = bar(page).getByRole("button", { name: /^Approve/ });
  await expect(approve).toBeDisabled();
  await expect(bar(page).getByTestId("approve-blocked")).toHaveText("1 blocking problem left");
  await expect(approve).toHaveAttribute("title", "1 blocking problem left");

  const bulk = row(page, "Bulk edit");
  await expect(bulk.getByTestId("row-reasons")).toContainText("Depends on a left-out feature");
  await bulk.getByRole("button", { name: "Include Address book export" }).click();
  await expect(bulk.getByTestId("row-done")).toContainText("✓");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("0 blocking left");
  await expect(bar(page).getByRole("button", { name: "Approve with 1 edit" })).toBeEnabled();
});

// Card c12 (criterion 12): protects = Leave out asks why and the change is staged in the bar,
// where removing it is Undo; fails_when = no reason is asked, the chip is missing, or removing
// it leaves the row out; no_claim = the review file a send-back writes.
test("leave out asks a reason, stages a chip, and removing the chip undoes it", async ({ page }) => {
  await seeded(page);
  await openReview(page, "saved-addresses");
  const labels = row(page, "Address labels");
  await expect(labels).toContainText("No goal");
  await labels.getByRole("button", { name: "Leave out", exact: true }).click();
  const why = labels.getByRole("group", { name: "Why leave it out?" });
  await expect(why).toBeVisible();
  await why.getByRole("button", { name: "No goal" }).click();
  await expect(labels.getByTestId("row-done")).toContainText("✓ Left out · No goal");
  const chip = bar(page).getByTestId("staged-chip").filter({ hasText: "Address labels: left out" });
  await expect(chip).toBeVisible();

  await chip.getByRole("button", { name: "Undo Address labels: left out" }).click();
  await expect(chip).toHaveCount(0);
  await expect(labels.getByTestId("row-done")).toHaveCount(0);
  await expect(labels.getByRole("button", { name: "Leave out", exact: true })).toBeVisible();
});

// Card c13 (criterion 13): protects = Enhance on a requirement: Oracle's deeper text shows as
// a suggestion after the job's poll, and Edit and accept writes the person's text to the row;
// fails_when = no suggestion card, or the row keeps the old text; no_claim = the real model's
// enhancement quality.
test("enhance a requirement, then edit and accept the suggestion", async ({ page }) => {
  await seeded(page);
  await openReview(page, "saved-addresses");
  const pick = row(page, "Pick address in one step");
  await pick.getByRole("button", { name: "Requirements of Pick address in one step" }).click();
  const req = pick.getByTestId("requirement-pick-address-one-screen");
  await req.getByRole("button", { name: "Enhance" }).click();
  const card = req.getByTestId("enhance-card");
  await expect(card.getByTestId("enhance-suggestion")).toBeVisible();
  await expect(card.getByTestId("enhance-text")).toContainText("says clearly what happened when it cannot be done");
  await card.getByRole("button", { name: "Edit and accept" }).click();
  const text = "Address and delivery option are chosen on one screen, and a failed lookup keeps what was typed";
  await card.getByRole("textbox", { name: "Requirement text" }).fill(text);
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card).toHaveCount(0);
  await expect(req.getByTestId("requirement-text")).toHaveText(text);
});

// Card c14 (criterion 14): protects = call c2 "Approve with edits" and decision B1 Baseline
// shape: a requirement a person adds is approved without an agent round and lands in the
// baseline as theirs, locked, under its feature; fails_when = the added row is not marked as
// yours, the checkpoint is not approved, or the Baseline graph does not list the requirement
// under its feature, locked; no_claim = the agents' own proposals (unchanged).
test("add a requirement, approve with edits, and the baseline lists it under its feature, locked", async ({ page }) => {
  await seeded(page);
  await openReview(page, "saved-addresses");
  // The blocking dependency first, so Approve is open.
  await row(page, "Bulk edit").getByRole("button", { name: "Include Address book export" }).click();
  await page.getByRole("button", { name: /^All/ }).click();
  await row(page, "Saved addresses").getByTestId("feature-title").click();
  const inspector = page.getByTestId("scope-inspector");
  await expect(inspector).toContainText("Saved addresses");
  await inspector.getByRole("button", { name: "Add requirement" }).click();
  const text = "The buyer sees which saved address was used last";
  await inspector.getByRole("textbox", { name: "Requirement", exact: true }).fill(text);
  await inspector.getByRole("textbox", { name: /Acceptance criteria/ }).fill("The last used address is marked");
  await inspector.getByRole("button", { name: "Add", exact: true }).click();
  const added = row(page, "Saved addresses").locator('[data-added="true"]');
  await expect(added).toHaveCount(1);
  await expect(added).toContainText(text);
  await expect(added.getByTestId("yours")).toHaveText("Yours");
  await expect(bar(page).getByTestId("staged-chip").filter({ hasText: "+ Requirement on Saved addresses" })).toBeVisible();

  await bar(page).getByRole("button", { name: "Approve with 2 edits" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${SCOPE_REVIEW_RUN}$`));
  await expect(page.getByTestId("checkpoint-feature_set")).toContainText("Approved");

  await page.goto("/baseline");
  const feature = page.getByTestId("feature-saved-addresses");
  await expect(feature).toBeVisible();
  const requirement = page.locator('[data-testid^="requirement-r."]').filter({ hasText: text });
  await expect(requirement).toBeVisible();
  await expect(requirement).toContainText("Locked");
  // Under its feature: the next row after the feature's.
  await expect(feature.locator("xpath=following-sibling::tr[1]")).toContainText(text);
});

// Card c15 (criterion 15): protects = call c6 Commenters suggest, approvers stage: a commenter's
// row action is a suggestion that changes nothing, and an approver's Accept applies it;
// fails_when = the commenter sees Approve, the suggestion changes the row, or Accept does not
// apply it; no_claim = notifications.
test("a commenter suggests leave out; the approver accepts it", async ({ page }) => {
  await seeded(page, COMMENTER);
  await openReview(page, "saved-addresses");
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send back to agents" })).toHaveCount(0);
  const labels = row(page, "Address labels");
  await labels.getByRole("button", { name: "Suggest Leave out" }).click();
  await labels.getByRole("group", { name: "Why leave it out?" }).getByRole("button", { name: "Not now" }).click();
  await expect(labels.getByTestId("suggested-by")).toHaveText("Suggested by Commenter: Leave out · Not now");
  // A suggestion changes nothing: the row still needs a person.
  await expect(labels.getByTestId("row-done")).toHaveCount(0);
  await expect(labels.getByTestId("row-reasons")).toContainText("No confirmed goal");

  await signOut(page);
  await login(page, APPROVER);
  await openReview(page, "saved-addresses");
  const again = row(page, "Address labels");
  await expect(again.getByTestId("suggested-by")).toHaveText("Suggested by Commenter: Leave out · Not now");
  await again.getByTestId("feature-title").click();
  const suggestions = page.getByTestId("scope-inspector").getByTestId("inspector-suggestions");
  await suggestions.getByRole("button", { name: "Accept" }).click();
  await expect(again.getByTestId("row-done")).toContainText("✓ Left out · Not now");
  await expect(again.getByTestId("suggested-by")).toHaveCount(0);
  await again.getByTestId("feature-title").click();
  await expect(page.getByTestId("scope-inspector").getByTestId("history")).toContainText("Changed by Approver");
});

// Card c16 (criterion 16): protects = the Changed filter on attempt 2 lists the rows whose
// decision or kept requirements differ from attempt 1, with their chips; fails_when = an
// unchanged row is listed (Address labels changed only its goal) or a changed one is missing;
// no_claim = the re-run's own memory (D5).
test("the Changed filter on attempt 2 lists only rows that differ from attempt 1", async ({ page }) => {
  await seeded(page);
  await openReview(page, "saved-addresses-next");
  await expect(page.getByTestId("scope-for")).toHaveText("For saved-addresses-next · attempt 2");
  await page.getByRole("button", { name: /^Changed/ }).click();
  const rows = page.getByTestId("scope-row");
  await expect(rows).toHaveCount(3);
  await expect(row(page, "Delivery notes").getByTestId("changed-chip")).toHaveText("New in attempt 2");
  await expect(row(page, "Bulk edit").getByTestId("changed-chip")).toHaveText("Was left out");
  await expect(row(page, "Saved addresses").getByTestId("changed-chip")).toHaveText("Requirements changed");
  await expect(row(page, "Address labels")).toHaveCount(0);
  await expect(row(page, "Address lookup")).toHaveCount(0);
});

// Card c17 (criterion 17): protects = the screen on a phone: rows as cards, the inspector as a
// sheet, the bottom bar collapsed; fails_when = the table keeps its columns, the inspector
// sits in the page, the bar shows in full, or the page scrolls sideways at 390 px;
// no_claim = other viewports.
test("at 390 px rows are cards, the inspector is a sheet, the bar collapses, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seeded(page);
  await page.goto(`/runs/${SCOPE_REVIEW_RUN}`);
  await page.getByTestId("checkpoint-feature_set").getByRole("link", { name: "Review feature set" }).click();
  const first = page.getByTestId("scope-row").first();
  await expect(first).toBeVisible();
  await expect(page.getByTestId("scope-row")).toHaveCount(3);
  const shape = await first.evaluate((el) => ({ display: getComputedStyle(el.firstElementChild!).display, radius: getComputedStyle(el).borderTopLeftRadius }));
  expect(shape.display).toBe("flex");
  expect(shape.radius).not.toBe("0px");
  await expect(page.getByRole("columnheader", { name: "Feature" })).toBeHidden();
  await expect(page.getByTestId("scope-inspector")).toHaveCount(0);

  const collapsed = bar(page);
  await expect(collapsed).toHaveAttribute("data-collapsed", "true");
  await expect(collapsed.getByRole("button", { name: "0 changes · Approve" })).toBeVisible();

  await row(page, "Bulk edit").getByTestId("feature-title").click();
  const sheet = page.getByTestId("sheet-feature");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("scope-inspector")).toContainText("Bulk edit");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  await collapsed.getByRole("button", { name: "0 changes · Approve" }).click();
  const decide = page.getByTestId("sheet-decide");
  await expect(decide.getByRole("button", { name: /^Approve/ })).toBeDisabled();
  await expect(decide.getByTestId("approve-blocked")).toHaveText("1 blocking problem left");

  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

// Card c17a (criterion 17a): protects = D3 "Console gate" on the feature set: a console approval
// held by an open blocking row reads Confirm in the bar, disabled with the gate's reason until
// the approver waives the row with a note; fails_when = the held line is missing, Confirm is
// enabled with the row open, the waiver does not open it, or confirming leaves the checkpoint
// pending; no_claim = the runtime's real console.
test("a held console approval is confirmed once the blocking row is waived", async ({ page }) => {
  await seeded(page);
  await page.goto("/inbox");
  const inboxRow = page.locator("tr[data-row]").filter({ hasText: "address-book" }).filter({ visible: true });
  await expect(inboxRow).toHaveCount(1);
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review\//);

  await expect(bar(page).getByTestId("console-held")).toHaveText("Approved in the console: blocking problems are open: fix or waive them, then confirm");
  const confirm = bar(page).getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  await expect(bar(page).getByTestId("approve-blocked")).toHaveText("1 blocking problem left");

  const bulk = row(page, "Bulk edit");
  await bulk.getByRole("button", { name: "Waive" }).click();
  const form = page.getByTestId("scope-inspector").getByTestId("waive-form");
  await form.getByRole("textbox", { name: "Why is this fine?" }).fill("The export ships in the same release");
  await form.getByRole("button", { name: "Waive" }).click();
  await expect(bulk.getByTestId("row-done")).toContainText("✓ Waived");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("checkpoint-feature_set")).toContainText("Approved");
});

// Card #156 fixes 1: protects = #370's rule on the scope review: the row writes show only when
// can() says the role may make them (GET /v1/me/capabilities: the approver role, per item);
// fails_when = a commenter or viewer sees Cut, Edit, Enhance or Add requirement, or an approver
// does not; no_claim = the API's own 403 (api/tests/test_scope_review.py).
for (const [email, who, writes, suggests] of [
  [APPROVER, "an approver", true, false],
  [COMMENTER, "a commenter", false, true],
  ["viewer@example.com", "a viewer", false, false],
] as const) {
  test(`${who} sees the row edits only if their role may make them`, async ({ page }) => {
    await seeded(page, email);
    await openReview(page, "saved-addresses");
    const pick = row(page, "Pick address in one step");
    await pick.getByRole("button", { name: "Requirements of Pick address in one step" }).click();
    const req = pick.getByTestId("requirement-pick-address-one-screen");
    await expect(req.getByTestId("requirement-text")).toBeVisible();
    for (const name of ["Cut", "Edit", "Enhance"]) await expect(req.getByRole("button", { name, exact: true })).toHaveCount(writes ? 1 : 0);
    await expect(req.getByRole("button", { name: "Suggest Cut" })).toHaveCount(suggests ? 1 : 0);
    await pick.getByTestId("feature-title").click();
    const inspector = page.getByTestId("scope-inspector");
    await expect(inspector).toContainText("Pick address in one step");
    await expect(inspector.getByRole("button", { name: "Add requirement" })).toHaveCount(writes ? 1 : 0);
  });
}

// Card c-run (train I review): protects = the run page renders at C7's feature set for every
// role, and only a feature set shows "Review feature set"; fails_when = the page crashes
// (F4's Engineering-check line picked a feature set), an Engineering-check line shows here,
// or the Review link is missing; no_claim = the review screen itself (the tests above).
for (const email of [APPROVER, COMMENTER]) {
  test(`the run page at the feature set renders for ${email.split("@")[0]} with one Review link`, async ({ page }) => {
    await seeded(page, email);
    await page.getByTestId("nav-runs").click();
    await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
    const segment = page.getByTestId("segment-feature_set");
    await expect(segment.getByRole("link", { name: "Review feature set" })).toHaveCount(1);
    await expect(page.getByTestId("review-screen-line")).toHaveCount(0);
  });
}
