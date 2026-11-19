import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * flakes-dates: a goal's ?edit= link (Rename on the Goal map) opens its form on Goal buckets once.
 * Mock default scenario (invented data), the owner, desktop.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("a Rename link opens the goal's form once: closed, it does not come back and the link leaves the URL", async ({ page }) => {
  // protects: the form opened from ?edit= stays closed after Cancel, across tabs
  // fails_when: the edit param stays in the URL and Goal buckets opens the form again
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
  await page.locator('[data-testid^="gm-menu-g-"]').first().click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page).toHaveURL(/\/simple\/priorities\?/);
  const form = page.getByRole("heading", { name: "Edit goal" });
  await expect(form).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Goal", exact: true })).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]edit=/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);

  await page.getByRole("tab", { name: "Ranked list" }).click();
  await expect(page.getByTestId("prio-row").first()).toBeVisible();
  await page.getByRole("tab", { name: "Goal buckets" }).click();
  await expect(page.getByRole("button", { name: /^Edit / }).first()).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]edit=/);
});
