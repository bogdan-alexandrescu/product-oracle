import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * F5 lane 3: engineering specs requested from the Plan, on the mock layer
 * (NEXT_PUBLIC_API_MOCKS=1). The "spec-leads" scenario names approver@example.com engineering
 * lead (A3). "Threshold alerts on spend" is an approved item of the Usage alerts PRD whose
 * feature has an approved tech brief (F5-1). No run executes in the mock: a request answers
 * with a draft prd_to_spec run, opened for its estimate. The API's rules (the brief fed to the
 * agents, the default approvers, the states) are proven by api/tests/test_spec_from_plan.py.
 */

const withScenario = (page: Page, scenario: string) =>
  page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);
const asRole = (page: Page, role: "viewer" | "commenter" | "approver") =>
  page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);

const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Request an engineering spec" });

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
  await withScenario(page, "spec-leads");
  await login(page);
  await openItem(page, "Threshold alerts on spend");
  const line = inspector(page).getByTestId("plan-spec");
  await expect(line).toContainText("No engineering spec yet");
  await line.getByRole("button", { name: "Request spec" }).click();

  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole("button", { name: "Tech brief", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(d.getByRole("checkbox", { name: "Alert when spend crosses a threshold" })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: "Alerts reach the team by email" })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: /^Approver/ })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: "User flows and wireframes" })).toBeChecked();
  const brief = d.getByRole("checkbox", { name: /Use the approved tech brief/ });
  await expect(brief).toBeChecked();
  await expect(d.getByTestId("request-spec-brief")).toContainText("Feasible");

  // A person chooses the full spec and leaves one requirement out.
  await d.getByRole("button", { name: "Full engineering spec" }).click();
  await d.getByRole("checkbox", { name: "Alerts reach the team by email" }).uncheck();
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/v1/spec-requests"));
  await d.getByRole("button", { name: "Request spec" }).click();
  const body = (await sent).postDataJSON();
  expect(body.depth).toBe("full");
  expect(body.requirement_ids).toHaveLength(1);
  expect(body.engineering_approver_ids).toHaveLength(1);
  expect(body.design).toBe(true);
  expect(body.tech_brief_version_id).toBeTruthy();

  // The draft run opens for its estimate.
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByText("Engineering spec from an approved PRD").first()).toBeVisible();

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

// protects = the PRD overview's Engineering specs panel: each spec with its state and Open,
// and Request spec, whose dialog picks the item first.
// fails_when = a spec is missing, its state is wrong, or the panel offers no request.
test("the PRD overview lists its engineering specs and requests one for an item", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign");
  const seeded = page.getByTestId("engineering-specs");
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
  const listed = page.getByTestId("engineering-specs").getByTestId("engineering-spec");
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
