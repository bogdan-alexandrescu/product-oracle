import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #370 fixes 6, driven through the UI on the mock layer: a control the API refuses a role
 * on every item is not drawn, read off the capabilities' per-item roles (the API's own
 * checks, start_draft and update_launch_task among them).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const strategyPage = (page: Page) => page.getByTestId("strategy-page").filter({ visible: true });
const DRAFT = /^(Draft next version|New vision|New product strategy)$/;

// protects=Company › Strategy draws Draft next version for an owner only; fails_when=an
// approver, whom POST /v1/drafts refuses a vision or a strategy (403), sees it;
// no_claim=the draft sheet's own steps (strategy.spec.ts).
test("an approver sees no Draft on the vision or strategy cards; an owner does", async ({ page }) => {
  await withScenario(page, "strategy");
  await login(page, "approver@example.com");
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await expect(strategyPage(page).getByTestId("vision-card")).toBeVisible();
  await expect(strategyPage(page).getByRole("button", { name: "Open vision" }).or(strategyPage(page).getByRole("link", { name: "Open vision" }))).toHaveCount(1);
  await expect(strategyPage(page).getByRole("button", { name: DRAFT })).toHaveCount(0);
  // Approvers still see the Updates tab and start PRDs (start_draft for a PRD is theirs).
  await expect(page.getByRole("navigation", { name: "Company" }).getByRole("link")).toHaveText(["Strategy", "Decisions", "Rituals", "Updates", "Metrics", "Market"]);
  await page.goto("/home");
  await expect(page.getByRole("link", { name: "New PRD" }).filter({ visible: true }).first()).toBeVisible();
});

test("an owner sees Draft next version on the vision and strategy cards", async ({ page }) => {
  await withScenario(page, "strategy");
  await login(page);
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(strategyPage(page).getByTestId("vision-card")).toBeVisible();
  await expect(strategyPage(page).getByRole("button", { name: DRAFT })).toHaveCount(2);
});

async function openCaps(page: Page, role: "viewer" | "approver") {
  await withScenario(page, "launches");
  await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
  await page.goto("/plan/documents");
  await page.getByTestId("roadmap-launches-link").click();
  await expect(page.getByTestId("launches-table")).toBeVisible();
  await page.getByTestId("launch-row").filter({ hasText: "Hard budget caps" }).click();
  const inspector = page.getByTestId("launch-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Hard budget caps");
  return inspector;
}

// protects=a launch's tasks show Done, Skip and Save draft only to those PATCH
// /v1/launch-tasks lets in (the task's owner or an approver); fails_when=a viewer is
// offered them on a task they do not own and gets 403; no_claim=the API's 403 (pytest).
test("a viewer edits only the launch tasks they own", async ({ page }) => {
  const inspector = await openCaps(page, "viewer");
  const tasks = inspector.getByTestId("launch-task");
  await expect(tasks.first()).toBeVisible();
  // A task the signed-in person owns ("yours") would stay theirs to edit.
  const others = tasks.filter({ hasNotText: "yours" });
  await expect(others.first()).toBeVisible();
  await expect(others.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(others.getByRole("button", { name: "Skip", exact: true })).toHaveCount(0);
  const key = await others.filter({ has: page.getByRole("button", { name: "Open draft" }) }).first().getAttribute("data-key");
  const drafted = inspector.locator(`[data-testid="launch-task"][data-key="${key}"]`);
  await drafted.getByRole("button", { name: "Open draft" }).click();
  await expect(drafted.getByRole("textbox")).toHaveAttribute("readonly", "");
  await expect(drafted.getByRole("button", { name: "Save draft" })).toHaveCount(0);
});

test("an approver sees Done and Skip on a launch's open tasks", async ({ page }) => {
  const inspector = await openCaps(page, "approver");
  await expect(inspector.getByTestId("launch-task").first()).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Done", exact: true }).first()).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Skip", exact: true }).first()).toBeVisible();
});

const asRole = (page: Page, role: "approver" | "viewer") => page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);

// protects=Publish and Approve version read approve_version's per-item role (owner for a
// vision, strategy or update; an approver for a PRD), and Accept risk the company's
// acceptance role (owner by default); fails_when=an approver loses Publish or Approve on a
// PRD, or sees Accept risk while only an owner may; no_claim=the publish gate (publish.spec.ts).
test("an approver publishes and approves a PRD but accepts no risk only an owner may", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto("/documents/visit-reminders/publish");
  await expect(page.getByTestId("hard-check").first()).toBeVisible();
  await expect(page.getByTestId("publish-button")).toBeVisible();
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await expect(page.getByTestId("doc-header").getByRole("button", { name: "Approve version" })).toBeVisible();
  await page.goto("/documents/online-deposits/publish");
  await expect(page.getByTestId("publish-inspector")).toBeVisible();
  // qa4-docs-40: no empty Risk section for a role that cannot accept the risk.
  await expect(page.getByTestId("publish-inspector").getByTestId("block-risk")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept risk" })).toHaveCount(0);
});

test("an owner sees Accept risk on a blocker that gates publishing", async ({ page }) => {
  await login(page);
  await page.goto("/documents/online-deposits/publish");
  await expect(page.getByTestId("publish-inspector").getByTestId("block-risk").getByRole("button", { name: "Accept risk" })).toBeVisible();
});
