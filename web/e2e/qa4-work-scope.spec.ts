import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 4 on the Feature set review page, /runs/<id>/review/<checkpoint> (qa4-work-39, 41, 43,
 * 44, 45, 46), driven through the UI on the mock's "scope-review" scenario: the Saved addresses
 * PRD at its feature set, where Bulk edit depends on a left-out feature, Address labels serves
 * no goal and Pick address in one step has a low confidence (the three rows under Needs you).
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function seeded(page: Page, email: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "scope-review"] as const);
  await login(page, email);
}

/** Runs › Saved addresses PRD › Review feature set, as a person goes there. */
async function openReview(page: Page) {
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').filter({ visible: true }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+/);
  await expect(page.getByTestId("scope-row").first()).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: title }) });
const inspector = (page: Page) => page.getByTestId("scope-inspector").filter({ visible: true });
const SUGGESTIONS = ["Suggest Include dependency", "Suggest Remove dependency", "Suggest Leave out"];

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-work-39: a commenter's Suggest buttons fit inside the table card", async ({ page }) => {
    await seeded(page, COMMENTER);
    await openReview(page);
    const call = row(page, "Bulk edit").getByTestId("your-call");
    const table = (await page.getByTestId("scope-table").boundingBox())!;
    for (const name of SUGGESTIONS) {
      const button = call.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(table.x + table.width);
      expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await button.evaluate((el) => el.getBoundingClientRect().right <= el.closest('[role="cell"]')!.getBoundingClientRect().right + 1)).toBe(true);
    }
  });

  test("qa4-work-41: the row's decisions read as the panel's, with no option the panel lacks", async ({ page }) => {
    await seeded(page, APPROVER);
    await openReview(page);
    const pick = row(page, "Pick address in one step").getByTestId("your-call");
    await expect(pick.getByRole("button", { name: "Defer to a later PRD", exact: true })).toBeVisible();
    await expect(pick.getByRole("button", { name: "Defer", exact: true })).toHaveCount(0);
    const bulk = row(page, "Bulk edit").getByTestId("your-call");
    await expect(bulk.getByRole("button", { name: "Leave out", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Leave this out too" })).toHaveCount(0);

    await row(page, "Pick address in one step").getByTestId("feature-title").click();
    const decision = inspector(page).getByRole("group", { name: "Decision" });
    for (const name of ["Include", "Defer to a later PRD"]) {
      await expect(pick.getByRole("button", { name, exact: true })).toBeVisible();
      await expect(decision.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(decision.getByRole("button", { name: "Leave out", exact: true })).toBeVisible();
  });

  test("qa4-work-43: the requirement count and the goal's contribution say what they count", async ({ page }) => {
    await seeded(page, APPROVER);
    await openReview(page);
    const bulk = row(page, "Bulk edit");
    await expect(bulk.getByTestId("row-requirements")).toHaveText(/^\d+ of \d+ kept$/);
    await bulk.getByTestId("feature-title").click();
    await expect(inspector(page).getByTestId("inspector-goal")).toHaveText("Grow paid conversion · contribution 1 of 3");
    const stat = inspector(page).getByTestId("stat-requirements");
    await expect(stat.locator("dt")).toHaveText("Requirements kept");
    await expect(stat.locator("dd")).toHaveText(/^\d+ of \d+$/);
    await expect(inspector(page)).not.toContainText(/\d\/\d/);
  });

  test("qa4-work-44: under Needs you the rows are numbered 1, 2, 3", async ({ page }) => {
    await seeded(page, APPROVER);
    await openReview(page);
    await expect(page.getByRole("button", { name: /^Needs you/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("scope-row")).toHaveCount(3);
    await expect(page.getByTestId("row-number")).toHaveText(["1", "2", "3"]);
  });

  test("qa4-work-45: a commenter's column is headed Suggest and the panel has only buttons they can use", async ({ page }) => {
    await seeded(page, COMMENTER);
    await openReview(page);
    await expect(page.getByRole("columnheader", { name: "Suggest", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Your call" })).toHaveCount(0);
    await row(page, "Address labels").getByTestId("feature-title").click();
    await expect(inspector(page).getByRole("group", { name: "Decision" })).toHaveCount(0);
    await expect(inspector(page).getByTestId("who-decides")).toHaveText("An approver decides; you can suggest a change.");
    for (const name of ["Include", "Leave out", "Defer to a later PRD"]) {
      await expect(inspector(page).getByRole("button", { name, exact: true })).toHaveCount(0);
      await expect(inspector(page).getByRole("button", { name: `Suggest ${name}`, exact: true })).toBeEnabled();
    }
    // A suggestion from the panel goes in as one, the row still waiting for an approver.
    await inspector(page).getByRole("button", { name: "Suggest Defer to a later PRD", exact: true }).click();
    await expect(row(page, "Address labels").getByTestId("suggested-by")).toHaveText("Suggested by Commenter: Defer to a later PRD");
    await expect(row(page, "Address labels").getByTestId("row-done")).toHaveCount(0);
  });

  test("qa4-work-45: a viewer's column is headed Decision and the panel has no decision buttons", async ({ page }) => {
    await seeded(page, VIEWER);
    await openReview(page);
    await expect(page.getByRole("columnheader", { name: "Decision", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Your call" })).toHaveCount(0);
    await row(page, "Address labels").getByTestId("feature-title").click();
    await expect(inspector(page).getByTestId("who-decides")).toHaveText("An approver decides.");
    for (const name of [/^Include$/, /^Leave out$/, /^Defer to a later PRD$/, /^Suggest/]) await expect(inspector(page).getByRole("button", { name })).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-work-39: on a phone a commenter's Suggest buttons say Suggest and stay on the screen", async ({ page }) => {
    await seeded(page, COMMENTER);
    await openReview(page);
    const call = row(page, "Bulk edit").getByTestId("your-call");
    for (const name of SUGGESTIONS) {
      const button = call.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      await expect(button).toHaveText(name, { useInnerText: true });
      expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    }
  });

  test("qa4-work-46: each group heading has room above it", async ({ page }) => {
    await seeded(page, APPROVER);
    await openReview(page);
    const groups = page.getByTestId("scope-table").locator(':scope > [role="rowgroup"]');
    await expect(groups).toHaveCount(3);
    for (let i = 1; i < 3; i++) {
      const above = (await groups.nth(i - 1).getByTestId("scope-row").last().boundingBox())!;
      const heading = (await groups.nth(i).getByRole("row").first().boundingBox())!;
      expect(heading.y - (above.y + above.height)).toBeGreaterThanOrEqual(12);
    }
  });
});
