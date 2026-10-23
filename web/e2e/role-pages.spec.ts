import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * #370, the main pages: a control a role can never use is not drawn (GET /v1/me/capabilities,
 * from the API's own route roles), a page the role can only read says "View only" in its
 * header, and a control the item's state blocks still says why.
 */

type Role = "owner" | "approver" | "commenter" | "viewer";
const ROLES: Role[] = ["owner", "approver", "commenter", "viewer"];
const email = (role: Role) => (role === "owner" ? "admin@example.com" : `${role}@example.com`);

const viewOnly = (page: Page) => page.getByTestId("view-only");
const header = (page: Page, title: string) => page.getByRole("heading", { level: 1, name: title });

async function open(page: Page, path: string, title: string) {
  await page.goto(path);
  await expect(header(page, title)).toBeVisible();
}

async function expectViewOnly(page: Page, shown: boolean) {
  if (shown) await expect(viewOnly(page)).toHaveText("View only");
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
    await expect(page.getByRole("switch", { name: "Daily triage at 07:00 PT" })).toHaveCount(approver ? 1 : 0);
    await expect(page.getByRole("button", { name: "Classify now", exact: true })).toHaveCount(approver ? 1 : 0);
    if (!approver) await expect(page.getByTestId("daily-triage-state")).toHaveText("Daily triage off");
    await expectViewOnly(page, !commenter);

    // Runs: approvers start a run.
    await open(page, "/runs", "Runs");
    await expect(page.getByRole("button", { name: "New run" })).toHaveCount(approver ? 1 : 0);

    // Company › Strategy: approvers waive drift, owners draft; others only read it.
    await open(page, "/company/strategy", "Company");
    await expect(page.getByTestId("strategy-page")).toBeVisible();
    await expectViewOnly(page, !approver);

    // Company › Decisions: commenters and up propose one.
    await open(page, "/company/decisions", "Company");
    await expect(page.getByRole("button", { name: "Propose decision" })).toHaveCount(commenter ? 1 : 0);
  });
}

test("a control the item's state blocks still says why", async ({ page }) => {
  await login(page, "approver@example.com");
  await open(page, "/requests", "Requests");
  const classify = page.getByRole("button", { name: "Classify now", exact: true });
  await classify.click();
  // While triage runs, Classify now waits for it rather than disappearing.
  await expect(classify).toBeDisabled();
  await expect(classify).toHaveAttribute("title", "Oracle is classifying now");
  await expect(page.getByTestId("triage-status")).toContainText(/classifying/i);
});
