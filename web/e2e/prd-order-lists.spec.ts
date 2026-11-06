import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * prd-order, fix round 2 (the re-review): after an owner moves a PRD on Simple › One-pagers,
 * every other list of PRDs a person reads follows the new company order: Simple › Decisions'
 * PRD filter, the Start-a-review PRD select, Simple › Roadmap's Group by PRD lanes, New run's
 * document picker, Decisions' link-a-document picker, Home's In flight PRDs in review, the
 * Roadmap card's PRD picker and the PRDs under Roadmap's Key dates.
 * Driven through the UI on the mock (invented data).
 *
 * - protects = each list in the company PRD order after a move; fails_when = a list by title,
 *   newest first, or in the order before the move.
 * - no_claim = the API's order of the same lists (api/tests/test_prd_order.py); Plan's cards
 *   (plan-prd-order.spec.ts).
 */

const TEAM = "Team workspaces PRD";

/** A PRD's title as a list may name it ("Online deposits at booking PRD" in the link picker). */
const plain = (t: string) => t.trim().replace(/ PRD$/, "");

async function onePagers(page: Page): Promise<string[]> {
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
  return page.getByTestId("one-pager-row").getByRole("link").allTextContents();
}

/** Moves `title` up `times` places on One-pagers; the company order after the moves. */
async function moveUp(page: Page, title: string, times = 1): Promise<string[]> {
  const before = await onePagers(page);
  for (let n = 1; n <= times; n++) {
    await page.getByRole("button", { name: `More for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect(page.getByTestId("one-pager-row").getByRole("link").nth(before.indexOf(title) - n)).toHaveText(title);
  }
  return page.getByTestId("one-pager-row").getByRole("link").allTextContents();
}

/** The PRDs `shown` (titles, in the order shown) read in the company `order`, with at least `least` of them. */
async function inOrder(shown: Locator, order: string[], least = 3) {
  const names = order.map(plain);
  await expect
    .poll(async () => (await shown.allInnerTexts()).map(plain).filter((t) => names.includes(t)).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(least);
  const got = (await shown.allInnerTexts()).map(plain).filter((t) => names.includes(t));
  expect(got).toEqual(names.filter((t) => got.includes(t)));
}

test.describe("every list of PRDs follows a move on One-pagers", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Simple › Decisions' PRD filter", async ({ page }) => {
    await login(page);
    const order = await moveUp(page, TEAM);
    expect(order.indexOf(TEAM)).toBeLessThan(order.indexOf("Saved carts PRD"));
    await page.goto("/simple/decisions");
    await inOrder(page.getByRole("combobox", { name: "PRD", exact: true }).locator("option"), order, 7);
  });

  test("the Start a review PRD select", async ({ page }) => {
    await login(page);
    const order = await moveUp(page, TEAM);
    await page.goto("/simple/meetings");
    await page.getByRole("button", { name: "Start review" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await inOrder(sheet.getByLabel("PRD").locator("option"), order, 7);
  });

  test("Simple › Roadmap's Group by PRD lanes", async ({ page }) => {
    // An onboarding roadmap with items from two PRDs, Guided setup and Team templates.
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-keydates-two-prds"] as const);
    await login(page);
    const before = await onePagers(page);
    const order = await moveUp(page, "Team templates", before.indexOf("Team templates") - before.indexOf("Guided setup"));
    expect(order.indexOf("Team templates")).toBeLessThan(order.indexOf("Guided setup"));
    await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
    await page.getByTestId("format-gantt").click();
    await page.getByTestId("group-prd").click();
    await expect(page.getByTestId("group-prd")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("chart-group")).toHaveText(["Team templates", "Guided setup"]);
  });

  test("New run's document picker", async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "new-run-prd"] as const);
    await login(page);
    const order = await moveUp(page, TEAM);
    await page.goto("/runs");
    await page.getByRole("button", { name: "Start a run…" }).click();
    const dialog = page.getByRole("dialog", { name: "New run" });
    await dialog.getByLabel("PRD document").focus();
    await inOrder(dialog.getByRole("listbox", { name: "Document suggestions" }).getByRole("option").locator("span:nth-child(2)"), order, 7);
  });

  test("Decisions' link-a-document picker, PRDs before the roadmaps", async ({ page }) => {
    await login(page);
    const order = await moveUp(page, TEAM);
    await page.goto("/company/decisions");
    await page.getByRole("button", { name: "Propose decision" }).click();
    const about = page.getByRole("dialog", { name: "Propose decision" }).getByRole("group", { name: "About" });
    const options = about.getByLabel("Item", { exact: true }).locator("option");
    await inOrder(options, order, 7);
    const all = (await options.allInnerTexts()).map((t) => t.trim());
    expect(all.indexOf("Usage alerts roadmap")).toBeGreaterThan(Math.max(...order.map((t) => all.findIndex((x) => plain(x) === plain(t)))));
  });

  test("Home's In flight PRDs in review", async ({ page }) => {
    await login(page);
    const order = await moveUp(page, TEAM, 4);
    expect(order.indexOf(TEAM)).toBeLessThan(order.indexOf("Checkout redesign PRD"));
    await page.goto("/home");
    const prds = page.getByTestId("home-in-flight-table").getByTestId("flight-row").and(page.locator('[data-kind="prd"]'));
    await expect(prds).toHaveCount(3);
    const got = (await prds.allInnerTexts()).map((t) => t.split("\n")[0].trim());
    expect(got).toEqual(order.filter((t) => got.includes(t)));
    expect(got).toEqual([TEAM, "Checkout redesign PRD", "Clinic outreach PRD"]);
  });

  test("the Roadmap card's PRD picker", async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-keydates-two-prds"] as const);
    await login(page);
    const before = await onePagers(page);
    const order = await moveUp(page, "Team templates", before.indexOf("Team templates") - before.indexOf("Guided setup"));
    expect(order.indexOf("Team templates")).toBeLessThan(order.indexOf("Guided setup"));
    await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
    await openRoadmapItem(page, "setup-checklist");
    const card = page.getByTestId("floating-card");
    await card.getByRole("button", { name: "Change the prd" }).click();
    await inOrder(card.getByTestId("card-prd-edit").getByLabel("PRD").locator("option"), order, 2);
    await expect(card.getByTestId("card-prd-edit").getByLabel("PRD").locator("option")).toHaveText(["Team templates", "Guided setup"]);
  });

  test("Roadmap's Key dates list the PRDs' milestones of one day in the company order", async ({ page }) => {
    // Both PRDs end "M1 · Prove it" on the same day, so only the PRD order tells the rows apart.
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-keydates-tied-prds"] as const);
    await login(page);
    const before = await onePagers(page);
    const order = await moveUp(page, "Team templates", before.indexOf("Team templates") - before.indexOf("Guided setup"));
    expect(order.indexOf("Team templates")).toBeLessThan(order.indexOf("Guided setup"));
    await page.goto("/simple/roadmap?roadmap=onboarding-roadmap");
    await page.getByTestId("key-dates-open").click();
    const rows = page.getByTestId("key-dates-editor").locator('[data-testid="key-date-row"][data-name="M1 · Prove it"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.getByTestId("key-date-where")).toHaveText(["Change it in the PRD, Team templates", "Change it in the PRD, Guided setup"]);
  });
});
