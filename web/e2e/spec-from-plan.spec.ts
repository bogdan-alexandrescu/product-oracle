import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * F5 lane 3: engineering specs requested from the Plan, on the mock layer
 * (NEXT_PUBLIC_API_MOCKS=1). "Threshold alerts on spend" is an approved item of the Usage
 * alerts PRD whose feature has an approved tech brief (F5-1). No run executes in the mock: a request answers
 * with a draft prd_to_spec run, opened for its estimate. The API's rules (the brief fed to the
 * agents, the default approvers, the states) are proven by api/tests/test_spec_from_plan.py.
 */

// qa4-plan-3: an approved item needs the roadmap approved; the Plan reads the document's state
// ("plan-decider" has usage-alerts-roadmap v1 approved; by default it is in review).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "plan-decider"] as const);
});

const asRole = (page: Page, role: "viewer" | "commenter" | "approver") =>
  page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);

const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Request an engineering spec" });
const APPROVER = "approver@example.com";
const storedSpec = (page: Page) =>
  page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const spec = db.specs.specs[0];
    const approver = db.members.find((m: { email: string }) => m.email === "approver@example.com");
    return { kind: spec.request.kind, requirements: spec.request.requirement_ids.length, approverId: approver?.id, ...spec.request.params };
  });

async function openItem(page: Page, title: string) {
  await page.goto("/plan");
  await row(page, title).getByTestId("plan-title").click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
}

// protects = the Plan inspector's Engineering spec line and the Request spec dialog: depth,
// requirements pre-ticked from the item's trace, the engineering leads as approvers, flows and
// wireframes on, the feature's approved tech brief; submitting drafts the run and opens it.
// fails_when = a default is not the spec's, or the request is not sent as chosen.
// no_claim = what the agents write (no run executes in the mock).
test("Request spec from an approved Plan item drafts the spec run with the dialog's defaults", async ({ page }) => {
  await login(page);
  // The owner names an approver the engineering lead (A3), whom the spec gets as its approver.
  await page.goto("/settings/members");
  const lead = page.getByRole("checkbox", { name: `Engineering lead: ${APPROVER}` });
  await lead.check();
  await expect(page.getByTestId("engineering-lead-count")).toHaveText("1");
  // The tick shows at once and the box stays disabled until the change is saved: leaving
  // before then (the Plan is a new page load) would drop the mock's queued write.
  await expect(lead).toBeEnabled();
  await expect(lead).toBeChecked();
  await openItem(page, "Threshold alerts on spend");
  const line = inspector(page).getByTestId("plan-spec");
  await expect(line).toContainText("No engineering spec yet");
  await line.getByRole("button", { name: "Request spec" }).click();

  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole("button", { name: "Tech brief", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(d.getByRole("checkbox", { name: "Alert when spend crosses a threshold" })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: "Alerts reach the team by email" })).toBeChecked();
  // A3: the engineering leads approve by default (the API names them).
  await expect(d.getByRole("radio", { name: "The engineering leads" })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: "User flows and wireframes" })).toBeChecked();
  const brief = d.getByRole("checkbox", { name: /Use the approved tech brief/ });
  await expect(brief).toBeChecked();
  await expect(d.getByTestId("request-spec-brief")).toContainText("Feasible");

  // A person chooses the full spec and leaves one requirement out.
  await d.getByRole("button", { name: "Full engineering spec" }).click();
  await d.getByRole("checkbox", { name: "Alerts reach the team by email" }).uncheck();
  await d.getByRole("button", { name: "Request spec" }).click();

  // The draft run opens for its estimate.
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Engineering spec from an approved PRD" })).toBeVisible();
  // What the request asked for, as the mock API stored it (read only).
  const params = await storedSpec(page);
  expect(params.kind).toBe("engineering_spec");
  expect(params.requirements).toBe(1);
  expect(params.design).toBe(true);
  // "The engineering leads": the lead who may approve, not "any approver" (#580 review).
  expect(params.approverId).toBeTruthy();
  expect(params.engineering_approver_ids).toEqual([params.approverId]);
  expect(params.tech_brief_version_id).toBeTruthy();

  // Back on the Plan, the item's spec is Requested, with Open.
  await openItem(page, "Threshold alerts on spend");
  await expect(inspector(page).getByTestId("plan-spec")).toContainText("Requested");
  await expect(inspector(page).getByTestId("plan-spec").getByRole("link", { name: "Open" })).toBeVisible();
});

// protects = Request spec is an approver's: a commenter sees the line without the button.
// fails_when = the button shows to a role the API refuses.
test("a commenter sees the Engineering spec line without Request spec", async ({ page }) => {
  await asRole(page, "commenter");
  await login(page);
  await openItem(page, "Threshold alerts on spend");
  const line = inspector(page).getByTestId("plan-spec");
  await expect(line).toContainText("No engineering spec yet");
  await expect(line.getByRole("button", { name: "Request spec" })).toHaveCount(0);
});

// protects = Request spec is an approver's on every item (#580 review): an approver who is no
// owner sees the button and the request goes through to its draft run.
// fails_when = can() reads create_spec_request as an owner's below its role, so the button hides.
test("an approver who is no owner requests a spec from the Plan inspector", async ({ page }) => {
  await login(page, APPROVER);
  await openItem(page, "Threshold alerts on spend");
  const line = inspector(page).getByTestId("plan-spec");
  await expect(line).toContainText("No engineering spec yet");
  await line.getByRole("button", { name: "Request spec" }).click();
  await dialog(page).getByRole("button", { name: "Request spec" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await openItem(page, "Threshold alerts on spend");
  await expect(inspector(page).getByTestId("plan-spec")).toContainText("Requested");
});

// protects = the PRD overview's Request spec is an approver's too (#580 review).
// fails_when = the panel hides Request spec from an approver who is no owner.
test("an approver who is no owner requests a spec from the PRD overview", async ({ page }) => {
  await login(page, APPROVER);
  await page.goto("/documents/usage-alerts");
  const panel = page.getByTestId("engineering-specs");
  await expect(panel).toContainText("No engineering spec yet");
  await panel.getByRole("button", { name: "Request spec" }).click();
  const d = dialog(page);
  await d.getByLabel("Item").selectOption({ label: "Threshold alerts on spend" });
  await d.getByRole("button", { name: "Request spec" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.goto("/documents/usage-alerts");
  // qa-docs-29: a spec requested at the Tech brief depth is listed with the tech briefs.
  await expect(page.getByTestId("tech-briefs").getByTestId("engineering-spec")).toContainText("Requested");
});

// protects = a commenter reads the PRD overview's Engineering specs panel without Request spec.
// fails_when = the panel offers Request spec to a role the API refuses.
test("a commenter sees the PRD overview's Engineering specs without Request spec", async ({ page }) => {
  await asRole(page, "commenter");
  await login(page);
  await page.goto("/documents/usage-alerts");
  const panel = page.getByTestId("engineering-specs");
  await expect(panel).toContainText("No engineering spec yet");
  await expect(panel.getByRole("button", { name: "Request spec" })).toHaveCount(0);
});

// protects = the PRD overview's Engineering specs panel: each spec with its state and Open,
// and Request spec, whose dialog picks the item first.
// fails_when = a spec is missing, its state is wrong, or the panel offers no request.
test("the PRD overview lists its engineering specs and requests one for an item", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign");
  // qa-docs-29: the seeded technical brief is listed under Tech briefs, not Engineering specs.
  await expect(page.getByTestId("engineering-specs").getByTestId("engineering-spec")).toHaveCount(0);
  const seeded = page.getByTestId("tech-briefs");
  await expect(seeded.getByTestId("engineering-spec")).toHaveCount(1);
  await expect(seeded.getByTestId("engineering-spec").first()).toContainText("Early shipping cost: technical brief");
  await expect(seeded.getByTestId("engineering-spec").first()).toContainText("Stale");

  await page.goto("/documents/usage-alerts");
  const panel = page.getByTestId("engineering-specs");
  await expect(panel).toContainText("No engineering spec yet");
  await panel.getByRole("button", { name: "Request spec" }).click();
  const d = dialog(page);
  await d.getByLabel("Item").selectOption({ label: "Threshold alerts on spend" });
  await expect(d.getByRole("checkbox", { name: "Alert when spend crosses a threshold" })).toBeChecked();
  await d.getByRole("button", { name: "Request spec" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await page.goto("/documents/usage-alerts");
  const listed = page.getByTestId("tech-briefs").getByTestId("engineering-spec");
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("Requested");
});

// protects = the dialog fits a phone.
test("phone: the Request spec dialog fits 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/plan");
  await row(page, "Threshold alerts on spend").getByTestId("plan-title").click();
  const sheet = page.getByTestId("sheet-plan-item");
  await sheet.getByRole("button", { name: "Request spec" }).click();
  await expect(dialog(page)).toBeVisible();
  const box = (await dialog(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});
