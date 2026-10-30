import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #370, the main pages: a control a role can never use is not drawn (GET /v1/me/capabilities,
 * from the API's own route roles), a page the role can only read says "View only" in its
 * header, and a control the item's state blocks still says why.
 */

type Role = "owner" | "approver" | "commenter" | "viewer";
const ROLES: Role[] = ["owner", "approver", "commenter", "viewer"];
const email = (role: Role) => (role === "owner" ? "admin@example.com" : `${role}@example.com`);

// Next keeps recently visited routes mounted but hidden, so only the page on screen counts.
const viewOnly = (page: Page) => page.getByTestId("view-only").filter({ visible: true });
const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const header = (page: Page, title: string) => page.getByRole("heading", { level: 1, name: title });

async function open(page: Page, path: string, title: string) {
  await page.goto(path);
  await expect(header(page, title)).toBeVisible();
}

async function expectViewOnly(page: Page, shown: boolean) {
  if (shown) await expect(viewOnly(page)).toHaveText(/^View only(: .+)?$/);
  else await expect(viewOnly(page)).toHaveCount(0);
}

for (const role of ROLES) {
  const approver = role === "owner" || role === "approver";
  const commenter = approver || role === "commenter";

  test(`${role}: the main pages show only what the role can do`, async ({ page }) => {
    await login(page, email(role));

    // Baseline: approvers change it, commenters propose, viewers only read it.
    await open(page, "/baseline", "Baseline");
    await expect(page.getByText("Read only", { exact: true })).toHaveCount(0);
    await expectViewOnly(page, !commenter);
    if (!approver) await expect(page.getByRole("button", { name: "Build baseline" })).toHaveCount(0);

    // Plan: approvers start PRDs and build the baseline; below that it is read only.
    await open(page, "/plan", "Plan");
    await expectViewOnly(page, !approver);

    // Plan › Roadmap documents: approvers start the runs; no role note for anyone else.
    await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
    await expect(page.getByTestId("approved-prd").first()).toBeVisible();
    await expect(page.getByText("Approvers and owners start these runs.")).toHaveCount(0);
    await expectViewOnly(page, !approver);
    if (!approver) await expect(page.getByRole("button", { name: "Build roadmap" })).toHaveCount(0);

    // Priorities: Save snapshot only for those who can save one.
    await open(page, "/priorities", "Priorities");
    await expect(page.getByRole("button", { name: "Save snapshot" })).toHaveCount(approver ? 1 : 0);
    await expectViewOnly(page, !approver);

    // PRDs: a commenter writes a brief through New PRD; a viewer has no New PRD.
    await open(page, "/documents", "PRDs");
    await expect(page.getByRole("link", { name: "New PRD" })).toHaveCount(commenter ? 1 : 0);
    await expectViewOnly(page, !commenter);

    // Requests: approvers turn daily triage and classify; others read its state, no switch.
    await open(page, "/requests", "Requests");
    await expect(page.getByTestId("triage-menu")).toHaveCount(approver ? 1 : 0);
    if (approver) await page.getByTestId("triage-menu").click();
    await expect(page.getByRole("switch", { name: /^Auto-sort new requests daily/ })).toHaveCount(approver ? 1 : 0);
    await expect(page.getByRole("button", { name: "Sort now", exact: true })).toHaveCount(approver ? 1 : 0);
    if (!approver) await expect(page.getByTestId("daily-triage-state")).toHaveText("Auto-sort: Off");
    await expectViewOnly(page, !commenter);

    // Runs: approvers start a run.
    await open(page, "/runs", "Runs");
    await expect(page.getByRole("button", { name: "Start a run…" })).toHaveCount(approver ? 1 : 0);

    // Company › Strategy: approvers waive drift, owners draft; others only read it.
    await open(page, "/company/strategy", "Company");
    await expect(page.getByTestId("strategy-page")).toBeVisible();
    await expectViewOnly(page, !approver);

    // Company › Decisions: commenters and up propose one.
    await open(page, "/company/decisions", "Company");
    await expect(page.getByRole("button", { name: "Propose decision" })).toHaveCount(commenter ? 1 : 0);
  });

  test(`${role}: PRD and document pages show only what the role can do (#370 fixes 4)`, async ({ page }) => {
    // The intake below (BEFORE_DRAFTING) exists only in the "before-drafting" scenario.
    await withScenario(page, "before-drafting");
    await login(page, email(role));

    // A PRD: no old role note; a viewer reads it with View only.
    await page.goto("/documents/team-workspaces/v/2");
    await expect(page.getByTestId("doc-status").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("role-note")).toHaveCount(0);
    await expect(page.getByText("Read only", { exact: true })).toHaveCount(0);
    await expectViewOnly(page, !commenter);
    // History: the "Oracle does on its own" switches are an owner's; nobody else sees them.
    await page.getByRole("tab", { name: /^History/ }).filter({ visible: true }).click();
    const jobs = page.getByTestId("jobs-panel").filter({ visible: true });
    await expect(jobs).toBeVisible();
    await expect(jobs.getByTestId("llm-job-settings")).toHaveCount(role === "owner" ? 1 : 0);
    // Five switches since refinement, quality review and O5's public texts got theirs (JOB_SETTING_LABEL, oracle-work.spec.ts).
    await expect(jobs.getByRole("checkbox")).toHaveCount(role === "owner" ? 5 : 0);
    await expect(jobs.getByText(/Approvers and owners/)).toHaveCount(0);

    // A document only an owner approves: no "Only an owner approves" note for anyone.
    // 10d (updates.spec.ts): updates are for owners and approvers; anyone else gets the document's not-found state.
    await page.goto("/documents/board-update-2026-10/v/1");
    if (approver) await expect(page.getByTestId("doc-status").filter({ visible: true })).toBeVisible();
    else await expect(page.getByText("This document doesn't exist or was deleted.").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("owner-approves-note")).toHaveCount(0);
    await expect(page.getByTestId("role-note")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(role === "owner" ? 1 : 0);

    // An intake: only those who may start the draft see Draft with Oracle.
    await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
    await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeVisible();
    await expect(page.getByRole("button", { name: "Draft with Oracle" })).toHaveCount(approver ? 1 : 0);
    await expect(page.getByText("An approver starts the draft")).toHaveCount(0);

    // Plan: importing a roadmap is for those who may write it.
    await open(page, "/plan", "Plan");
    await expect(page.getByText("Approvers and owners", { exact: false })).toHaveCount(0);
  });
}

test("engineering lead: the flag shows what the lead may do, and nothing more", async ({ page }) => {
  // The commenter carries the engineering lead flag in this scenario.
  await withScenario(page, "eng-review");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const stop = page.getByTestId("inbox-checkpoints").getByRole("link", { name: "Decide" });
  await expect(stop).toHaveCount(1);
  await stop.click();
  await expect(page).toHaveURL(/\/runs\/[^/]+#decide$/);
  await expect(page.getByRole("button", { name: "Approve and continue" })).toBeEnabled();
  await expectViewOnly(page, false);
  // Still a commenter everywhere else: no New run, Plan is read only.
  await open(page, "/runs", "Runs");
  await expect(page.getByRole("button", { name: "Start a run…" })).toHaveCount(0);
  await open(page, "/plan", "Plan");
  await expectViewOnly(page, true);
});
