import { expect, test, type Page } from "./test";

import { login, seedRoadmapReview } from "./helpers";

/**
 * D2 product reasons: at the Roadmap items checkpoint every item says why it needs a person,
 * blocking (red) or to confirm (amber), each sentence in full on its own line with its fixes
 * as plain text. Readable at 1366 px and at 390 px, with no horizontal page scroll.
 */

const CHIPS = [
  "Date unverified",
  "Depends on a later item",
  "No PRD section",
  "Low confidence",
  "Serves no goal",
  "Moved from Now (roadmap v1)",
  "New since roadmap v1",
  "Dropped since roadmap v1",
  "Top priority in Later",
  "Open blocker",
  "PRD section changed",
];

const UNVERIFIED = "No verified estimate, capacity or commitment supports 2026-11-30.";

/** Opens the seeded run from the runs list, as a person would. */
async function openRun(page: Page) {
  await login(page);
  await seedRoadmapReview(page);
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "usage-alerts-roadmap" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  const check = page.getByTestId("items-check");
  await expect(check).toBeVisible();
  return check;
}

/** Every chip and sentence fully shown: nothing ellipsised or clipped inside the check. */
async function expectNothingCut(page: Page) {
  const cut = await page.getByTestId("items-check").evaluate((root) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const style = getComputedStyle(el);
      if (style.textOverflow === "ellipsis") out.push(`ellipsis: ${el.textContent}`);
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX !== "visible") out.push(`clipped: ${el.textContent}`);
    }
    return out;
  });
  expect(cut).toEqual([]);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
}

test("the roadmap items check counts blocking and to-confirm reasons and shows every chip in full", async ({ page }) => {
  const check = await openRun(page);
  await expect(check.getByTestId("items-check-summary")).toHaveText(
    "9 roadmap items: 4 now, 2 next, 3 later · 3 blocking · 8 to confirm",
  );
  // Reasons are listed per item, under the item's title.
  const budget = check.getByTestId("item-reasons").filter({ hasText: "Budget caps" });
  await expect(budget.getByTestId("reason-chip")).toHaveText(["Depends on a later item"]);
  await expect(budget.getByTestId("reason-text")).toHaveText(
    "Needs Anomaly detection, which is in Later. An item cannot ship before what it depends on.",
  );
  await expect(budget.getByTestId("reason-fixes")).toHaveText("Fix: Move to Later, Pull dependency to Now or Remove dependency");
  // Blocking chips are red, to-confirm chips amber.
  await expect(check.locator('[data-testid="reason-chip"][data-kind="crit"]')).toHaveCount(3);
  await expect(check.locator('[data-testid="reason-chip"][data-kind="warn"]')).toHaveCount(8);
  for (const chip of CHIPS) await expect(check.getByTestId("reason-chip").filter({ hasText: chip }).first()).toBeVisible();
  // A dropped item is still listed, under its title from the last roadmap.
  await expect(check.getByTestId("item-reasons").filter({ hasText: "Weekly digest" })).toContainText(
    "It was in roadmap v1 and is not in this file.",
  );
  await expectNothingCut(page);
});

test("on a phone every reason stays readable with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const check = await openRun(page);
  await expect(check.getByTestId("items-check-summary")).toContainText("3 blocking · 8 to confirm");
  await expect(check.getByTestId("reason-chip")).toHaveCount(11);
  for (const text of await check.getByTestId("reason-text").all()) await expect(text).toBeVisible();
  await expectNothingCut(page);
});

test("the Date unverified sentence reads in full with its fix", async ({ page }) => {
  const check = await openRun(page);
  const slack = check.getByTestId("item-reasons").filter({ hasText: "Slack alerts" });
  await expect(slack.getByTestId("reason-chip")).toHaveText(["Date unverified"]);
  await expect(slack.getByTestId("reason-text")).toHaveText(UNVERIFIED);
  await expect(slack.getByTestId("reason-fixes")).toHaveText("Fix: Remove date");
  // The sentence is on its own line, never cut: its box is as wide as its text.
  const text = slack.getByTestId("reason-text");
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
