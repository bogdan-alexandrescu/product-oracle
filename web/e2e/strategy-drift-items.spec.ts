import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ROADMAP_DRIFT_RUN } from "../lib/api/mock/runs";
import { login, openSeeded, seedRoadmapDrift, signOut } from "./helpers";

/**
 * H4 §5 drift findings where the roadmap is decided: "Outside the strategy" and "Stopped in
 * the strategy" in the roadmap items review (to confirm: acted on or waived with a reason), and
 * on Plan items (a marker on the row, the finding in the inspector, Waive there). Drift is
 * advisory (the owner's "Drift gate" decision): nothing waits on a finding.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>.
 */

const RUN = ROADMAP_DRIFT_RUN.run.id;
const CP = ROADMAP_DRIFT_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;
const itemRow = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const itemInspector = (page: Page) => page.getByTestId("roadmap-item-inspector").filter({ visible: true });
const card = (page: Page, label: string) => itemInspector(page).getByTestId("reason-card").filter({ hasText: label });

async function pickItem(page: Page, key: string) {
  await itemRow(page, key).locator('[data-phone="title"]').click();
}

// protects=the review names both drift kinds on their items, in full, as reasons to confirm with
// Move to Later, Drop and Waive… (no plain Accept); an owner waives the stopped one with a reason;
// fails_when=a drift reason is missing, blocks, offers Accept, or the waiver does not land;
// no_claim=the API's drift rules (api/tests/test_roadmap_reasons_drift.py).
test("drift: the roadmap items review shows outside and stopped, and an owner waives with a reason", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapDrift, SCREEN);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await expect(itemRow(page, "sso-login").getByTestId("reason-chip").filter({ hasText: "Stopped in the strategy" })).toBeVisible();
  await expect(itemRow(page, "mobile-push").getByTestId("reason-chip").filter({ hasText: "Outside the strategy" })).toBeVisible();

  await pickItem(page, "sso-login");
  const stopped = card(page, "Stopped in the strategy");
  await expect(stopped).toContainText("To confirm · Stopped in the strategy");
  await expect(stopped).toContainText("The product strategy stops Enterprise SSO, and this item is in Next.");
  await expect(stopped.getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  await expect(stopped.getByRole("button", { name: "Drop", exact: true })).toBeVisible();
  await expect(stopped.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await stopped.getByRole("button", { name: "Waive…" }).click();
  await itemInspector(page).getByLabel("Why waive it").fill("Committed to the pilot customer before the strategy");
  await itemInspector(page).getByRole("button", { name: "Waive", exact: true }).click();
  await expect(card(page, "Stopped in the strategy")).toContainText("✓ Waived");
});

// protects=an approver acts on a stopped item (Move to Later) but cannot waive it, and waives an
// item outside the strategy; fails_when=an approver gets Waive… on a stopped item, or loses it on
// an outside one; no_claim=the API's 403 (pytest covers it).
test("drift: an approver moves a stopped item and waives only the item outside the strategy", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapDrift, SCREEN);
  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(SCREEN);
  await pickItem(page, "sso-login");
  const stopped = card(page, "Stopped in the strategy");
  await expect(stopped.getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  await expect(stopped.getByRole("button", { name: "Waive…" })).toHaveCount(0);
  await stopped.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(card(page, "Stopped in the strategy")).toContainText("✓ Moved to Later");

  await pickItem(page, "mobile-push");
  const outside = card(page, "Outside the strategy");
  await expect(outside).toContainText("Retention is under no focus choice of the product strategy.");
  await outside.getByRole("button", { name: "Waive…" }).click();
  await itemInspector(page).getByLabel("Why waive it").fill("A retention bet we keep this quarter");
  await itemInspector(page).getByRole("button", { name: "Waive", exact: true }).click();
  await expect(card(page, "Outside the strategy")).toContainText("✓ Waived");
});

const withPlanDrift = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "strategy-plan"), MOCK_SCENARIO_KEY);
const as = (page: Page, role: string) => page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
const planRow = (page: Page, key: string) => page.getByTestId("plan-row").filter({ visible: true }).and(page.locator(`[data-item="${key}"]`));
const planInspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });

async function openPlan(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(planRow(page, "slack-alerts")).toBeVisible();
}

// protects=Plan rows carry their strategy marker (an approved item's stored finding, a draft
// item's measured on the draft); the inspector shows the finding and an owner waives it there, after
// which the marker leaves the row and the card says why; fails_when=a marker is missing, the draft's
// finding offers Waive, or the waiver does not stick; no_claim=the drift check's timing.
test("drift: Plan items show the marker and the finding, and an owner waives it in the inspector", async ({ page }) => {
  await withPlanDrift(page);
  await openPlan(page);
  await expect(planRow(page, "slack-alerts").getByTestId("plan-drift-marker")).toHaveText("Stopped in the strategy");
  await expect(planRow(page, "team-budgets").getByTestId("plan-drift-marker")).toHaveText("Outside the strategy");
  await expect(planRow(page, "spend-forecast").getByTestId("plan-drift-marker")).toHaveText("Outside the strategy");
  await expect(planRow(page, "threshold-alerts").getByTestId("plan-drift-marker")).toHaveCount(0);

  await planRow(page, "spend-forecast").getByTestId("plan-title").click();
  const draft = planInspector(page).getByTestId("plan-drift-card");
  await expect(draft).toContainText("It serves no goal, so the product strategy does not cover it.");
  await expect(draft).toContainText("It can be waived once the roadmap is approved.");
  await expect(draft.getByRole("button", { name: "Waive…" })).toHaveCount(0);

  await planRow(page, "slack-alerts").getByTestId("plan-title").click();
  const stopped = planInspector(page).getByTestId("plan-drift-card");
  await expect(stopped).toContainText("The product strategy stops Custom report builder, and this item is in Now.");
  await stopped.getByRole("button", { name: "Waive…" }).click();
  await planInspector(page).getByLabel("Why waive it?").fill("Promised to a design partner");
  await planInspector(page).getByRole("button", { name: "Waive finding" }).click();
  await expect(planInspector(page).getByTestId("plan-drift-waived")).toContainText("Promised to a design partner");
  await expect(planRow(page, "slack-alerts").getByTestId("plan-drift-marker")).toHaveCount(0);
  await expect(planInspector(page).getByRole("link", { name: "Open the strategy" })).toHaveAttribute("href", "/company/strategy");
});

// protects=an approver waives an item outside the strategy on Plan but not a stopped one;
// fails_when=an approver gets Waive… on a stopped item; no_claim=the API's 403 (pytest covers it).
test("drift: on Plan an approver waives only outside the strategy", async ({ page }) => {
  await withPlanDrift(page);
  await as(page, "approver");
  await openPlan(page);
  await planRow(page, "slack-alerts").getByTestId("plan-title").click();
  await expect(planInspector(page).getByTestId("plan-drift-card")).toBeVisible();
  await expect(planInspector(page).getByTestId("plan-drift-card").getByRole("button", { name: "Waive…" })).toHaveCount(0);
  await planRow(page, "team-budgets").getByTestId("plan-title").click();
  await expect(planInspector(page).getByTestId("plan-drift-card").getByRole("button", { name: "Waive…" })).toBeVisible();
});

// protects=a viewer sees no drift on Plan (owners and approvers do); fails_when=a marker or the
// Strategy section shows; no_claim=commenters (pytest covers them).
test("drift: a viewer's Plan has no strategy markers", async ({ page }) => {
  await withPlanDrift(page);
  await as(page, "viewer");
  await openPlan(page);
  await expect(page.getByTestId("plan-drift-marker")).toHaveCount(0);
  await planRow(page, "slack-alerts").getByTestId("plan-title").click();
  await expect(planInspector(page).getByTestId("plan-drift")).toHaveCount(0);
});
