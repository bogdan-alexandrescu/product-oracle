import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Fix-plan review minors on /baseline, through the UI on the mock layer (see
 * qa-plan-baseline.spec.ts for the pattern this borrows).
 *
 * #2 "conflict-3way" scenario (lib/api/mock/baseline.ts addThreeWayConflict): Dark mode's
 * delivery status has three claims tied on confidence. The winner (code) and the true
 * runner-up (tracker) share the precedence tiebreak the rule names; a third claim (chat)
 * has higher raw confidence than the runner-up but a weaker source. protects=the "outranks"
 * sentence names the claim the rule actually ranked second; fails_when=it names the chat
 * claim instead, because that one merely has the next-highest confidence.
 */
async function openConflicts(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "conflict-3way"));
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByRole("tab", { name: /Conflicts/ }).click();
}

test("conflicts: with 3 claims the 'outranks' sentence names the actual runner-up", async ({ page }) => {
  await openConflicts(page);
  const card = page.getByTestId("conflict").filter({ hasText: "Dark mode" });
  await expect(card).toBeVisible();
  const claims = card.getByTestId("claim");
  await expect(claims).toHaveCount(3);
  await expect(claims.nth(0)).toContainText("In progress");
  await expect(claims.nth(0)).toContainText("Leading");
  await expect(claims.nth(1)).toContainText("Idea");
  await expect(claims.nth(2)).toContainText("Planned");

  const rule = card.getByTestId("conflict-rule");
  // Linear (tracker, 50%) is the claim the rule actually ranked second; Slack (chat, 55%)
  // merely has the next-highest raw confidence and must not be named as the runner-up.
  await expect(rule).toContainText("outranks Linear (tracker)");
  await expect(rule).not.toContainText("Slack");
});

/*
 * #3 "proposal-overlap-status" scenario (lib/api/mock/baseline.ts addStatusOverlapProposals):
 * two run proposals on Team invites that both set its delivery status. protects=the overlap
 * warning names the field fully ("delivery status"), the same map the Details list reads, in
 * lower case since it is not a sentence's own start; fails_when=it reads bare "status".
 */
async function openStatusOverlap(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "proposal-overlap-status"));
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByRole("tab", { name: /Proposals/ }).click();
}

test("proposals: the overlap warning names a feature's status fully, not bare", async ({ page }) => {
  await openStatusOverlap(page);
  const rows = page.getByTestId("proposal");
  const first = rows.filter({ hasText: "Work started on the invite flow." });
  const second = rows.filter({ hasText: "Rescoped for next sprint." });
  await expect(second).toBeVisible();

  await first.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  await expect(second.getByTestId("overlap-chip")).toHaveText("Changes what you just accepted");

  await second.getByRole("button", { name: "Accept" }).click();
  const warning = second.getByRole("group", { name: "This would undo a change" });
  const field = warning.getByTestId("overlap-status");
  await expect(field.getByTestId("overlap-now")).toHaveText("delivery status now: In progress");
  await expect(field.getByTestId("overlap-proposed")).toHaveText("this proposal: Planned");
  await expect(warning.getByRole("button", { name: "Skip delivery status, apply the rest" })).toBeVisible();

  // The same map's capitalized, full-sentence form, read on the card's own Details list.
  await second.getByText("Details", { exact: true }).click();
  await expect(second.getByLabel("Proposed fields")).toHaveText("delivery status → Planned");
});
