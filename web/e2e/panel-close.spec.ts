import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { LONG_GOALS_SCENARIO, ranking } from "../lib/api/mock/lane-f";
import { login } from "./helpers";

/*
 * panel-close: in Detailed, a page's side panel closes with an × in its head, beside its title,
 * or with Esc; the table takes its room and focus goes back to the selected row. Picking a row
 * opens the panel again on that row. Priorities and Company › Decisions show it; every page with
 * a side panel and a table to pick from has the same ×. A phone at 390 px is unchanged.
 * protects=the × and Esc close the panel, the table widens, focus returns to the row, a picked
 * row reopens it; fails_when=no ×, the panel stays, the table keeps its width, focus is lost.
 */

const close = (page: Page) => page.getByRole("button", { name: "Close the details" });
const featurePanel = (page: Page) => page.getByTestId("priority-inspector");
const decisionPanel = (page: Page) => page.getByTestId("decision-inspector");
const width = async (l: Locator) => (await l.boundingBox())!.width;
const header = (page: Page, name: string) => page.getByTestId("priority-table").getByRole("columnheader", { name, exact: true });

async function openPriorities(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, LONG_GOALS_SCENARIO] as const);
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]')).toHaveCount(14);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

const row = (page: Page, title: string) =>
  page.locator('tr[data-testid^="priority-row-"]').filter({ has: page.getByTestId("feature-name").getByText(title, { exact: true }) });

/** Words in the Goal, Feature and Depends on cells that break inside themselves (priorities-words). */
function cutWords(page: Page) {
  return page.evaluate(() => {
    const cut: string[] = [];
    const cells = document.querySelectorAll<HTMLElement>(
      'tr[data-testid^="priority-row-"] :is([data-testid="row-goals"], [data-testid="feature-name"], [data-testid="row-deps"])',
    );
    for (const cell of cells) {
      if (!cell.checkVisibility()) continue;
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (const m of node.data.matchAll(/\S+/g)) {
          let top: number | null = null;
          for (let i = 0; i < m[0].length; i++) {
            const r = document.createRange();
            r.setStart(node, m.index + i);
            r.setEnd(node, m.index + i + 1);
            const rect = [...r.getClientRects()].filter((x) => x.width > 0).at(-1);
            if (!rect) continue;
            if (top != null && rect.top > top + 4 && !/[-­]/.test(m[0][i - 1])) {
              cut.push(m[0]);
              break;
            }
            top = rect.top;
          }
        }
      }
    }
    return cut;
  });
}

const focusRinged = (l: Locator) => l.evaluate((el) => el === document.activeElement && el.matches(":focus-visible"));

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Priorities: the × closes the panel, the table takes its room, focus back on the row", async ({ page }) => {
    await openPriorities(page);
    const top = row(page, "Address lookup service");
    await expect(top).toHaveAttribute("aria-selected", "true");
    await expect(featurePanel(page).getByRole("heading", { name: "Address lookup service" })).toBeVisible();
    // The × sits in the panel's head, after the page in Tab order.
    await expect(featurePanel(page).getByRole("button", { name: "Close the details" })).toBeVisible();

    const table = page.getByTestId("priority-table");
    const before = { table: await width(table), goal: await width(header(page, "Goal")), deps: await width(header(page, "Depends on")) };

    await close(page).click();
    await expect(featurePanel(page)).toBeHidden();
    await expect(close(page)).toHaveCount(0);
    await expect(top).toBeFocused();

    // The table takes the panel's room; Goal and Depends on get wider, words still whole.
    await expect.poll(() => width(table)).toBeGreaterThan(before.table + 300);
    expect(await width(header(page, "Goal"))).toBeGreaterThan(before.goal + 60);
    expect(await width(header(page, "Depends on"))).toBeGreaterThan(before.deps + 60);
    expect(await cutWords(page)).toEqual([]);
  });

  test("Priorities: picking a row opens the panel again on it, and Esc closes it", async ({ page }) => {
    await openPriorities(page);
    const table = page.getByTestId("priority-table");
    const open = await width(table);
    await close(page).click();
    await expect(featurePanel(page)).toBeHidden();

    const guided = row(page, "Guided first project with sample tasks");
    await guided.getByTestId("feature-name").click();
    await expect(featurePanel(page).getByRole("heading", { name: "Guided first project with sample tasks" })).toBeVisible();
    await expect(guided).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => width(table)).toBeLessThan(open + 2);

    await page.keyboard.press("Escape");
    await expect(featurePanel(page)).toBeHidden();
    await expect(guided).toBeFocused();
    expect(await focusRinged(guided)).toBe(true);

    // Enter on a row opens it again too.
    await page.keyboard.press("ArrowDown");
    await expect(featurePanel(page)).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(featurePanel(page)).toBeVisible();
  });

  test("Company › Decisions: the same × and Esc close its panel; picking a decision opens it", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    const rows = page.getByTestId("decision-row");
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    const panel = decisionPanel(page);
    await expect(panel).toBeVisible();
    const table = page.getByRole("grid", { name: "Decisions" });
    const open = await width(table);

    await panel.getByRole("button", { name: "Close the details" }).click();
    await expect(panel).toBeHidden();
    await expect(rows.first()).toBeFocused();
    await expect.poll(() => width(table)).toBeGreaterThan(open + 300);

    const second = rows.nth(1);
    const title = (await second.getByRole("gridcell").nth(1).innerText()).trim();
    await second.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: title })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(second).toBeFocused();
    expect(await focusRinged(second)).toBe(true);
  });

  test("Esc in a text field leaves the field, not the panel", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    const panel = decisionPanel(page);
    await expect(panel).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search decisions" });
    await search.click();
    await search.pressSequentially("pricing");
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await expect(search).toBeFocused();
  });

  test("Baseline: a blocker's panel has one ×; it and Esc close the panel, focus back on the row", async ({ page }) => {
    await login(page);
    await page.goto("/baseline?tab=blockers");
    const row = page.getByTestId("blocker-row").filter({ hasText: "Same-day refund rule unanswered" });
    await row.click();
    const panel = page.getByTestId("blocker-inspector");
    await expect(panel.getByRole("heading", { name: "Same-day refund rule unanswered" })).toBeVisible();
    // One close control in the head: the same × as every other page.
    await expect(panel.getByRole("button", { name: /close/i })).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "Close the details" })).toBeVisible();

    await panel.getByRole("button", { name: "Close the details" }).click();
    await expect(panel).toHaveCount(0);
    await expect(row).toBeFocused();

    // Esc in a field of the panel leaves the field; Esc then closes the panel.
    await row.click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Propose option" }).click();
    const title = panel.getByRole("form", { name: "Propose option" }).getByLabel("Title");
    await title.fill("Ask the payments team");
    await title.press("Escape");
    await expect(panel).toBeVisible();
    await expect(title).toHaveValue("Ask the payments team");
    await panel.getByRole("heading", { name: "Same-day refund rule unanswered" }).click();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("Baseline: a goal's panel has one ×, which closes it", async ({ page }) => {
    await login(page);
    await page.goto("/baseline");
    const goal = page.getByTestId("goal-g.activation");
    await expect(goal).toBeVisible();
    await goal.getByRole("button", { name: "Raise activation", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Raise activation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: /close/i })).toHaveCount(1);
    await drawer.getByRole("button", { name: "Close the details" }).click();
    await expect(drawer).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Priorities: no ×; a feature opens in the bottom sheet, which closes as before", async ({ page }) => {
    await openPriorities(page);
    await expect(close(page)).toBeHidden();
    await row(page, "Guided first project with sample tasks").getByRole("button", { name: /Guided first project with sample tasks/ }).click();
    const sheet = page.getByTestId("priority-sheet");
    await expect(sheet.getByRole("dialog")).toBeVisible();
    await expect(close(page)).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("priority-table")).toBeVisible();
  });

  test("Company › Decisions: a decision opens in its sheet, with no ×, which closes as before", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await page.getByTestId("decision-row").nth(1).click();
    const sheet = page.getByTestId("decision-sheet");
    await expect(sheet.getByRole("dialog")).toBeVisible();
    await expect(decisionPanel(page).filter({ visible: true })).toHaveCount(1);
    await expect(close(page)).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("grid", { name: "Decisions" })).toBeVisible();
  });
});

// The mock's long-goals features come from the scenario each time it ranks, never from a list
// an earlier scenario changed: a ranking under any other scenario has none of them.
test("mock: the long-goals features show in their scenario only", () => {
  const keys = () => ranking("goal_weighted").features.map((f) => f.key);
  const store = new Map<string, string>([[MOCK_SCENARIO_KEY, LONG_GOALS_SCENARIO]]);
  const g = globalThis as { localStorage?: Pick<Storage, "getItem"> };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null };
  try {
    expect(keys()).toHaveLength(14);
    expect(keys()).toContain("F-9");
    store.set(MOCK_SCENARIO_KEY, "default");
    expect(keys()).toHaveLength(8);
    expect(keys()).not.toContain("F-9");
  } finally {
    delete g.localStorage;
  }
  expect(keys()).not.toContain("F-9");
});
