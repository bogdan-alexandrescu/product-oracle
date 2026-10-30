import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 3 on Home (Detailed): Needs you's counts read as text, not buttons, and its "more"
 * footer keeps its icon beside the link on a phone; In flight's Progress says its unit and
 * Next says what comes after the current step; a goal's name opens the goal and its value
 * keeps its target on one line on a phone; Set up's count reads the same open or hidden; a
 * viewer's empty Needs you says what shows there.
 *
 * no_claim for every test here: the in-browser mock's lists stand in for the API.
 */

async function openHome(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
}

const flightTable = (page: Page) => page.getByTestId("home-in-flight-table");
const flight = (page: Page, slug: string, kind: "prd" | "run" = "run") =>
  page.locator(`[data-testid="flight-row"][data-kind="${kind}"][data-document="${slug}"]`);
const column = (page: Page, name: string) =>
  flightTable(page).evaluate((el, n) => [...el.querySelectorAll("th")].findIndex((th) => th.textContent?.trim() === n), name);

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Needs you's counts are flat text, not pills that look like buttons", async ({ page }) => {
    // protects=qa-company-6; fails_when=a count is drawn as an outlined pill, a link or a
    // button while it does nothing; no_claim=the Inbox's own tabs.
    await openHome(page);
    const needs = page.getByTestId("home-needs");
    await expect(needs.getByTestId("home-count-approvals")).toHaveText("Approvals 3");
    for (const id of ["home-count-approvals", "home-count-reviews", "home-count-questions", "home-count-access"]) {
      const count = needs.getByTestId(id);
      await expect(count).toBeVisible();
      const look = await count.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth),
          clickable: !!el.closest("a, button, [role=button]"),
          kind: el.getAttribute("data-kind"),
        };
      });
      expect(look).toEqual({ border: 0, clickable: false, kind: null });
    }
  });

  test("In flight: Progress names its unit, Next is what comes after the current step", async ({ page }) => {
    // protects=qa-company-8/-9; fails_when=Progress reads "Step 8/9", "1/4" or "Paused at
    // 1/1", or a PRD in review shows Next "Review"; no_claim=the phone's compact rows.
    await openHome(page);
    const prd = flight(page, "checkout-redesign", "prd");
    await expect(prd).toBeVisible();
    const progress = await column(page, "Progress");
    const next = await column(page, "Next");
    expect(progress).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(-1);

    await expect(prd.locator("td").nth(progress)).toHaveText("Step 8 of 9");
    await expect(prd.locator("td").nth(next)).toHaveText("Publish");
    await expect(flight(page, "team-workspaces").getByTestId("row-paused")).toHaveText(/^Paused at segment \d+ of \d+$/);
    // A run waiting on a person: Next is that person's step.
    await expect(flight(page, "team-onboarding").locator("td").nth(next)).toHaveText("Confirm the baseline");
    await expect(flight(page, "team-onboarding").getByTestId("row-segments")).toHaveText(/^Segment \d+ of \d+$/);

    // No bare "n/m" anywhere in Progress.
    const cells = await flightTable(page)
      .locator('[data-testid="flight-row"]')
      .evaluateAll((rows, col) => rows.map((r) => r.children[col]?.textContent?.trim() ?? ""), progress);
    expect(cells.length).toBeGreaterThan(2);
    for (const text of cells) expect(text).not.toMatch(/\d+\/\d+/);
  });

  test("a goal's name opens the goal; no card repeats it over the figure", async ({ page }) => {
    // protects=qa-company-10; fails_when=clicking the goal opens a tooltip-role card holding
    // only the name, target and an Open link; no_claim=Plan's goal chips (their own card).
    await openHome(page);
    const g1 = page.getByTestId("home-goal-G1");
    await expect(g1).toBeVisible();
    const name = g1.getByRole("link").first();
    await expect(name).toHaveAttribute("href", /^\/baseline\?entity=/);
    await expect(g1.getByTestId("code-chip")).toHaveCount(0);
    await name.click();
    await expect(page).toHaveURL(/\/baseline\?entity=/);
  });

  test("Set up's count reads the same open and hidden", async ({ page }) => {
    // protects=qa-company-13; fails_when=the hidden chip says "2/8" while the panel says "2 of
    // 8"; no_claim=other people's choice.
    await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
    await openHome(page);
    const panel = page.getByTestId("home-setup");
    await expect(panel.getByTestId("panel-count")).toHaveText("2 of 8");
    await panel.getByRole("button", { name: "Hide" }).click();
    const chip = page.getByTestId("home-setup-chip");
    await expect(chip).toHaveText("Set up 2 of 8");
    await expect(chip).not.toContainText("/");
    await chip.click();
    await expect(panel.getByTestId("panel-count")).toHaveText("2 of 8");
  });

  test("a viewer's empty Needs you says what shows there and where to go", async ({ page }) => {
    // protects=qa-company-14; fails_when=a viewer with nothing waiting reads only "Nothing
    // waiting"; no_claim=what other roles read.
    await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
    await openHome(page, "viewer@example.com");
    const empty = page.getByTestId("home-needs-empty");
    await expect(empty).toContainText("Nothing waiting");
    await expect(empty.getByTestId("home-needs-empty-what")).toHaveText("Questions someone asks you show here.");
    await empty.getByRole("link", { name: "Read the plan" }).click();
    await expect(page).toHaveURL(/\/plan$/);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a goal's value keeps its target on the same line", async ({ page }) => {
    // protects=qa-company-11; fails_when="38%" sits above "/ 45%", or "–" above "/ below 8%";
    // no_claim=wider screens.
    await openHome(page);
    for (const tag of ["G1", "G3"]) {
      const figure = page.getByTestId(`home-goal-${tag}`).getByTestId("goal-figure");
      await expect(figure).toBeVisible();
      await expect(figure).toContainText("/");
      const [value, target] = await figure.evaluate((el) =>
        [el.querySelector(":scope > b")!, el.querySelector(":scope > span")!].map((n) => {
          const r = n.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        }),
      );
      // Side by side: the target starts right of the value and overlaps it vertically.
      expect(target.left).toBeGreaterThanOrEqual(value.right - 1);
      expect(target.top).toBeLessThan(value.bottom);
      expect(target.bottom).toBeGreaterThan(value.top);
    }
  });

  test("Needs you's footer keeps its icon beside '+N more in Inbox'", async ({ page }) => {
    // protects=qa-company-12; fails_when=the link sits above a 'More' label and its icon;
    // no_claim=the lines above it.
    await openHome(page);
    const footer = page.getByTestId("home-needs-footer");
    const link = footer.getByTestId("home-needs-more");
    await expect(link).toHaveText("+5 more in Inbox");
    await expect(footer).not.toContainText("More");
    const [icon, text] = await footer.evaluate((el) =>
      [el.querySelector("svg")!, el.querySelector("a")!].map((n) => {
        const r = n.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }),
    );
    expect(icon.right).toBeLessThanOrEqual(text.left);
    expect(icon.top).toBeLessThan(text.bottom);
    expect(icon.bottom).toBeGreaterThan(text.top);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
