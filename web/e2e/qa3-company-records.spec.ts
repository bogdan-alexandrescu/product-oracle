import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Third QA pass on Company › Strategy, Updates, Metrics and Market, and Simple's Home, driven
 * through the UI as a person would. The default mock scenario has no vision, no product
 * strategy, no drift findings, no metrics and no alternatives, and the two seeded updates
 * ("Investor update · September 2026" approved, "Board update · October 2026" in review). The
 * "market" scenario seeds three alternatives and a change log; "simple-home" seeds Simple's
 * roadmap with Weekly alert digest starting before Alert rules engine ends. Each test names the
 * finding it protects.
 */

const strategyPage = (page: Page) => page.getByTestId("strategy-page").filter({ visible: true });
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("qa-company-21: Drift's empty state reads 'Anything that does not shows up here.'", async ({ page }) => {
    await login(page);
    await page.goto("/company/strategy");
    const what = strategyPage(page).getByTestId("drift-list").getByTestId("drift-what");
    await expect(what).toContainText("vision and strategy are reviewed on time. Anything that does not shows up here.");
    await expect(what).not.toContainText("What does not shows here");
  });

  test("qa-company-22: a viewer's Vision and Product strategy cards have no empty footer bar", async ({ page }) => {
    await login(page, "viewer@example.com");
    await page.goto("/company/strategy");
    for (const kind of ["vision", "strategy"] as const) {
      const cardEl = strategyPage(page).getByTestId(`${kind}-card`);
      await expect(cardEl.getByTestId(`${kind}-empty`)).toBeVisible();
      await expect(cardEl.getByTestId(`${kind}-actions`)).toHaveCount(0);
      // Nothing under the empty state: no divider, no bar.
      const trailing = await cardEl.getByTestId(`${kind}-empty`).evaluate((el) => {
        let n = el.nextElementSibling;
        let count = 0;
        while (n) {
          count++;
          n = n.nextElementSibling;
        }
        return count;
      });
      expect(trailing).toBe(0);
    }
  });

  test("qa-company-22: an owner's cards keep their New button in the footer", async ({ page }) => {
    await login(page);
    await page.goto("/company/strategy");
    await expect(strategyPage(page).getByTestId("vision-actions").getByRole("button", { name: "New vision" })).toBeVisible();
    await expect(strategyPage(page).getByTestId("strategy-actions").getByRole("button", { name: "New product strategy" })).toBeVisible();
  });

  test("qa-company-23: Drift's empty state looks like the cards' and the stack's: bold title, the same text width", async ({ page }) => {
    await login(page);
    await page.goto("/company/strategy");
    const style = (testId: string) =>
      strategyPage(page)
        .getByTestId(testId)
        .evaluate((el) => {
          const [title, text] = [...el.querySelectorAll(":scope > p")] as HTMLElement[];
          return { weight: getComputedStyle(title).fontWeight, size: getComputedStyle(title).fontSize, maxWidth: getComputedStyle(text).maxWidth };
        });
    const stack = await style("stack-empty");
    const vision = await style("vision-empty");
    const drift = await style("drift-empty");
    expect(drift).toEqual(stack);
    expect(drift).toEqual(vision);
    expect(drift.weight).toBe("600");
    expect(drift.maxWidth).not.toBe("none");
    await expect(strategyPage(page).getByTestId("drift-empty").locator(":scope > p").first()).toHaveText("No open findings");
  });

  test("qa-company-24: New vision's Draft with Oracle says what it costs, and the dialog closes one way", async ({ page }) => {
    await login(page);
    await page.goto("/company/strategy");
    await strategyPage(page).getByTestId("vision-card").getByRole("button", { name: "New vision" }).click();
    const dialog = page.getByRole("dialog", { name: "New vision" });
    await expect(dialog.getByRole("button", { name: /^Draft with Oracle · \$\d+\.\d{2}$/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("qa-company-37: the share button says whom it shares with; the visibility is a flat chip", async ({ page }) => {
    await login(page);
    await page.goto("/company/updates");
    const row = page.getByTestId("update-row").filter({ hasText: "Board update · October 2026" });
    await expect(row.getByTestId("update-share")).toHaveText("Share with company…");
    const chip = row.getByTestId("update-visibility").locator(":scope > *");
    await expect(chip).toHaveText("Owners and approvers");
    await expect(chip).toHaveCSS("border-top-width", "0px");
    await expect(chip).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("qa-company-38: the board template has one name in the list, the New update dialog and the title", async ({ page }) => {
    await login(page);
    await page.goto("/company/updates");
    const row = page.getByTestId("update-row").filter({ hasText: "Board update · October 2026" });
    await expect(row).toContainText("Board update · October 2026");
    await expect(row.getByRole("gridcell").filter({ hasText: /^Board update$/ })).toHaveCount(1);
    await expect(page.getByTestId("update-row").filter({ hasText: "Investor update · September 2026" }).getByRole("gridcell").filter({ hasText: /^Investor update$/ })).toHaveCount(1);

    await page.getByRole("button", { name: "New update" }).click();
    const dialog = page.getByRole("dialog", { name: "New update" });
    await dialog.getByRole("radio", { name: /^Board update/ }).check();
    await expect(dialog).not.toContainText("Board product section");
    await expect(dialog.getByLabel("Title")).toHaveValue(/^Board update · /);
  });

  test("qa-company-39: an opened update names Oracle as its author and a real time, not a token or midnight", async ({ page }) => {
    await login(page);
    await page.goto("/company/updates");
    await page.getByRole("link", { name: "Board update · October 2026" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Board update · October 2026" })).toBeVisible();
    // The only version is the selected one: its details name who wrote it.
    const inspector = page.getByTestId("version-inspector").filter({ visible: true });
    await expect(inspector.getByTestId("version-importer")).toHaveText("Oracle");
    await expect(page.locator("main")).not.toContainText("API token");
    await expect(page.locator("main")).not.toContainText("12:00 AM");
  });

  test("qa-company-40: Add metric's Goal says to pick a unit when no goal can be offered yet", async ({ page }) => {
    await login(page);
    await page.goto("/company/metrics");
    await page.getByTestId("metrics-empty").filter({ visible: true }).getByRole("button", { name: "Add your first metric" }).click();
    const dialog = page.getByRole("dialog", { name: "Add metric" });
    const goal = dialog.getByLabel("Goal");
    await expect(goal.locator("option")).toHaveText(["Pick a unit to see goals measured in it"]);
    await expect(dialog.getByTestId("metric-goal-help")).toHaveText("Pick a unit to see goals measured in it.");
    await dialog.getByLabel("Unit", { exact: true }).fill("%");
    await expect(goal.locator("option").first()).toHaveText("No goal");
    await expect(dialog.getByTestId("metric-goal-help")).toContainText("Confirmed goals measured in the same unit.");
  });

  test("qa-company-41: an empty change log hides its filters and keeps the view toggle compact", async ({ page }) => {
    await login(page);
    await page.goto("/company/market?tab=changes");
    await expect(page.getByTestId("changes-empty").filter({ visible: true })).toContainText("No changes yet");
    const filters = page.getByTestId("change-filters").filter({ visible: true });
    await expect(filters.getByTestId("change-filter-row")).toHaveCount(0);
    await expect(filters.getByLabel("Month")).toHaveCount(0);
    const [toggle, card] = await Promise.all([
      filters.getByTestId("change-view").getByRole("group", { name: "View" }).boundingBox(),
      filters.boundingBox(),
    ]);
    expect(toggle!.width).toBeLessThan(card!.width / 2);
  });

  test("qa-company-41: with changes the filters show, and the Month filter reads in words", async ({ page }) => {
    await scenario(page, "market");
    await login(page, "approver@example.com");
    await page.goto("/company/market?tab=changes");
    await expect(page.getByTestId("change-row").first()).toBeVisible();
    const month = page.getByTestId("change-filter-row").filter({ visible: true }).getByLabel("Month");
    await expect(month.locator("option").first()).toHaveText("Every month");
    await expect(month.locator("option").nth(1)).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
    await expect(page.locator('input[type="month"]')).toHaveCount(0);
  });

  test("qa-company-42: Positioning's Market category hint says what it is in plain words", async ({ page }) => {
    await login(page);
    await page.goto("/company/market?tab=positioning");
    const field = page.locator('[data-testid="positioning-field"][data-field="market_category"]').filter({ visible: true });
    await expect(field).toContainText("The market buyers would put the company in.");
    await expect(field).not.toContainText("People choose it");
  });

  test("qa-company-43: Market's header has Add alternative on the Change log too, and it opens the Add form", async ({ page }) => {
    await scenario(page, "market");
    await login(page, "approver@example.com");
    await page.goto("/company/market?tab=changes");
    await expect(page.getByTestId("change-row").first()).toBeVisible();
    const add = page.getByRole("button", { name: "Add alternative", exact: true }).filter({ visible: true });
    await expect(add).toHaveCount(1);
    await add.click();
    await expect(page.getByRole("dialog", { name: "Add alternative" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Market" }).getByRole("tab", { name: "Alternatives" })).toHaveAttribute("aria-selected", "true");
  });
});

test("qa-company-47: Simple Home's broken-link lines quote item names in curly quotes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await scenario(page, "simple-home");
  await login(page);
  await page.goto("/simple");
  const broken = page.getByTestId("home-plan").getByTestId("home-broken").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "which it depends on" });
  await expect(broken.first()).toContainText("‘Weekly alert digest’ starts");
  await expect(broken.first()).toContainText("but ‘Alert rules engine’, which it depends on, ends");
  await expect(page.getByTestId("home-plan")).not.toContainText("'Weekly alert digest'");
});
