import { expect, test, type Page } from "./test";

import { LEGACY_OVERRIDE_SCENARIO } from "../lib/api/mock/lane-f";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Review minors on /impact and /priorities, driven through the UI as a person would:
 * 1. qa-plan-10: the lineage's upstream sub-line names a baseline item's kind, in words,
 *    never its raw key; "What if … changed?" names it too.
 * 2. The lineage's grouped (past-15) view keeps the same names when it builds a category's
 *    upstream edges as it does when it builds the ones the subject column shows.
 * 3. A recorded change's impact highlights the rail by what the change is about, not always PRDs.
 * 4. qa-plan-40: a feature's score steps read the same number style as the Score column, and
 *    confidence the same unitless way the Confidence meter shows it.
 * 5. A stored change whose anchor feature is no longer anyone's still names it by the API's
 *    own title in the Changes log, not by its bare key.
 */

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openImpact(page: Page, n = 2) {
  await login(page);
  await page.goto(`/documents/checkout-redesign/v/${n}/impact`);
}

test("impact: the lineage names a baseline item's kind, not its raw key", async ({ page }) => {
  await scenario(page, "impact");
  await openImpact(page);
  const graph = page.getByRole("region", { name: "Lineage" });
  const upstream = graph.getByTestId("lineage-upstream").filter({ hasText: "Guided setup" });
  await expect(upstream).toBeVisible();
  // The sub-line names the kind in words ("Feature", locked), never "f.guided-setup".
  await expect(upstream.getByTestId("lineage-upstream-sub")).toHaveText("Feature · locked");
  await expect(upstream).not.toContainText("f.guided-setup");
  // The link to the what-if names the item too.
  await expect(upstream.getByRole("link", { name: "What if Guided setup changed?" })).toBeVisible();
  await expect(upstream.getByRole("link", { name: /f\.guided-setup/ })).toHaveCount(0);
});

test("impact: a recorded change highlights the rail by what it is about, not always PRDs", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2/impact");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  const table = page.getByRole("grid", { name: "Affected outputs" });
  const nav = page.getByRole("navigation", { name: "Oracle" });

  // A change on a deleted baseline item (a requirement) belongs with Baseline, never PRDs.
  await table.getByText("Acceptance tests").first().click();
  await page.getByRole("complementary", { name: /Acceptance tests/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await expect(page.getByTestId("lineage-subject").filter({ visible: true })).toContainText("Requirement R-90 deleted");
  await expect(nav.getByTestId("nav-baseline")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");

  // A change on a source's permission belongs with neither PRDs nor Baseline: the rail stays quiet.
  await page.goBack();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await table.getByText("Early shipping cost brief").first().click();
  await page.getByRole("complementary", { name: /Early shipping cost brief/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await expect(page.getByText(/^Impact:/).filter({ visible: true })).toBeVisible();
  await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-baseline")).not.toHaveAttribute("aria-current", "page");

  // A change on a PRD section still belongs with PRDs, as before.
  await page.goBack();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await table.getByText("Saved addresses tech brief").first().click();
  await page.getByRole("complementary", { name: /Saved addresses tech brief/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
  await expect(page.getByTestId("lineage-subject").filter({ visible: true })).toContainText("Checkout redesign PRD v2");
  await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
});

test("impact: past 15 outputs, a category still finds its upstream once names are loaded", async ({ page }) => {
  await scenario(page, "impact-large");
  await openImpact(page);
  const graph = page.getByRole("region", { name: "Lineage" });
  // Give the document and section names (loaded after the first paint) time to settle before
  // the grouped nodes' edges are read, so the two lists this item keeps in step are both named.
  await expect(graph.getByText("Scope", { exact: true }).first()).toBeVisible();
  const group = graph.getByTestId("lineage-group").filter({ hasText: "Wireframe" });
  await expect(group).toBeVisible();
  await group.click();
  const output = graph.getByTestId("lineage-output").first();
  await expect(output).toBeVisible();
  await output.click();
  // Picking an output highlights its upstream's path: only possible when the category node's
  // edges (built without names until this fix) and the subject column's (built with them)
  // keyed the same upstream the same way.
  await expect(graph.locator('[data-testid="lineage-upstream"][data-on-path="true"]').first()).toBeVisible();
});

test("priorities: a score step reads like the Score column, and confidence without a percent sign", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible();
  await page.getByRole("radiogroup", { name: "Ranking method" }).getByRole("radio", { name: "RICE" }).click();
  await expect(page.getByTestId("priority-row-F-2").getByTestId("score")).toHaveText("5,400");

  await page.getByTestId("priority-row-F-2").getByRole("button", { name: "Shipping cost shown in the cart" }).click();
  const steps = page.getByTestId("explanation-F-2").getByRole("list", { name: "Steps" });
  await expect(steps).toContainText("Score = 6,000 × 1 × 90 ÷ 1 = 5,400");
  await expect(steps).not.toContainText("5400");
  await expect(steps).not.toContainText("90%");
});

test("priorities: the Changes log names a retired override's anchor by the API's title, not its key", async ({ page }) => {
  await scenario(page, LEGACY_OVERRIDE_SCENARIO);
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible();
  const log = page.getByTestId("change-log");
  const row = log.getByRole("listitem").filter({ hasText: "Saved addresses at checkout" });
  await expect(row).toContainText("Moved above Shipping carrier picker");
  await expect(row).not.toContainText("F-99");
});
