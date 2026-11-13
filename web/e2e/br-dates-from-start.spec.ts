import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * BR dates from the start (docs/qa/2026-11-12/detailed-a.md #8), driven as a person does against
 * the mock's invented data: Oracle's date suggestions are made by its daily run, never by a page
 * view, so they wait in the Inbox before anyone opens the roadmap, and opening it adds none.
 * protects: the Inbox lists Oracle's dates on a first visit; after the roadmap is opened it lists
 * the same number. fails_when: none show until the roadmap is read, or opening it adds rows.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "inbox-reviewer"), MOCK_SCENARIO_KEY);
});

test("Oracle's dates wait in the Inbox from the start, and a roadmap view adds none", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const dates = page.getByRole("row").filter({ has: page.getByTestId("date-suggestion-context") });
  await expect(dates.first()).toBeVisible();
  const n = await dates.count();
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.goto("/inbox");
  await expect(dates.first()).toBeVisible();
  await expect(dates).toHaveCount(n);
});
