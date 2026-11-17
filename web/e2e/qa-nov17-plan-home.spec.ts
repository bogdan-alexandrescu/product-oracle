import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * QA pass of Nov 17 on Plan › Outcomes, Home and the Ground Truth's goal panel (detailed plan
 * 1 to 4), driven through the UI on the mock.
 */

test("qa-nov17 plan 1: a phone's outcome sheet says Outcome once on top, the full title inside", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes-long"));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
  await page.getByTestId("outcome-row").filter({ hasText: "Let a team admin export every invoice" }).click();
  const sheet = page.getByTestId("outcome-sheet");
  await expect(sheet.getByRole("heading").first()).toHaveText("Outcome");
  await expect(sheet).toContainText("Let a team admin export every invoice");
});

test("qa-nov17 plan 2: the Outcomes table shows 'Not in the Ground Truth' whole", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
  const flag = page.getByTestId("outcome-row").filter({ hasText: "Order status emails" }).getByTestId("not-in-gt").first();
  await expect(flag).toHaveText("Not in the Ground Truth");
  const inner = flag.locator("span").first();
  expect(await inner.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
});

test("qa-nov17 plan 3: Home's waiting count leads to the Inbox", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  await page.getByRole("link", { name: /^\d+ waiting$/ }).click();
  await expect(page).toHaveURL(/\/inbox/);
});

test("qa-nov17 plan 4: a goal with a value but no dated values does not say 'No values recorded yet'", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  await page.getByTestId("goal-open").filter({ hasText: "Growth" }).first().click();
  const section = page.getByTestId("goal-measurements").filter({ visible: true });
  await expect(section).toContainText("No dated values yet");
  await expect(section).not.toContainText("No values recorded yet");
  await section.getByRole("button", { name: /^About / }).click();
  await expect(page.getByText("Home's trend uses this goal's value history")).toBeVisible();
});
