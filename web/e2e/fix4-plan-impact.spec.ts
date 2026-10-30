import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * fix4 QA findings on the Impact explorer (/impact/entities/<id>, /impact/changes/<id> and a
 * PRD version's Impact), driven through the UI on the mock API. The "impact" scenario gives
 * checkout-redesign's v1 downstream outputs; "Checkout flow (user flow)" rests on the Guided
 * setup feature, and the acceptance tests on requirement R-90, since deleted.
 */

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** Baseline > a feature > "What if it changed?". */
async function openWhatIf(page: Page, key: string, title: string) {
  await login(page);
  await page.goto("/baseline");
  await page.getByTestId(`feature-${key}`).getByRole("button", { name: title }).click();
  await page.getByRole("dialog", { name: title }).getByRole("link", { name: "What if it changed?" }).click();
  await expect(page).toHaveURL(/\/impact\/entities\/[^/?]+$/);
}

/** PRDs > Checkout redesign > v2 > Impact. */
async function openVersionImpact(page: Page) {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("link", { name: "Impact", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
}

/** ... > Impact > Table > Acceptance tests > "Recorded change" (the R-90 deletion). */
async function openR90Change(page: Page) {
  await openVersionImpact(page);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
  await page.getByRole("grid", { name: "Affected outputs" }).getByText("Acceptance tests").first().click();
  await page.getByRole("complementary", { name: /Acceptance tests/ }).getByRole("link", { name: "Recorded change" }).first().click();
  await expect(page).toHaveURL(/\/impact\/changes\/[^/?]+\?from=/);
}

const flowTitle = "Checkout flow (user flow) v1";

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-plan-10: a what-if names the item by its title, never its baseline key", async ({ page }) => {
    await scenario(page, "impact");
    await openWhatIf(page, "f.guided-setup", "Guided setup");
    const sidebar = page.getByRole("complementary", { name: "Regeneration plan" });
    const planRow = sidebar.getByTestId("plan-row").filter({ hasText: flowTitle });
    await planRow.getByRole("button").first().click();
    await expect(planRow).toContainText("Guided setup changed");
    await expect(planRow).not.toContainText("f.guided-setup");

    await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
    await page.getByRole("grid", { name: "Affected outputs" }).getByText(flowTitle).first().click();
    const insp = page.getByRole("complementary", { name: flowTitle });
    await expect(insp).toContainText("Why it's affected");
    await expect(insp.getByRole("listitem").filter({ hasText: "Guided setup changed" }).first()).toBeVisible();
    await expect(insp.getByTestId("dependency").filter({ hasText: "Guided setup" })).toContainText("Guided setup · Feature");
    await expect(insp).not.toContainText("f.guided-setup");
    await expect(page.getByRole("grid", { name: "Affected outputs" })).not.toContainText("f.guided-setup");
  });

  test("qa-plan-11: the change's subject node fits its title and date, no word cut", async ({ page }) => {
    await scenario(page, "impact");
    await openR90Change(page);
    const node = page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-subject");
    await expect(node).toContainText("deleted");
    await expect(node).toContainText(/Recorded Oct 21, 2026/);
    const [title, date] = [node.locator("span").nth(0), node.locator("span").nth(1)];
    const t = (await title.boundingBox())!;
    const d = (await date.boundingBox())!;
    // The title ends above the date: they never run into each other.
    expect(t.y + t.height).toBeLessThanOrEqual(d.y + 1);
    // Nothing is clipped: the node holds all its text, and the title breaks between words.
    const fits = await node.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    const n = (await node.boundingBox())!;
    expect(d.y + d.height).toBeLessThanOrEqual(n.y + n.height);
    expect(await title.evaluate((el) => getComputedStyle(el).overflowWrap)).not.toBe("anywhere");
  });

  test("qa-plan-12: a change opened from a PRD's Impact leads back there, with PRDs in the rail", async ({ page }) => {
    await scenario(page, "impact");
    await openR90Change(page);
    const back = page.getByTestId("impact-back").filter({ visible: true });
    await expect(back).toHaveText("‹ Impact of Checkout redesign PRD v2");
    const nav = page.getByRole("navigation", { name: "Oracle" });
    await expect(nav.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
    await expect(nav.getByTestId("nav-baseline")).not.toHaveAttribute("aria-current", "page");
    await back.click();
    await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
  });

  test("qa-plan-41: the output's kind reads 'User flow' everywhere its title says user flow", async ({ page }) => {
    await scenario(page, "impact");
    await openWhatIf(page, "f.guided-setup", "Guided setup");
    await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table" }).click();
    const grid = page.getByRole("grid", { name: "Affected outputs" });
    await expect(grid).toContainText("User flow · 1");
    await expect(grid).not.toContainText("Wireframe · 1");
    await grid.getByText(flowTitle).first().click();
    const insp = page.getByRole("complementary", { name: flowTitle });
    await expect(insp).toContainText("User flow · v1");
    await expect(insp).not.toContainText("Wireframe · v1");
  });

  test("qa-plan-42: a preview's header chip says what would be affected, not stale", async ({ page }) => {
    await scenario(page, "impact");
    await openWhatIf(page, "f.guided-setup", "Guided setup");
    await expect(page.getByText("Preview only; nothing is marked stale", { exact: false }).first()).toBeVisible();
    const chip = page.locator("[data-page-header]").getByTestId("impact-count");
    await expect(chip).toHaveText("1 would be affected");
    await expect(page.locator("[data-page-header]").filter({ has: page.getByTestId("impact-count") })).not.toContainText("potentially stale");
  });

  test("qa-plan-43: the plan reads 'these acceptance tests'", async ({ page }) => {
    await scenario(page, "impact");
    await openVersionImpact(page);
    const sidebar = page.getByRole("complementary", { name: "Regeneration plan" });
    const tests = sidebar.getByTestId("plan-row").filter({ hasText: "Acceptance tests v1" });
    await expect(tests).toContainText("Propose a new version of these acceptance tests");
    await expect(sidebar).not.toContainText("this acceptance tests");
  });

  test("qa-plan-44: the plan's action is a neutral status chip, 'Plan: regenerate'", async ({ page }) => {
    await scenario(page, "impact");
    await openWhatIf(page, "f.guided-setup", "Guided setup");
    const sidebar = page.getByRole("complementary", { name: "Regeneration plan" });
    const chip = sidebar.getByTestId("plan-row").filter({ hasText: flowTitle }).getByTestId("plan-action");
    await expect(chip).toHaveText("Plan: regenerate");
    await expect(sidebar.getByText("Regenerate", { exact: true })).toHaveCount(0);
  });

  test("qa-plan-45: 'Reconcile…' is a bordered button like 'Mark reviewed'", async ({ page }) => {
    await scenario(page, "impact");
    await openWhatIf(page, "f.guided-setup", "Guided setup");
    const sidebar = page.getByRole("complementary", { name: "Regeneration plan" });
    const row = sidebar.getByTestId("plan-row").filter({ hasText: flowTitle });
    await row.getByRole("button").first().click();
    const reconcile = row.getByRole("button", { name: "Reconcile…" });
    const reviewed = row.getByRole("button", { name: "Mark reviewed" });
    await expect(reconcile).toBeVisible();
    await expect(reviewed).toBeVisible();
    const style = (el: Element) => {
      const s = getComputedStyle(el);
      return `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor} ${s.color}`;
    };
    expect(await reconcile.evaluate(style)).toBe(await reviewed.evaluate(style));
    expect(await reconcile.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
  });

  test("qa-plan-46: the lineage node shows the item's kind in full beside its what-if link", async ({ page }) => {
    await scenario(page, "impact");
    await openWhatIf(page, "f.guided-setup", "Guided setup");
    const upstream = page.getByRole("region", { name: "Lineage" }).getByTestId("lineage-upstream").filter({ hasText: "Guided setup" });
    const sub = upstream.getByTestId("lineage-upstream-sub");
    await expect(sub).toHaveText("Feature · locked");
    expect(await sub.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(upstream.getByRole("link", { name: "What if Guided setup changed?" })).toBeVisible();
  });

  test("qa-plan-47: an item nothing is built from says when Impact will show something", async ({ page }) => {
    await openWhatIf(page, "f.sample-data", "Sample data");
    const empty = page.getByTestId("impact-empty");
    await expect(empty).toContainText("No outputs depend on this item yet. Nothing to regenerate.");
    await expect(empty).toContainText("When a roadmap, spec or other output is built from it, Impact shows what a change to it would reach.");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-plan-62: a recorded change's full title is in the page body", async ({ page }) => {
    await scenario(page, "impact");
    await login(page);
    await page.goto("/documents/checkout-redesign/v/2/impact");
    // On a phone the table is the way to an output's sheet.
    await page.getByRole("button", { name: /Acceptance tests v1/ }).first().click();
    await page.getByRole("dialog").getByRole("link", { name: "Recorded change" }).first().click();
    await expect(page).toHaveURL(/\/impact\/changes\//);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Impact: Requirement “Guest checkout keeps the cart” deleted");
    await expect(h1).toBeVisible();
    // Wrapped, not cut: the whole heading fits the screen's width.
    const fits = await h1.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth);
    expect(fits).toBe(true);
  });
});
