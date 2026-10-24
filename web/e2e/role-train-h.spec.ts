import { expect, test, type Page } from "./test";

import { POOL_SPENT_SCENARIO } from "../lib/api/mock/claude-accounts";
import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #370 meets merge train H: the controls the trains added since #421 (the Requests queue and
 * its themes, Classify now, daily triage and Interview a customer; Settings › Company's Time
 * zone; the intake's team follow-ups; Home's Claude pool notice) are drawn only for a role
 * that can use them (can(), from GET /v1/me/capabilities), driven through the UI as a person
 * would on the mock API.
 */

type Role = "owner" | "approver" | "commenter" | "viewer";
const ROLES: Role[] = ["owner", "approver", "commenter", "viewer"];
const email = (role: Role) => (role === "owner" ? "admin@example.com" : `${role}@example.com`);
const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const viewOnly = (page: Page) => page.getByTestId("view-only").filter({ visible: true });
const header = (page: Page, title: string) => page.getByRole("heading", { level: 1, name: title });

for (const role of ROLES) {
  const approver = role === "owner" || role === "approver";
  const commenter = approver || role === "commenter";

  test(`${role}: Requests shows the queue's and themes' controls only to a role that can use them`, async ({ page }) => {
    await login(page, email(role));
    await page.goto("/requests");
    await expect(header(page, "Requests")).toBeVisible();
    await expect(page.getByRole("button", { name: "New request" }).first()).toHaveCount(commenter ? 1 : 0);
    await expect(viewOnly(page)).toHaveCount(commenter ? 0 : 1);

    // Triage: approvers classify and turn the daily run; others read its state, no switch.
    await expect(page.getByTestId("classify-now")).toHaveCount(approver ? 1 : 0);
    await expect(page.getByTestId("daily-triage-switch")).toHaveCount(approver ? 1 : 0);
    if (!approver) await expect(page.getByTestId("daily-triage-state")).toBeVisible();

    // Interview a customer (C3): commenters and up.
    await expect(page.getByRole("button", { name: "Interview a customer" })).toHaveCount(commenter ? 1 : 0);

    // The queue's inspector: decisions are an approver's; nobody sees them disabled for their role.
    await page.getByTestId("request-row").first().click();
    const inspector = page.getByTestId("request-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Qualify", exact: true })).toHaveCount(approver ? 1 : 0);
    await expect(inspector.getByRole("button", { name: "Disqualify", exact: true })).toHaveCount(approver ? 1 : 0);

    // Themes: approvers create, rename and archive; others only read.
    await page.getByRole("button", { name: "Themes" }).click();
    await expect(page.getByTestId("theme-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Create theme" })).toHaveCount(approver ? 1 : 0);
    if (approver) await expect(page.getByRole("button", { name: "Rename" }).first()).toBeVisible();
    else {
      await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
    }
  });

  test(`${role}: Requests › Interviews offers Interview a customer to commenters and up`, async ({ page }) => {
    await login(page, email(role));
    await page.goto("/requests/interviews");
    await expect(header(page, "Requests")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interviews" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Interview a customer" })).toHaveCount(commenter ? 1 : 0);
  });

  test(`${role}: Settings › Company's Time zone is an owner's; others get no role note`, async ({ page }) => {
    await login(page, email(role));
    await page.goto("/settings/company");
    await expect(page.getByTestId("role-note")).toHaveCount(0);
    if (role === "owner") {
      const panel = page.getByTestId("timezone-panel");
      await expect(panel.getByLabel("Company time zone")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Save" })).toBeVisible();
      await expect(viewOnly(page)).toHaveCount(0);
    } else {
      await expect(page.getByTestId("not-for-role")).toContainText("Not available for your role");
      await expect(page.getByTestId("timezone-panel")).toHaveCount(0);
    }
  });

  test(`${role}: the intake's team follow-ups are for those who can answer in them`, async ({ page }) => {
    await withScenario(page, "before-drafting");
    await login(page, email(role));
    await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
    await expect(page.getByTestId("intake-thread")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Oracle follows up" })).toHaveCount(commenter ? 1 : 0);
  });
}

for (const role of ["owner", "approver"] as const) {
  test(`${role}: Home's notice that Oracle's AI is off is for whoever can act on it (owners)`, async ({ page }) => {
    await withScenario(page, POOL_SPENT_SCENARIO);
    await login(page, email(role));
    await page.goto("/home");
    await expect(header(page, "Home")).toBeVisible();
    const notice = page.getByTestId("ai-off").filter({ visible: true });
    if (role === "owner") await expect(notice).toBeVisible();
    else await expect(notice).toHaveCount(0);
  });
}
