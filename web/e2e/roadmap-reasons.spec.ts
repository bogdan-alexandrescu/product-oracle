import { expect, test, type Page } from "./test";

import { login, seedRoadmapReview } from "./helpers";

/**
 * D2 product reasons: at the Roadmap items checkpoint every item says why it needs a person,
 * blocking or to confirm, each sentence in full with its fixes. Since D1 (#542) the run page
 * shows the counts and the review screen the items. Readable at 1366 px and at 390 px, with
 * no horizontal page scroll.
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

const UNVERIFIED = "No verified estimate, capacity or commitment supports Nov 30, 2026.";

/** Opens the seeded run from the runs list, as a person would. */
async function openRun(page: Page) {
  await login(page);
  await seedRoadmapReview(page);
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "usage alerts roadmap" }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  const check = page.getByTestId("items-check");
  await expect(check).toBeVisible();
  return check;
}

/** D1 (#542): the reasons are read on the review screen, opened from the run page's Review items. */
async function openReview(page: Page) {
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
}

const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("roadmap-item-inspector");

/** The item's reasons in its inspector (a sheet on a phone). */
async function pick(page: Page, key: string) {
  await row(page, key).locator('[data-phone="title"]').click();
}

/** Every reason chip fully shown, and no horizontal page scroll. */
async function expectNothingCut(page: Page) {
  const clipped = await page.getByTestId("reason-chip").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  expect(clipped).toBe(0);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
}

test("the roadmap items check counts blocking and to-confirm reasons; the review screen shows every chip in full", async ({ page }) => {
  const check = await openRun(page);
  await expect(check.getByTestId("items-check-summary")).toHaveText(
    "9 roadmap items: 4 now, 2 next, 3 later · 3 blocking · 7 to confirm",
  );
  // D1 (#542): the run page lists no item; its reasons are on the review screen.
  await expect(check.getByTestId("item-reasons")).toHaveCount(0);
  await openReview(page);
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");
  for (const chip of CHIPS) await expect(page.getByTestId("reason-chip").filter({ hasText: chip }).first()).toBeVisible();
  // Reasons are read per item, with every fix.
  await expect(row(page, "budget-caps").getByTestId("reason-chip")).toHaveText(["Depends on a later item"]);
  await pick(page, "budget-caps");
  const card = inspector(page).getByTestId("reason-card");
  await expect(card).toContainText("Needs Anomaly detection, which is in Later. An item cannot ship before what it depends on.");
  for (const fix of ["Move to Later", "Pull dependency to Now", "Remove dependency"]) await expect(card.getByRole("button", { name: fix, exact: true })).toBeVisible();
  // A dropped item is still listed, under its title from the last roadmap.
  await pick(page, "weekly-digest");
  await expect(inspector(page).getByTestId("reason-card")).toContainText("It was in roadmap v1 and is not in this file.");
  await expectNothingCut(page);
});

test("on a phone the summary and every reason stay readable with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const check = await openRun(page);
  await expect(check.getByTestId("items-check-summary")).toContainText("3 blocking · 7 to confirm");
  await expect(page.getByTestId("items-review-line")).toBeVisible();
  await expectNothingCut(page);
  await openReview(page);
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");
  await expectNothingCut(page);
});

test("the Date unverified sentence reads in full with its fix", async ({ page }) => {
  await openRun(page);
  await openReview(page);
  const slack = row(page, "slack-alerts");
  await expect(slack.getByTestId("reason-chip")).toHaveText(["Date unverified"]);
  await expect(slack.getByRole("button", { name: "Remove date", exact: true })).toBeVisible();
  await pick(page, "slack-alerts");
  const card = inspector(page).getByTestId("reason-card");
  await expect(card).toContainText(UNVERIFIED);
  // The sentence is on its own line, never cut: its box is as wide as its text.
  const text = card.getByText(UNVERIFIED);
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
