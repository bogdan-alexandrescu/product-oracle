import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass on Company's own tabs (Strategy, Updates, Metrics, Market) and the shared header,
 * driven through the UI on the default mock scenario as the owner: no metrics, no
 * alternatives, no pricing memos, no deals, no vision or product strategy, and the two
 * seeded updates (Board update Sep 8 – Oct 20, Investor update Sep 1 – Sep 30). Each test
 * names the finding it protects.
 */

const nav = (page: Page) => page.getByRole("navigation", { name: "Company" }).filter({ visible: true });

async function openTab(page: Page, key: "strategy" | "decisions" | "rituals" | "updates" | "metrics" | "market") {
  await page.goto("/company/strategy");
  await expect(nav(page).getByTestId("company-tab-strategy")).toHaveAttribute("aria-current", "page");
  if (key === "strategy") return;
  await nav(page).getByTestId(`company-tab-${key}`).click();
  await expect(page).toHaveURL(new RegExp(`/company/${key}$`));
  await expect(nav(page).getByTestId(`company-tab-${key}`)).toHaveAttribute("aria-current", "page");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("qa-company-16: an empty Metrics says how it relates to the goal values on Home, with the Add action", async ({ page }) => {
    await login(page);
    await openTab(page, "metrics");
    const empty = page.getByTestId("metrics-empty").filter({ visible: true });
    await expect(empty).toContainText("No metrics yet");
    await expect(empty).toContainText("The goal values on Home come from each goal.");
    await expect(empty).toContainText("Add a metric here to track a number every week");
    await empty.getByRole("button", { name: "Add your first metric" }).click();
    await expect(page.getByRole("dialog", { name: "Add metric" })).toBeVisible();
  });

  test("qa-company-39: Add metric explains Output and Input and the query in plain words", async ({ page }) => {
    await login(page);
    await openTab(page, "metrics");
    // No metrics yet: the empty state's button is the one Add (qa-company-20).
    await page.getByTestId("metrics-empty").filter({ visible: true }).getByRole("button", { name: "Add your first metric" }).click();
    const dialog = page.getByRole("dialog", { name: "Add metric" });
    const kindHelp = dialog.getByTestId("metric-kind-help");
    await expect(kindHelp).toContainText("An output is a result the company wants");
    await dialog.getByLabel("Kind").selectOption("input");
    await expect(kindHelp).toContainText("An input is a number the team can move directly");
    await dialog.getByLabel("Kind").selectOption("output");
    await expect(dialog.getByText("HogQL")).toHaveCount(0);
    await expect(dialog.locator("#metric-query-help")).toContainText("A PostHog query that returns one number for a week");
  });

  test("qa-company-17, -50, -22: Updates share from the menu, periods use the shared range with an en dash and the year", async ({ page }) => {
    await login(page);
    await openTab(page, "updates");
    const board = page.getByTestId("update-row").filter({ hasText: "Board update · October 2026" });
    await expect(board.getByTestId("update-period")).toHaveText("Sep 8 – Oct 20, 2026");
    const investor = page.getByTestId("update-row").filter({ hasText: "Investor update · September 2026" });
    await expect(investor.getByTestId("update-period")).toHaveText("Sep 1 – Sep 30, 2026");
    // "Sept" as a short month, not inside "September" (a title).
    await expect(page.getByTestId("updates-table")).not.toContainText(/\bSept\b/);
    await expect(page.getByTestId("updates-table")).not.toContainText(" - ");
    await investor.getByRole("button", { name: "Share Investor update · September 2026 with the whole company" }).click();
    const dialog = page.getByRole("dialog", { name: "Share with the whole company" });
    await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeVisible();
  });

  test("qa-company-33: the tab strip stays put between tabs, and every tab has the same (i) beside Company", async ({ page }) => {
    await login(page);
    const tops: number[] = [];
    for (const key of ["strategy", "decisions", "updates", "metrics", "market"] as const) {
      await openTab(page, key);
      const header = page.locator("header[data-page-header]").filter({ visible: true });
      await expect(header.getByRole("button", { name: "About Company" })).toHaveCount(1);
      tops.push((await nav(page).boundingBox())!.y);
    }
    // Strategy, and the empty Metrics and Market (their empty states hold the Add), have no header button; Decisions and Updates do.
    for (const y of tops) expect(Math.abs(y - tops[0])).toBeLessThanOrEqual(0.5);
  });

  test("qa-company-36, -52: Strategy's empty pieces explain themselves; the drift pills sit 8 px apart", async ({ page }) => {
    await login(page);
    await openTab(page, "strategy");
    const vision = page.getByTestId("vision-empty").filter({ visible: true });
    await expect(vision).toContainText("No vision yet");
    await expect(vision).toContainText("Where the company is headed");
    await expect(vision).toContainText("Write a vision to start the strategy stack.");
    const strategy = page.getByTestId("strategy-empty").filter({ visible: true });
    await expect(strategy).toContainText("No product strategy yet");
    await expect(strategy).toContainText("each goal should follow from a focus choice");
    await expect(page.getByText("No approved strategy yet")).toHaveCount(0);

    const pills = page.getByRole("group", { name: "Finding state" }).filter({ visible: true }).getByRole("button");
    await expect(pills).toHaveCount(3);
    const a = (await pills.nth(0).boundingBox())!;
    const b = (await pills.nth(1).boundingBox())!;
    expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(7.5);
  });

  test("qa-company-37, -38: Market's empty states say what to do; its sub-tabs are underlined and line up with the cards", async ({ page }) => {
    await login(page);
    await openTab(page, "market");
    const alternatives = page.getByTestId("alternatives-empty").filter({ visible: true });
    await expect(alternatives).toContainText("No alternatives yet");
    await expect(alternatives).toContainText("Oracle then reads their public pages every week");
    await expect(alternatives.getByRole("button", { name: "Add your first alternative" })).toBeVisible();

    // One tab style per level: the sub-tabs are a tab list, not the Company pills, and
    // their first label starts where the card's content does.
    const tabs = page.getByRole("tablist", { name: "Market" });
    await expect(tabs.getByRole("tab", { name: "Alternatives" })).toHaveAttribute("aria-selected", "true");
    const [labelX, headingX] = await page.evaluate(() => {
      const tab = document.querySelector<HTMLElement>('[data-testid="market-tab-alternatives"]')!;
      const heading = [...document.querySelectorAll<HTMLElement>("h2")].find((h) => h.textContent === "Alternatives" && h.checkVisibility())!;
      return [tab.getBoundingClientRect().left + parseFloat(getComputedStyle(tab).paddingLeft), heading.getBoundingClientRect().left];
    });
    expect(Math.abs(labelX - headingX)).toBeLessThanOrEqual(2);

    await tabs.getByRole("tab", { name: "Change log" }).click();
    const changes = page.getByTestId("changes-empty");
    await expect(changes).toContainText("No changes yet");
    await expect(changes).toContainText("Add an alternative and its pages to start.");

    await tabs.getByRole("tab", { name: "Pricing" }).click();
    const pricing = page.getByTestId("pricing-empty");
    await expect(pricing).toContainText("No pricing memos yet");
    await expect(pricing).toContainText("A memo sets out one pricing question");
    await expect(pricing.getByRole("button", { name: "Write a pricing memo" })).toBeVisible();

    await tabs.getByRole("tab", { name: "Win and loss" }).click();
    const deals = page.getByTestId("deals-empty");
    await expect(deals).toContainText("No win or loss records yet");
    await expect(deals).toContainText("Record why each deal was won, lost or churned");
    await expect(deals.getByRole("button", { name: "Add a record" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });

  test("qa-company-34, -44: the page's primary button sits in the tab strip, labelled, after every tab", async ({ page }) => {
    // protects=qa-company-34 (no row of its own above the tabs) and qa-company-44 (a labelled
    // "+ Decision", not a bare "+"); fails_when=the button is an icon only, or sits outside
    // the strip; no_claim=which line it ends on.
    await login(page);
    for (const [key, name, label] of [
      ["decisions", "Propose decision", "Decision"],
      // Metrics has no header button here: with no metrics yet its empty state holds the Add (qa-company-20).
      ["updates", "New update", "Update"],
    ] as const) {
      await openTab(page, key);
      const button = page.getByRole("button", { name, exact: true }).filter({ visible: true });
      await expect(button).toHaveCount(1);
      await expect(button).toHaveText(label);
      const b = (await button.boundingBox())!;
      const n = (await nav(page).boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(n.y);
      expect(b.y + b.height).toBeLessThanOrEqual(n.y + n.height);
      expect(b.x + b.width).toBeLessThanOrEqual(n.x + n.width);
      const market = (await nav(page).getByTestId("company-tab-market").boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(market.y - 1);
      await button.click();
      await expect(page.getByRole("dialog", { name })).toBeVisible();
    }
  });

  test("qa-shell-34, qa-company-44: Market's sub-tabs all show, wrapping, with no scrollbar", async ({ page }) => {
    await login(page);
    await openTab(page, "market");
    const tabs = page.getByRole("tablist", { name: "Market" });
    for (const name of ["Alternatives", "Change log", "Positioning", "Pricing", "Win and loss"]) {
      await expect(tabs.getByRole("tab", { name })).toBeInViewport({ ratio: 1 });
    }
    const bar = await tabs.evaluate((el: HTMLElement) => el.offsetHeight - el.clientHeight);
    expect(bar).toBe(0);
    const pricing = tabs.getByRole("tab", { name: "Pricing" });
    await pricing.click();
    await expect(pricing).toHaveAttribute("aria-selected", "true");
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw);
  });
});
