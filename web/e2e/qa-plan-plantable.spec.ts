import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on /plan's Roadmap table, its PRD cards and its item inspector (group
 * "plantable"), driven through the UI on the mock layer:
 * - qa-plan-4 / qa-plan-5: the table fits its card at 1440 and 1512; Item, PRD and Goal read
 *   in full (two lines at most), the Next cell wraps instead of being cut.
 * - prod-4: a feature with several goals shows its first goal in full and "+2".
 * - qa-plan-32: a published PRD's card names its stage once.
 * - qa-plan-33: History has one line per event.
 * - prod-6: Why it needs you says what changed in words, never "feature:x changed".
 */

const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });

async function openPlan(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(rows(page).first()).toBeVisible();
}

/** Nothing in the element is cut: no sideways overflow, no clamped lines. */
async function notCut(el: Locator) {
  const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }));
  expect(m.sw, "cut sideways").toBeLessThanOrEqual(m.cw + 1);
  expect(m.sh, "cut below").toBeLessThanOrEqual(m.ch + 1);
}

for (const width of [1440, 1512]) {
  test(`at ${width} the Roadmap table fits its card and its cells read in full`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openPlan(page);
    const table = page.getByTestId("plan-table");
    // qa-plan-4: the table is no wider than its card.
    const fit = await table.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, tw: e.querySelector("table")!.getBoundingClientRect().width }));
    expect(fit.tw).toBeLessThanOrEqual(fit.cw + 1);
    expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1);
    const box = (await table.boundingBox())!;

    // The Next cell: the decision and who takes it, inside the card, nothing cut.
    const digest = row(page, "Daily alert digest email");
    const next = digest.getByTestId("plan-next");
    await expect(next).toHaveText("Owners decide on the slip");
    const nb = (await next.boundingBox())!;
    expect(nb.x + nb.width).toBeLessThanOrEqual(box.x + box.width + 1);
    await notCut(next);
    await expect(next.getByText("Owners decide on the slip")).toBeVisible();

    // qa-plan-5: Item, PRD and Goal readable; the PRD by its name, its version on hover.
    const threshold = row(page, "Threshold alerts on spend");
    await notCut(threshold.getByTestId("plan-title"));
    const prd = threshold.getByTestId("plan-prd");
    await expect(prd).toHaveText("Usage alerts");
    await expect(prd).toHaveAttribute("title", "Usage alerts PRD v1");
    await notCut(prd);
    await notCut(threshold.getByTestId("plan-goal").getByTestId("code-name"));
    await expect(threshold.getByTestId("plan-goal")).toHaveText("Raise activation");

    // prod-4: three goals read as the first in full and "+2", the others named on hover.
    const dashboard = row(page, "Usage dashboard");
    const goal = dashboard.getByTestId("plan-goal");
    await expect(goal.getByTestId("code-chip")).toHaveCount(1);
    await notCut(goal.getByTestId("code-name"));
    const more = goal.getByTestId("plan-goal-more");
    await expect(more).toHaveText("+2");
    await expect(more).toHaveAttribute("title", /Grow paid conversion.*Cut early churn/);
    const gb = (await goal.boundingBox())!;
    const mb = (await more.boundingBox())!;
    expect(mb.x + mb.width).toBeLessThanOrEqual(gb.x + gb.width + 1);
  });
}

test("a published PRD's card names its stage once", async ({ page }) => {
  await openPlan(page);
  const card = page.getByTestId("plan-prd-card").filter({ hasText: "Usage alerts" });
  await expect(card).toHaveAttribute("data-stage", "approved");
  const labels = card.getByTestId("journey-labels");
  // qa-plan-32: Plan's own end label ("Approved"), not the PRD journey's ("Publish").
  await expect(labels).toHaveText("IdeaApproved");
  await expect(labels.locator("b")).toHaveText("Approved");
});

test("an item's History has one line per event", async ({ page }) => {
  await openPlan(page);
  await row(page, "Threshold alerts on spend").getByTestId("plan-title").click();
  const lines = inspector(page).getByTestId("plan-history").getByTestId("plan-history-version");
  // qa-plan-17: the roadmap is never approved by default, so its item history agrees.
  await expect(lines).toHaveText(["PRD v1 Now · in a draft"]);
});

test("Why it needs you says what changed in words", async ({ page }) => {
  await openPlan(page);
  await row(page, "Daily alert digest email").getByTestId("plan-title").click();
  const why = inspector(page).getByTestId("plan-why");
  await expect(why).toContainText("The feature and 2 goals changed; the product was confirmed; 11 baseline items changed");
  await expect(why).not.toContainText("feature:");
  await expect(why).not.toContainText("goal:");
  await expect(why).not.toContainText("product:");
});

test("phone: a row with three goals reads the first and +2, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/plan");
  await expect(rows(page).first()).toBeVisible();
  const goal = row(page, "Usage dashboard").getByTestId("plan-goal");
  await expect(goal.getByTestId("plan-goal-more")).toHaveText("+2");
  await expect(row(page, "Threshold alerts on spend").getByTestId("plan-prd")).toHaveText("Usage alerts");
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
});
