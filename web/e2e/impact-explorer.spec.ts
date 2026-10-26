import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * The Impact explorer and targeted regeneration plan (v2 screen 2): B's lineage graph and
 * plan sidebar, A's table and inspector as a second view, C's three stages on each plan row.
 * The "impact" scenario gives checkout-redesign's v1 six downstream outputs (invented data).
 */
const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** Opens v2 of the checkout PRD and its Impact screen from the version's toolbar. */
async function openImpact(page: Page, email?: string, n = 2) {
  await login(page, email);
  await page.goto(`/documents/checkout-redesign/v/${n}`);
  await page.getByRole("link", { name: "Impact", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/checkout-redesign/v/${n}/impact$`));
}

const plan = (page: Page) => page.getByRole("complementary", { name: "Regeneration plan" });
const row = (page: Page, title: string) => plan(page).getByTestId("plan-row").filter({ hasText: title });

test("impact: an owner sees the lineage, picks an output and settles it, then proposes its draft run", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page);
  await expect(page.getByText("Preview: nothing has been marked stale.")).toBeVisible();

  const graph = page.getByRole("region", { name: "Lineage" });
  await expect(graph.getByTestId("lineage-subject")).toContainText("checkout-redesign@2");
  await expect(graph.getByTestId("lineage-upstream").filter({ hasText: "scope" })).toBeVisible();
  await expect(graph.getByTestId("lineage-output")).toHaveCount(7);

  // The plan: counts, one row per proposal, and the superseded output with no proposal.
  await expect(plan(page).getByTestId("plan-stat-affected")).toContainText("7");
  await expect(plan(page).getByTestId("plan-stat-in-plan")).toContainText("6");
  await expect(plan(page).getByTestId("plan-row")).toHaveCount(6);
  await expect(plan(page).getByTestId("plan-not-in-plan")).toContainText("Checkout prototype");
  // No action runs the whole plan: the API has none.
  await expect(page.getByRole("button", { name: /run (the whole|all)/i })).toHaveCount(0);

  // Choosing an output highlights its path and opens its plan row.
  await graph.getByTestId("lineage-output").filter({ hasText: "Checkout flow" }).click();
  await expect(graph.getByTestId("lineage-output").filter({ hasText: "Checkout flow" })).toHaveAttribute("aria-pressed", "true");
  await expect(graph.getByTestId("lineage-upstream").filter({ hasText: "scope" })).toHaveAttribute("data-on-path", "true");
  const flow = row(page, "Checkout flow");
  await expect(flow.getByTestId("plan-how")).toContainText("Propose a new version of this user flow covering only sections scope");
  await expect(flow.getByText("1 · Settle staleness")).toBeVisible();

  await flow.getByRole("button", { name: "Accept regeneration" }).click();
  await expect(flow.getByTestId("plan-freshness")).toHaveText("Under review");
  await flow.getByRole("button", { name: "Propose regeneration" }).click();
  await expect(flow.getByTestId("plan-proposed")).toContainText(/Draft run .+ from PRD v\d/);
  await expect(flow.getByRole("link", { name: "Estimate and start it on the run page" })).toHaveAttribute("href", /\/runs\//);
});

test("impact: reconciling needs a reason, as the API says", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page, "approver@example.com");
  await page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-output").filter({ hasText: "Cart wireframes" }).click();
  const r = row(page, "Cart wireframes");
  await r.getByRole("button", { name: "Reconcile…" }).click();
  await r.getByRole("button", { name: "Reconcile", exact: true }).click();
  await expect(r.getByRole("alert")).toContainText("reconciling needs a reason");
  await r.getByLabel("Why the current version still holds").fill("Only copy changed in scope");
  await r.getByRole("button", { name: "Reconcile", exact: true }).click();
  await expect(r.getByTestId("plan-freshness")).toHaveText("Reconciled");
});

test("impact: a roadmap row gets an estimate with its threshold, then starts its run", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page);
  await page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-output").filter({ hasText: "Usage alerts roadmap" }).click();
  const r = row(page, "Usage alerts roadmap");
  await expect(r.getByTestId("plan-how")).toContainText("Start a roadmap run from the approved PRD version (flow prd_to_roadmap)");
  await r.getByRole("button", { name: "Estimate" }).click();
  await expect(r.getByTestId("plan-estimate")).toContainText("$6.00");
  await expect(r.getByTestId("plan-estimate")).toContainText(/Owner approval over\s*\$50\.00/);
  await r.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
});

test("impact: the table view lists outputs by category with the inspector's dependencies", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  const table = page.getByRole("grid", { name: "Affected outputs" });
  await expect(table).toContainText("Wireframe");
  await table.getByText("Acceptance tests", { exact: false }).first().click();
  const inspector = page.getByRole("complementary", { name: /Acceptance tests/ });
  await expect(inspector.getByTestId("dependency").filter({ hasText: "risks" })).toBeVisible();
  // The table view keeps the plan list below the table, and C's stages in the inspector.
  await expect(page.getByRole("region", { name: "Regeneration plan" }).getByRole("listitem")).toHaveCount(7);
  await expect(inspector.getByText("1 · Settle staleness")).toBeVisible();

  // The deleted baseline item behind it stands out in its recorded change's lineage.
  await inspector.getByRole("link", { name: "Recorded change" }).first().click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  const graph = page.getByRole("region", { name: "Lineage" });
  await expect(graph.getByTestId("lineage-upstream").filter({ hasText: "Deleted" })).toContainText("R-90");
  await page.getByRole("button", { name: "Table" }).click();
  await page.getByRole("grid", { name: "Affected outputs" }).getByText("Acceptance tests").first().click();
  const tests = page.getByRole("complementary", { name: /Acceptance tests/ });
  await expect(tests.getByTestId("dependency").filter({ hasText: "R-90" })).toContainText("Deleted");
  await expect(tests.getByText("requirement R-90 was deleted")).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "Table" }).click();

  // A dependency's recorded change opens that change's impact.
  await page.getByRole("grid", { name: "Affected outputs" }).getByText("Saved addresses tech brief").click();
  await page.getByRole("complementary", { name: /Saved addresses tech brief/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await expect(page.getByText("Recorded: this change marked these outputs Potentially stale.").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("lineage-subject").filter({ visible: true })).toContainText("checkout-redesign@2#metrics");
});

test("impact: a what-if from a baseline item's drawer", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  await page.goto("/baseline");
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  await page.getByRole("dialog", { name: "Guided setup" }).getByRole("link", { name: "What if it changed?" }).click();
  await expect(page).toHaveURL(/\/impact\/entities\/[^/]+$/);
  await expect(page.getByText("What if Guided setup changed? Preview only; nothing is marked stale.")).toBeVisible();
  await expect(page.getByTestId("lineage-output").filter({ hasText: "Checkout flow" })).toBeVisible();
});

test("impact: a viewer reads the plan and acts on nothing", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page, "viewer@example.com");
  await expect(page.getByTestId("view-only").filter({ visible: true })).toBeVisible();
  await page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-output").filter({ hasText: "Checkout flow" }).click();
  const r = row(page, "Checkout flow");
  await expect(r.getByText("Read only. An approver acts on this plan.")).toBeVisible();
  await expect(plan(page).getByRole("button", { name: /Accept regeneration|Mark reviewed|Reconcile|Propose regeneration|Estimate/ })).toHaveCount(0);
});

test("impact: a commenter who decides the roadmap estimates it, but settles no staleness", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page, "commenter@example.com");
  const graph = page.getByRole("region", { name: "Lineage" });
  await graph.getByTestId("lineage-output").filter({ hasText: "Usage alerts roadmap" }).click();
  const r = row(page, "Usage alerts roadmap");
  await expect(r.getByText("You decide on this roadmap, so you can regenerate it. Settling its staleness needs an approver.")).toBeVisible();
  await expect(r.getByRole("button", { name: "Accept regeneration" })).toHaveCount(0);
  await r.getByRole("button", { name: "Estimate" }).click();
  await expect(r.getByTestId("plan-estimate")).toContainText("$6.00");

  // Not the decider of a spec: read only there.
  await graph.getByTestId("lineage-output").filter({ hasText: "Checkout flow" }).click();
  await expect(row(page, "Checkout flow").getByText("Read only. An approver acts on this plan.")).toBeVisible();
});

test("impact: a version nothing was built on is empty, and a missing one says so", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page, undefined, 1);
  await expect(page.getByText("No outputs depend on what v1 changed. Nothing to regenerate.")).toBeVisible();
  await page.goto("/documents/checkout-redesign/v/9/impact");
  await expect(page.getByRole("alert").filter({ hasText: "not found" })).toContainText("Version not found");
});

test("impact: past 15 outputs the graph groups them by category, and a cut-off walk says so", async ({ page }) => {
  await scenario(page, "impact-large");
  await openImpact(page);
  await expect(page.getByText(/Lineage cut off at the walk limit/)).toBeVisible();
  const graph = page.getByRole("region", { name: "Lineage" });
  await expect(graph.getByTestId("lineage-output")).toHaveCount(0);
  const wireframes = graph.getByTestId("lineage-group").filter({ hasText: "Wireframe" });
  await expect(wireframes).toContainText(/\d+ outputs/);
  await wireframes.click();
  await expect(graph.getByTestId("lineage-output").first()).toBeVisible();
  await graph.getByRole("button", { name: "All categories" }).click();
  await expect(graph.getByTestId("lineage-output")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("impact: on a phone the graph is a grouped list and a row opens its sheet", async ({ page }) => {
    await scenario(page, "impact");
    await login(page);
    await page.goto("/documents/checkout-redesign/v/2/impact");
    await expect(page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-subject")).toBeHidden();
    const list = page.getByRole("region", { name: "Affected outputs" });
    await expect(list.getByText("From scope", { exact: false }).first()).toBeVisible();
    await list.getByRole("button", { name: /Checkout flow/ }).click();
    const sheet = page.getByRole("dialog", { name: /Checkout flow/ });
    await expect(sheet.getByText("Built from")).toBeVisible();
    await expect(sheet.getByText("1 · Settle staleness")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
