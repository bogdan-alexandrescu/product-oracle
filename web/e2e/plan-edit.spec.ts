import { expect, test, type Page } from "./test";

import { PLAN_SECTION_CODE_SCENARIO, PLAN_SECTION_FEATURE_SCENARIO, PLAN_SECTION_LINKED_SCENARIO, PLAN_TWO_ROADMAPS_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/*
 * #346 Edit the approved plan as a change set and propose it as a new roadmap version, driven
 * through the UI on the mock layer (NEXT_PUBLIC_API_MOCKS=1). The mock's change-set routes
 * (lib/api/mock/plan-edits.ts) stand in for the API's (api/oracle/roadmap/changeset.py, its
 * rules proven by api/tests/test_roadmap_change_sets.py). In the "plan-decider" scenario the
 * approver is usage-alerts-roadmap's designated decider.
 */

const withDecider = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "plan-decider"), MOCK_SCENARIO_KEY);
const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });
const changes = (page: Page) => page.getByTestId("plan-changes").filter({ visible: true });
const lane = (page: Page, horizon: string) => changes(page).locator(`[data-testid="edit-lane"][data-horizon="${horizon}"]`);
const editItem = (page: Page, title: string) => changes(page).getByTestId("edit-item").filter({ hasText: title });
// qa-plan-17: Edit plan says "approved version 1" only when the roadmap document has it approved;
// the mock's document is In review while its Plan treats version 1 as the approved plan.
const BASE_1 = /Changes to (approved version 1|version 1 \(In review, not approved\)) of Usage alerts roadmap/;
const proposedFrom1 = (n: number) =>
  new RegExp(`Version ${n} proposed from (approved version 1|version 1 \\(In review, not approved\\)) · waiting for the decider`);
const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });

async function openPlan(page: Page, email?: string) {
  await login(page, email);
  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(rows(page).first()).toBeVisible();
}

/** Each visible plan row's title, with the horizon group it sits under. */
async function horizonOf(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let group = "";
  for (const el of await page.locator('[data-testid="plan-group"], [data-testid="plan-row"]').filter({ visible: true }).all()) {
    if ((await el.getAttribute("data-testid")) === "plan-group") group = (await el.innerText()).replace(/\s*·?\s*\d+\s*$/, "").trim();
    else out[(await el.getByTestId("plan-title").innerText()).trim()] = group;
  }
  return out;
}

// protects = Edit plan opens a change set on the approved version; a move, a cut with its reason
// and an added item show in the editor and in the diff; Propose makes a new version that only the
// decider may approve; approving it makes it the live plan; fails_when = the approved version is
// edited in place, someone other than the decider is offered Approve, or the plan keeps the old
// version; no_claim = the API's rules (api/tests/test_roadmap_change_sets.py).
test("Edit plan: move, cut and add, propose, the decider approves, the plan shows the new version", async ({ page }) => {
  await withDecider(page);
  await openPlan(page);
  await expect(page.getByTestId("plan-live-version")).toHaveText("Usage alerts roadmap v1");
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(BASE_1);

  // Move Usage dashboard from Now to Next.
  await expect(lane(page, "now")).toContainText("Usage dashboard");
  await editItem(page, "Usage dashboard").getByLabel("Horizon of Usage dashboard").selectOption("next");
  await expect(lane(page, "next")).toContainText("Usage dashboard");
  await expect(lane(page, "now")).not.toContainText("Usage dashboard");

  // Cut Budgets per team, with the reason.
  await editItem(page, "Budgets per team").getByRole("button", { name: "Cut", exact: true }).click();
  const cutItem = editItem(page, "Budgets per team").getByRole("button", { name: "Cut item" });
  await expect(cutItem).toBeDisabled();
  await page.getByLabel("Why cut Budgets per team").fill("Teams share one budget this year");
  await cutItem.click();
  await expect(changes(page).getByTestId("edit-cut")).toHaveText(/Budgets per team · Teams share one budget this year/);
  await expect(editItem(page, "Budgets per team")).toHaveCount(0);

  // Add a new item in Later.
  await changes(page).getByLabel("New item title").fill("Spend alerts by email");
  await changes(page).getByLabel("Horizon of the new item").selectOption("later");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(lane(page, "later").getByTestId("edit-item").filter({ hasText: "Spend alerts by email" })).toContainText("New");

  // Propose: a new version, with its diff against the approved one, waiting for the decider.
  await changes(page).getByRole("button", { name: "Propose changes" }).click();
  const proposal = changes(page).getByTestId("plan-proposal");
  await expect(proposal).toContainText(proposedFrom1(2));
  await expect(proposal.getByTestId("plan-diff-row")).toHaveText([
    "Moved · Usage dashboard · Now → Next",
    "Added · Spend alerts by email",
    "Cut · Budgets per team · Teams share one budget this year",
  ]);
  await expect(proposal.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  // Not approved yet: the plan is still version 1.
  await expect(page.getByTestId("plan-live-version")).toHaveText("Usage alerts roadmap v1");

  // The decider approves it on the Plan.
  await signOut(page);
  await openPlan(page, "approver@example.com");
  const waiting = changes(page).getByTestId("plan-proposal");
  await expect(waiting).toContainText("waiting for you (the decider)");
  await expect(waiting.getByTestId("plan-diff-row")).toHaveCount(3);
  await waiting.getByRole("button", { name: "Approve version 2" }).click();
  await expect(page.getByTestId("plan-live")).toHaveText("Version 2 is the live plan.");

  // The plan shows the new version.
  await expect(page.getByTestId("plan-live-version")).toHaveText("Usage alerts roadmap v2");
  await expect(rows(page).filter({ hasText: "Spend alerts by email" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "Budgets per team" })).toHaveCount(0);
  const where = await horizonOf(page);
  expect(where["Usage dashboard"]).toBe("Next");
  expect(where["Spend alerts by email"]).toBe("Later");
  expect(where["Threshold alerts on spend"]).toBe("Now");
});

// protects = (#346 fixes 3) a second proposal made while version 2 waits supersedes it: the Plan
// says "Version 2 superseded by version 3", the decider's Approve version 2 is disabled with that
// reason and version 3 is the one approved; members who can never approve (the owner, not the
// decider) and members who can never edit (a commenter) see no such control at all (#370: hidden,
// not disabled); fails_when = version 2 still reads as waiting, its Approve is offered and fails,
// or a control a role can never use shows disabled; no_claim = the API's refusal
// (test_a_later_proposal_supersedes_the_waiting_one).
test("Edit plan: a later proposal supersedes the waiting one, which can't be approved", async ({ page }) => {
  await withDecider(page);
  await openPlan(page);

  // Version 2: Usage dashboard to Next.
  await page.getByTestId("plan-edit").click();
  await editItem(page, "Usage dashboard").getByLabel("Horizon of Usage dashboard").selectOption("next");
  await expect(lane(page, "next")).toContainText("Usage dashboard");
  await changes(page).getByRole("button", { name: "Propose changes" }).click();
  await expect(changes(page).getByTestId("plan-proposal")).toContainText("Version 2 proposed");

  // Edit the plan again while version 2 waits: version 3 cuts Budgets per team.
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(BASE_1);
  await editItem(page, "Budgets per team").getByRole("button", { name: "Cut", exact: true }).click();
  await page.getByLabel("Why cut Budgets per team").fill("Teams share one budget this year");
  await editItem(page, "Budgets per team").getByRole("button", { name: "Cut item" }).click();
  await expect(changes(page).getByTestId("edit-cut")).toHaveCount(1);
  await changes(page).getByRole("button", { name: "Propose changes" }).click();

  const superseded = changes(page).getByTestId("plan-superseded");
  await expect(superseded).toContainText("Version 2 superseded by version 3 · it can't be approved");
  await expect(superseded).toHaveCount(1);
  const waiting = changes(page).getByTestId("plan-proposal");
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText(proposedFrom1(3));
  // The owner is not the decider: no Approve anywhere, not even a disabled one.
  await expect(changes(page).getByRole("button", { name: /Approve/ })).toHaveCount(0);

  // A commenter can never edit or approve: neither Edit plan nor Approve is shown.
  await signOut(page);
  await openPlan(page, "commenter@example.com");
  await expect(page.getByTestId("plan-edit")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Approve version/ })).toHaveCount(0);

  // The decider: version 2's Approve is disabled with the reason; version 3 is approved.
  await signOut(page);
  await openPlan(page, "approver@example.com");
  const old = changes(page).getByTestId("plan-superseded");
  const approveOld = old.getByRole("button", { name: "Approve version 2" });
  await expect(approveOld).toBeDisabled();
  await expect(approveOld).toHaveAccessibleDescription("Superseded by version 3: approve version 3 instead.");
  await changes(page).getByTestId("plan-proposal").getByRole("button", { name: "Approve version 3" }).click();
  await expect(page.getByTestId("plan-live")).toHaveText("Version 3 is the live plan.");
  await expect(page.getByTestId("plan-live-version")).toHaveText("Usage alerts roadmap v3");
  await expect(changes(page).getByTestId("plan-superseded")).toHaveCount(0);
  await expect(rows(page).filter({ hasText: "Budgets per team" })).toHaveCount(0);
  expect((await horizonOf(page))["Usage dashboard"]).toBe("Now");
});

// protects = (every-field) Edit plan's Add an item never gives a code to a second item: with "F-31 Alert routing by team" on the
// plan, adding "F-31 Launch flow" is refused in plain words and nothing is added; a free code is added; fails_when = two items on
// the plan read F-31 (the mock's codesFree, as changeset._codes); no_claim = a picked feature's code (api/tests/test_roadmap_change_sets.py).
test("Edit plan: an item whose code another item has is refused in plain words", async ({ page }) => {
  await withDecider(page);
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(BASE_1);
  const addItem = async (title: string) => {
    await changes(page).getByLabel("New item title").fill(title);
    await changes(page).getByRole("button", { name: "Add item" }).click();
  };
  await addItem("F-31 Alert routing by team");
  await expect(editItem(page, "F-31 Alert routing by team")).toContainText("New");

  await addItem("F-31 Launch flow");
  await expect(changes(page)).toContainText("F-31 is already the code of F-31 Alert routing by team");
  await expect(editItem(page, "F-31 Launch flow")).toHaveCount(0);

  await addItem("F-32 Launch flow");
  await expect(editItem(page, "F-32 Launch flow")).toContainText("New");
  await expect(changes(page)).not.toContainText("is already the code of");
});

// protects = (every-field, codes.clash with section) an item added linked to the Ground Truth feature F-31 shares its code with the
// approved item "F-31 Alert routing by team" from the PRD's section f-31: both are parts of one feature, so it is added and proposed;
// a code from a title alone still clashes; fails_when = the mock refuses the linked add (the old "same feature only" rule) or lets
// the title-only one through; no_claim = the API's rule (api/tests/test_roadmap_change_sets.py).
test("Edit plan: an item linked to the feature an approved item's PRD section codes shares its code", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, PLAN_SECTION_CODE_SCENARIO] as const);
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(/Changes to approved version 1 of Usage alerts roadmap/);
  await expect(lane(page, "next")).toContainText("F-31 Alert routing by team");

  await changes(page).getByLabel("Ground Truth feature").selectOption({ label: "Alert routing by team" });
  await changes(page).getByLabel("Horizon of the new item").selectOption("later");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  const added = lane(page, "later").getByTestId("edit-item").filter({ hasText: "Alert routing by team" });
  await expect(added).toContainText("New");
  await expect(changes(page)).not.toContainText("is already the code of");

  // A code from a title alone is no part of the feature: refused in plain words, nothing added.
  await changes(page).getByLabel("New item title").fill("F-31 Launch flow");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(changes(page)).toContainText("F-31 is already the code of F-31 Alert routing by team");
  await expect(editItem(page, "F-31 Launch flow")).toHaveCount(0);

  // Propose checks the codes again: the linked item goes into version 2.
  await changes(page).getByRole("button", { name: "Propose changes" }).click();
  await expect(changes(page).getByTestId("plan-proposal")).toContainText("Version 2 proposed");
});

// protects = (codes.clash with section, "unless linked to different features") parts of two features never share a code: the
// approved item "F-31 Alert routing by team", from the PRD's section f-31 but linked to the Ground Truth feature Alert routing
// rules, keeps F-31, so an item added linked to the feature F-31 is refused in the API's words and nothing is added (two parts of
// one feature share it: the test above); fails_when = the mock lets two items of different features show one code;
// no_claim = the API's rule (api/tests/test_roadmap_change_sets.py).
test("Edit plan: an item linked to F-31 is refused when the approved item with F-31 is linked to another feature", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, PLAN_SECTION_LINKED_SCENARIO] as const);
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(/Changes to approved version 1 of Usage alerts roadmap/);
  await expect(lane(page, "next")).toContainText("F-31 Alert routing by team");

  await changes(page).getByLabel("Ground Truth feature").selectOption({ label: "Alert routing by team" });
  await changes(page).getByLabel("Horizon of the new item").selectOption("later");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(changes(page)).toContainText("F-31 is already the code of F-31 Alert routing by team");
  await expect(lane(page, "later").getByTestId("edit-item").filter({ hasText: "Alert routing by team" })).toHaveCount(0);
});

// protects = (codes.prd_by_key) a feature with no code of its own takes the code of the PRD section its published item came from:
// with no feature F-31, Alert routing rules reads F-31 from the approved item "F-31 Alert routing by team" (section f-31) it is
// linked to, so with that item cut, an item added linked to Alert routing rules holds F-31 and "F-31 Launch flow" is refused in
// the API's words, naming it by that code; fails_when = the mock reads a feature's code from its key alone, so the linked item
// shows no code and the title-only F-31 is added; no_claim = the API's rule (api/tests/test_roadmap_change_sets.py).
test("Edit plan: a feature takes the code of its approved item's PRD section", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, PLAN_SECTION_FEATURE_SCENARIO] as const);
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(/Changes to approved version 1 of Usage alerts roadmap/);
  await expect(lane(page, "next")).toContainText("F-31 Alert routing by team");

  await editItem(page, "F-31 Alert routing by team").getByRole("button", { name: "Cut", exact: true }).click();
  await page.getByLabel("Why cut F-31 Alert routing by team").fill("Split into smaller items");
  await editItem(page, "F-31 Alert routing by team").getByRole("button", { name: "Cut item" }).click();
  await expect(editItem(page, "F-31 Alert routing by team")).toHaveCount(0);

  await changes(page).getByLabel("Ground Truth feature").selectOption({ label: "Alert routing rules" });
  await changes(page).getByLabel("Horizon of the new item").selectOption("later");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(lane(page, "later").getByTestId("edit-item").filter({ hasText: "Alert routing rules" })).toContainText("New");

  await changes(page).getByLabel("New item title").fill("F-31 Launch flow");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(changes(page)).toContainText("F-31 is already the code of F-31 Alert routing rules");
  await expect(editItem(page, "F-31 Launch flow")).toHaveCount(0);
});

// protects = (codes.feature_reads: published items in creation order, across roadmaps) a feature with no code of its own takes the
// code of its oldest published item's PRD section: Guided setup's item in the Billing roadmap's version (section f-41) was made
// before the one in the Invoices roadmap's (section f-42), though the mock stored Invoices' first, so an item added linked to
// Guided setup holds F-41: "F-41 Launch flow" is refused naming it, "F-42 Launch flow" is added; fails_when = the mock reads
// published versions grouped by roadmap, so the feature reads F-42; no_claim = the API's order (api/oracle/roadmap/codes.py).
test("Edit plan: a feature takes the code of its oldest published item's section across roadmaps", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, PLAN_TWO_ROADMAPS_SCENARIO] as const);
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText(/Changes to approved version 1 of Usage alerts roadmap/);

  await changes(page).getByLabel("Ground Truth feature").selectOption({ label: "Guided setup" });
  await changes(page).getByLabel("Horizon of the new item").selectOption("later");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(lane(page, "later").getByTestId("edit-item").filter({ hasText: "Guided setup" })).toContainText("New");

  await changes(page).getByLabel("New item title").fill("F-41 Launch flow");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(changes(page)).toContainText("F-41 is already the code of F-41 Guided setup");
  await expect(editItem(page, "F-41 Launch flow")).toHaveCount(0);

  await changes(page).getByLabel("New item title").fill("F-42 Launch flow");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await expect(editItem(page, "F-42 Launch flow")).toContainText("New");
  await expect(changes(page)).not.toContainText("is already the code of");
});
