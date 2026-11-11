import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The Goal map at real volume, drawn as the goals by tracks grid (the owner's pick of Nov 11),
 * driven through the UI against the mock ("goal-ladder", invented data: four goals, twelve
 * milestones, 63 features, about 40 dependencies). Owner, commenter and viewer; 1440, 1512 and
 * 390; light and dark.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const SIZES = { 1440: { width: 1440, height: 900 }, 1512: { width: 1512, height: 945 } } as const;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scheme: "light" | "dark", role?: "commenter" | "viewer") {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  if (role) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_ROLE_KEY, role] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple");
  if (page.viewportSize()!.width <= 600) {
    await page.getByTestId("simple-tab-more").click();
    await page.getByTestId("simple-more-sheet").getByRole("link", { name: "Goal map" }).click();
  } else await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

/** A feature's chip by its code (F-03, never F-031). */
const chip = (page: Page, code: string) => page.getByTestId("gm-chip").filter({ hasText: new RegExp(`${code}(?!\\d)`) });
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });
/** A feature's chip under one goal's column (a feature shows under each goal it serves). */
async function chipUnder(page: Page, code: string, goal: string) {
  const row = page.getByTestId("gm-goal").filter({ hasText: goal });
  // A goal missing from the map fails here, by name, not as a wait for its id.
  await expect(row, `the goal "${goal}" on the map`).toHaveCount(1);
  const id = await row.getAttribute("data-goal");
  return page.locator(`[data-testid="gm-chip"][data-goal="${id}"]`).filter({ hasText: new RegExp(`${code}(?!\\d)`) });
}
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
/** Opens a chip's ⋯ menu (it shows on hover or focus) and picks an item. */
async function chipMenu(page: Page, c: Locator, item: string) {
  await c.getByRole("button").first().focus();
  await c.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1440, 1512] as const) {
    test.describe(`${width} ${scheme}`, () => {
      test.use({ viewport: SIZES[width] });

      test("at rest: the guardrail, goals as columns in priority order with their milestones and work", async ({ page }) => {
        // protects=the picked grid at real volume: the guardrail strip, the four goals in priority
        // order, each milestone in its goal's strip with its roadmap code and a month-first date,
        // and each feature's chip under each goal it serves with its code and that goal's milestone;
        // fails_when=the goal order is lost, a milestone is missing, a chip lacks its code or a
        // feature misses a goal it serves; no_claim=pixel match.
        await open(page, scheme);
        await expect(page.getByTestId("gm-legend-guardrail")).toHaveText("Guardrails: on track ✓");
        await expect(page.getByTestId("gm-goal")).toHaveText([/Teams stay past their first year/, /New teams set up in one day/, /Larger teams add paid seats/, /Half the support tickets per team/]);
        await expect(page.getByTestId("gm-strip-milestone")).toHaveCount(12);
        await expect(strip(page, "Weekly active teams first measured")).toContainText(/M\d+\s*Weekly active teams first measured\s*Nov 13/);
        // F-03 serves Weekly active teams first measured (Teams stay past their first year) and
        // Ticket volume measured by topic (Half the support tickets per team): a chip under each.
        await expect(chip(page, "F-03")).toHaveCount(2);
        const retention = await chipUnder(page, "F-03", "Teams stay past their first year");
        await expect(retention).toContainText(/F-03\s*Renewal health score shown to account owners each Monday/);
        await expect(retention).toContainText(/M\d+ Weekly active teams first measured/);
        await expect(await chipUnder(page, "F-03", "Half the support tickets per team")).toContainText(/M\d+ Ticket volume measured by topic/);
        await expect(page.getByTestId("ld-canvas")).toHaveCount(0);
      });

      test("Move to… another milestone; Move to Trash, and Settings › Trash restores it", async ({ page }) => {
        // protects=F-21 (on Imports finish without help) moved through its ⋯ menu to Setup time one
        // day for new teams (links/move); Move to Trash takes it off the map and Settings › Trash
        // restores it; fails_when=the chip stays, Trash removes it for good, or Restore leaves it gone;
        // no_claim=order within a cell.
        await open(page, scheme);
        await expect(chip(page, "F-21")).toContainText("Imports finish without help");
        await chipMenu(page, chip(page, "F-21"), "Move to…");
        await page.getByRole("dialog", { name: /Move .*Undo a whole import/ }).getByRole("button", { name: /Setup time one day for new teams/ }).click();
        await expect(toast(page, "Moved F-21")).toContainText(/to M\d+ Setup time one day for new teams/);
        await expect(chip(page, "F-21")).toContainText("Setup time one day for new teams");
        await chipMenu(page, chip(page, "F-21"), "Move to Trash");
        await expect(toast(page, "to Trash")).toContainText("Moved F-21");
        await expect(chip(page, "F-21")).toHaveCount(0);
        await page.goto("/settings/trash");
        const row = page.getByRole("listitem").filter({ hasText: "Undo a whole import" }).or(page.getByRole("row").filter({ hasText: "Undo a whole import" })).first();
        await row.getByRole("button", { name: /Restore/ }).click();
        await expect(page.getByRole("status").filter({ hasText: "Restored" })).toContainText("Undo a whole import");
        await page.goto("/simple/goals");
        await expect(chip(page, "F-21")).toBeVisible();
      });

      test("a commenter and a viewer read: no menu changes the map", async ({ page, browser }) => {
        // protects=a commenter's or viewer's chip menu offers only Open, and no goal or milestone
        // menu shows for them; fails_when=a commenter or viewer is offered a move, a rename or
        // Trash; no_claim=who approves.
        await open(page, scheme, "commenter");
        await chip(page, "F-03").getByRole("button").first().focus();
        await chip(page, "F-03").getByRole("button", { name: /^More for / }).click();
        await expect(page.getByRole("menuitem")).toHaveText(["Open"]);
        await expect(page.locator('[data-testid^="gm-menu-m-"]')).toHaveCount(0);
        await expect(page.locator('[data-testid^="gm-menu-g-"]')).toHaveCount(0);
        const ctx = await browser.newContext({ viewport: SIZES[width] });
        const viewer = await ctx.newPage();
        await open(viewer, scheme, "viewer");
        await expect(viewer.locator('[data-testid^="gm-menu-m-"]')).toHaveCount(0);
        await expect(viewer.locator('[data-testid^="gm-menu-g-"]')).toHaveCount(0);
        await ctx.close();
      });
    });
  }

  test.describe(`phone ${scheme}`, () => {
    test.use(PHONE);

    test("Move to… on a phone opens the mover and moves the chip", async ({ page }) => {
      // protects=on a phone the grid shows (no ladder), and a chip's ⋯ Move to… moves F-15 to
      // Setup time one day for new teams; fails_when=Move to… does nothing on a phone;
      // no_claim=drag on a phone.
      await open(page, scheme);
      await expect(page.getByTestId("gm-goal")).toHaveCount(4);
      await chipMenu(page, chip(page, "F-15"), "Move to…");
      await page.getByTestId("gm-mover").getByRole("button", { name: /Setup time one day for new teams/ }).click();
      await expect(toast(page, "Moved F-15")).toContainText("Setup time one day for new teams");
      await expect(chip(page, "F-15")).toContainText("Setup time one day for new teams");
    });
  });
}

test.describe("visual QA fixes, 1440 light", () => {
  test.use({ viewport: SIZES[1440] });

  test("L-2: the feature panel names the goal and milestone the map places it under", async ({ page }) => {
    // protects=one feature panel: F-03 under Goal 1's Weekly active teams first measured opens
    // with that goal and milestone; fails_when=the panel says No goal yet; no_claim=changing the
    // goal from there.
    await open(page, "light");
    await chip(page, "F-03").getByRole("button").first().click();
    const panel = page.getByTestId("gm-feature-panel");
    await expect(panel.getByTestId("card-goal")).toContainText("Teams stay past their first year");
    await expect(panel.getByTestId("gm-panel-milestone")).toContainText(/M\d+ Weekly active teams first measured/);
  });

  test("L-4: the guardrail strip and goal cards carry only the frame's words", async ({ page }) => {
    // protects=the legend's "Guardrails: on track ✓" (rule and days held behind it) and goal cards without the reading's source line;
    // fails_when=the extra prose comes back; no_claim=the reading itself.
    await open(page, "light", "viewer");
    await expect(page.getByTestId("gm-legend-guardrail")).toHaveText("Guardrails: on track ✓");
    await page.getByTestId("gm-legend-guardrail").hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Pages load in under 2 seconds for 95% of views" })).toContainText("Held 7 of 7 days");
    await page.mouse.move(0, 0);
    // The reading's source sits behind the goal's (i), not in a line of its own.
    const first = page.getByTestId("gm-goal").first();
    await expect(first.getByText(/^Read on /)).toBeHidden();
    await first.locator('[data-testid^="gm-goal-info-"]').hover();
    await expect(page.getByRole("tooltip").getByText(/^Read on /)).toBeVisible();
  });
});

test.describe("Goal map findings, 1440", () => {
  test.use({ viewport: SIZES[1440] });

  test("V-6: a milestone in the strip keeps its whole name readable", async ({ page }) => {
    // protects=the strip's "M15 Seat revenue of $20,000 per month" with its full name as its title;
    // fails_when=a name is cut with no way to read the rest; no_claim=where the strip wraps.
    await open(page, "light");
    // By name: milestone codes are numbered roadmap-wide.
    const seats = strip(page, "Seat revenue of $20,000 per month");
    await expect(seats).toContainText(/^M\d+/);
    await expect(seats.getByTitle("Seat revenue of $20,000 per month")).toBeVisible();
    await expect(strip(page, "Renewal rate at 85% for spring renewals").getByTitle("Renewal rate at 85% for spring renewals")).toBeVisible();
  });
});
