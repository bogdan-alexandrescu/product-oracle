import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA round 2 on Home (Detailed), the default company: Needs you's counts are plain counts
 * (qa-company-5), the selected PRD's blocker and stat labels are never cut (qa-company-25,
 * -26), Needs you's item and For wrap rather than cut (qa-company-27), In flight is its own
 * panel with one style of Next (qa-company-31), Goals one per row on a phone with the
 * inspector on a tap (qa-company-32), and Set up's Invite team and done rows (qa-onboarding-18,
 * -37).
 *
 * no_claim for every test here: the in-browser mock stands in for the API.
 */

async function openHome(page: Page) {
  await login(page);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
  await expect(page.getByTestId("home-goal-G1")).toBeVisible();
  await expect(page.getByTestId("home-needs-table").locator("tr[data-row]").first()).toBeVisible();
}

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Needs you's counts are plain counts, not links that seem to filter", async ({ page }) => {
    // protects=qa-company-5; fails_when=a count chip is a link (all went to the same unfiltered
    // Inbox); no_claim=the Inbox's own tabs.
    await openHome(page);
    const needs = page.getByTestId("home-needs");
    await expect(needs.getByTestId("home-count-approvals")).toBeVisible();
    for (const id of ["home-count-approvals", "home-count-reviews", "home-count-questions", "home-count-access", "home-count-runs"]) {
      const chip = needs.getByTestId(id);
      if ((await chip.count()) === 0) continue;
      expect(await chip.evaluate((el) => el.closest("a") === null)).toBe(true);
    }
    // The Inbox link beside them is the one way to the Inbox.
    await needs.getByTestId("home-inbox-link").click();
    await expect(page).toHaveURL(/\/inbox$/);
  });

  test("the selected PRD's blocker wraps, and its stats' labels are whole", async ({ page }) => {
    // protects=qa-company-25, -26; fails_when=a blocker line is cut on one line ("...100
    // requests a") or a stat label ends cut ("Sections appr…"); no_claim=other inspectors.
    await openHome(page);
    const inspector = page.getByTestId("home-inspector");
    const blocker = inspector.getByTestId("inspector-blocker").filter({ hasText: "The address lookup service allows 100 requests a minute per company" });
    await expect(blocker).toBeVisible();
    await expect(blocker).toHaveAttribute("title", "The address lookup service allows 100 requests a minute per company");
    const text = await blocker.evaluate((el) => {
      const t = el.lastElementChild as HTMLElement;
      const cs = getComputedStyle(t);
      return { clamp: cs.webkitLineClamp, nowrap: cs.whiteSpace === "nowrap", cut: t.scrollWidth > t.clientWidth + 1 };
    });
    expect(text).toEqual({ clamp: "2", nowrap: false, cut: false });

    const stat = inspector.getByTestId("stat-sections");
    await expect(stat).toContainText("Approved");
    // Every stat label shows whole: none is wider than its box.
    const cut = await inspector.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>("[data-testid^=stat-] .truncate")].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent),
    );
    expect(cut).toEqual([]);
  });

  test("Needs you's item and For wrap to a second line instead of being cut", async ({ page }) => {
    // protects=qa-company-27; fails_when=an item or its For is cut on one line at 1440 with
    // the inspector open; no_claim=the Inbox page's own table.
    await openHome(page);
    // The item (2nd) and For (3rd) cells: none holds its words on one cut line.
    const cutOff = await page.getByTestId("home-needs-table").evaluate((table) =>
      [...table.querySelectorAll<HTMLElement>("tr[data-row] > td:nth-child(2), tr[data-row] > td:nth-child(3)")]
        .flatMap((td) => [td, ...td.querySelectorAll<HTMLElement>(".truncate")])
        .filter((el) => el.checkVisibility() && getComputedStyle(el).whiteSpace === "nowrap")
        .map((el) => el.textContent),
    );
    expect(cutOff).toEqual([]);
  });

  test("In flight is its own panel, apart from Needs you, and Next reads in one style", async ({ page }) => {
    // protects=qa-company-31; fails_when=In flight sits inside the Needs you card with no gap,
    // or Next mixes a chip (Review) with plain words (Cost approval); no_claim=the phone layout.
    await openHome(page);
    const [needsBottom, flightTop, inside] = await page.evaluate(() => {
      const needs = document.querySelector("[data-testid=home-needs]")!;
      const flight = document.querySelector("[data-testid=home-in-flight]")!;
      return [needs.getBoundingClientRect().bottom, flight.getBoundingClientRect().top, needs.contains(flight)];
    });
    expect(inside).toBe(false);
    expect(flightTop - needsBottom).toBeGreaterThanOrEqual(8);
    const table = page.getByTestId("home-in-flight-table");
    await expect(table.getByRole("columnheader", { name: "Next" })).toBeAttached();
    const prd = table.locator('[data-testid="flight-row"][data-kind="prd"]').first();
    await expect(prd).toBeVisible();
    const nextCol = await table.evaluate((el) => [...el.querySelectorAll("th")].findIndex((th) => th.textContent?.trim() === "Next"));
    expect(nextCol).toBeGreaterThan(-1);
    const chips = await table.evaluate(
      (el, col) => [...el.querySelectorAll('[data-testid="flight-row"]')].filter((tr) => tr.children[col]?.querySelector("[data-kind]")).length,
      nextCol,
    );
    expect(chips).toBe(0);
    // qa-company-9: the step after the one it is at (Review), not Review again.
    await expect(prd.locator("td").nth(nextCol)).toHaveText("Publish");
  });

  test("Set up: Invite team counts open invites, done rows say Change or Review", async ({ page }) => {
    // protects=qa-onboarding-18, -37; fails_when=Invite team leaves out the open invites, or a
    // done row still says Open (Build baseline would start a second build); no_claim=the API
    // (api/tests/test_setup.py covers invited).
    await openHome(page);
    const invite = page.getByTestId("setup-row-invite");
    await expect(invite).toHaveAttribute("data-done", "true");
    await expect(invite.getByTestId("setup-status")).toHaveText(/^\d+ people · 2 invited$/);
    await expect(invite.getByTestId("setup-action")).toHaveText("Change");
    const build = page.getByTestId("setup-row-build_baseline");
    await expect(build).toHaveAttribute("data-done", "true");
    await expect(build.getByTestId("setup-action")).toHaveText("Review");
    await expect(build.getByTestId("setup-action")).toHaveAttribute("href", "/baseline");
    // A step still to do keeps Open.
    await expect(page.getByTestId("setup-row-connect").getByTestId("setup-action")).toHaveText("Open");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Goals stack one per row; the PRD panel opens on a tap, right under In flight", async ({ page }) => {
    // protects=qa-company-32; fails_when=goals sit two per row (one alone at half width) or the
    // PRD panel lands untapped at the page's foot; no_claim=other phone widths.
    await openHome(page);
    const panel = (await page.getByTestId("home-goals").boundingBox())!;
    for (const tag of ["G1", "G2", "G3"]) {
      const card = page.getByTestId(`home-goal-${tag}`).first();
      if ((await card.count()) === 0) continue;
      const box = (await card.boundingBox())!;
      expect(box.width).toBeGreaterThan(panel.width - 8);
    }
    await expect(page.getByTestId("home-inspector")).toBeHidden();
    const row = page.getByTestId("home-in-flight-table").getByTestId("flight-row").first();
    await row.click();
    const inspector = page.getByTestId("home-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toBeInViewport();
    const [flightBottom, cardTop] = await page.evaluate(() => [
      document.querySelector("[data-testid=home-in-flight]")!.getBoundingClientRect().bottom,
      document.querySelector("[data-testid=home-inspector]")!.getBoundingClientRect().top,
    ]);
    expect(cardTop).toBeGreaterThanOrEqual(flightBottom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
