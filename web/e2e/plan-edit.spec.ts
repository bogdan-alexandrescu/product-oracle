import { expect, test, type Page } from "@playwright/test";

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
    if ((await el.getAttribute("data-testid")) === "plan-group") group = (await el.innerText()).replace(/\s*\d+\s*$/, "").trim();
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
  await expect(page.getByTestId("plan-live-version")).toHaveText("usage-alerts-roadmap v1");
  await page.getByTestId("plan-edit").click();
  await expect(changes(page)).toContainText("Changes to approved version 1");

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
  await expect(proposal).toContainText("Version 2 proposed from approved version 1 · waiting for the decider");
  await expect(proposal.getByTestId("plan-diff-row")).toHaveText([
    "Moved · Usage dashboard · Now → Next",
    "Added · Spend alerts by email",
    "Cut · Budgets per team · Teams share one budget this year",
  ]);
  await expect(proposal.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  // Not approved yet: the plan is still version 1.
  await expect(page.getByTestId("plan-live-version")).toHaveText("usage-alerts-roadmap v1");

  // The decider approves it on the Plan.
  await signOut(page);
  await openPlan(page, "approver@example.com");
  const waiting = changes(page).getByTestId("plan-proposal");
  await expect(waiting).toContainText("waiting for you (the decider)");
  await expect(waiting.getByTestId("plan-diff-row")).toHaveCount(3);
  await waiting.getByRole("button", { name: "Approve version 2" }).click();
  await expect(page.getByTestId("plan-live")).toHaveText("Version 2 is the live plan.");

  // The plan shows the new version.
  await expect(page.getByTestId("plan-live-version")).toHaveText("usage-alerts-roadmap v2");
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
  await expect(changes(page)).toContainText("Changes to approved version 1");
  await editItem(page, "Budgets per team").getByRole("button", { name: "Cut", exact: true }).click();
  await page.getByLabel("Why cut Budgets per team").fill("Teams share one budget this year");
  await editItem(page, "Budgets per team").getByRole("button", { name: "Cut item" }).click();
  await expect(changes(page).getByTestId("edit-cut")).toHaveCount(1);
  await changes(page).getByRole("button", { name: "Propose changes" }).click();

  const waiting = changes(page).getByTestId("plan-proposal");
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText("Version 3 proposed from approved version 1 · waiting for the decider");
  const superseded = changes(page).getByTestId("plan-superseded");
  await expect(superseded).toHaveCount(1);
  await expect(superseded).toContainText("Version 2 superseded by version 3 · it can't be approved");
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
  await expect(page.getByTestId("plan-live-version")).toHaveText("usage-alerts-roadmap v3");
  await expect(changes(page).getByTestId("plan-superseded")).toHaveCount(0);
  await expect(rows(page).filter({ hasText: "Budgets per team" })).toHaveCount(0);
  expect((await horizonOf(page))["Usage dashboard"]).toBe("Now");
});
