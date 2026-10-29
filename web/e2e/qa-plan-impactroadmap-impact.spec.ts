import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA plan findings on the Impact explorer (qa-plan-10, 58, 59, 60, 61), on the mock API.
 * The "impact" scenario gives checkout-redesign's v1 downstream outputs; a recorded change
 * edited the Success metrics section in v2, and the Saved addresses tech brief was built on it.
 */

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** The checkout PRD's v2 Impact screen, opened from the version's toolbar. */
async function openVersionImpact(page: Page) {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("link", { name: "Impact", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
}

/** The recorded change behind the Saved addresses tech brief, opened from its inspector. */
async function openRecordedChange(page: Page) {
  await openVersionImpact(page);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await page.getByRole("grid", { name: "Affected outputs" }).getByText("Saved addresses tech brief").click();
  await page.getByRole("complementary", { name: /Saved addresses tech brief/ }).getByRole("link", { name: "Recorded change" }).click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/]+$/);
}

const SUBJECT = "Checkout redesign PRD v2 › Success metrics section edited";

test("qa-plan-10/61: a recorded change is named in words, in the heading and the lineage, with no internal refs", async ({ page }) => {
  await scenario(page, "impact");
  await openRecordedChange(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Impact: ${SUBJECT}`);
  const graph = page.getByRole("region", { name: "Lineage" });
  await expect(graph.getByTestId("lineage-subject")).toContainText(SUBJECT);
  await expect(graph.getByTestId("lineage-upstream").filter({ hasText: "Success metrics" })).toBeVisible();
  const main = page.locator("main");
  await expect(main).not.toContainText("checkout-redesign@2");
  await expect(main).not.toContainText("#metrics");
  await expect(main).not.toContainText("section metrics changed");

  // The table's inspector: the reason in words, and no code-font chips.
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await page.getByRole("grid", { name: "Affected outputs" }).getByText("Saved addresses tech brief").click();
  const inspector = page.getByRole("complementary", { name: /Saved addresses tech brief/ });
  await expect(inspector.getByText("The “Success metrics” section changed in Checkout redesign PRD")).toBeVisible();
  await expect(inspector.getByTestId("dependency")).toContainText("Checkout redesign PRD v1 · Success metrics");
  await expect(inspector.locator("code")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Regeneration plan" }).locator("code")).toHaveCount(0);
});

test("qa-plan-58: the section a change reached names the same version as the change", async ({ page }) => {
  await scenario(page, "impact");
  await openRecordedChange(page);
  const graph = page.getByRole("region", { name: "Lineage" });
  const sub = graph.getByTestId("lineage-upstream").filter({ hasText: "Success metrics" }).getByTestId("lineage-upstream-sub");
  await expect(sub).toHaveText("Section of Checkout redesign PRD v2");
  // The version the outputs were built on is said on hover, not as a second, clashing version.
  await expect(sub).toHaveAttribute("title", "Section of Checkout redesign PRD v2. Outputs were built on v1.");
});

test("qa-plan-59: a recorded change leads back to its version, with PRDs highlighted", async ({ page }) => {
  await scenario(page, "impact");
  await openRecordedChange(page);
  const nav = page.getByRole("navigation", { name: "Oracle" });
  await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
  // The what-if page it was opened from may still be mounted, hidden; the shown header is the change's.
  const back = page.getByTestId("impact-back").filter({ visible: true });
  await expect(back).toHaveText("← Checkout redesign PRD v2");
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2$/);
});

test("qa-plan-59/61: a baseline item's what-if reads 'Impact: Guided setup' and leads back to Baseline", async ({ page }) => {
  await scenario(page, "impact");
  await login(page);
  await page.goto("/baseline");
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  await page.getByRole("dialog", { name: "Guided setup" }).getByRole("link", { name: "What if it changed?" }).click();
  await expect(page).toHaveURL(/\/impact\/entities\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Impact: Guided setup");
  const nav = page.getByRole("navigation", { name: "Oracle" });
  await expect(nav.getByTestId("nav-baseline")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("impact-back").click();
  await expect(page).toHaveURL(/\/baseline$/);
});

test("qa-plan-10: the plan names sections by their headings, not their keys", async ({ page }) => {
  await scenario(page, "impact");
  await openVersionImpact(page);
  await page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-output").filter({ hasText: "Checkout flow" }).click();
  const plan = page.getByRole("complementary", { name: "Regeneration plan" });
  const row = plan.getByTestId("plan-row").filter({ hasText: "Checkout flow" });
  await expect(row.getByTestId("plan-sections")).toHaveText("Scope");
  await expect(row.getByTestId("plan-how")).toContainText("covering only the “Scope” section");
  await expect(plan.locator("code")).toHaveCount(0);
  const roadmap = plan.getByTestId("plan-row").filter({ hasText: "Usage alerts roadmap" });
  await expect(roadmap).not.toContainText("prd_to_roadmap");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-plan-60: on a phone the lineage says how big the plan is and to tap an output", async ({ page }) => {
    await scenario(page, "impact");
    await login(page);
    await page.goto("/documents/checkout-redesign/v/2/impact");
    const list = page.getByRole("region", { name: "Affected outputs" });
    await expect(list.getByTestId("impact-phone-hint")).toHaveText(
      "The regeneration plan has 6 proposals. Tap an output to see its proposal and act on it.",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await list.getByRole("button", { name: /Checkout flow/ }).click();
    await expect(page.getByRole("dialog", { name: /Checkout flow/ }).getByText("1 · Settle staleness")).toBeVisible();
  });
});
