import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/** A revoked invite whose access removal has kept failing for over 24 hours (#245). */
const withAccessFailure = (page: Page) =>
  page.addInitScript((key) => localStorage.setItem(key, "access-failures"), MOCK_SCENARIO_KEY);

test("inbox: an owner retries an access removal that kept failing, and the item clears", async ({ page }) => {
  await withAccessFailure(page);
  await login(page);
  await page.goto("/inbox");
  const failures = page.getByTestId("inbox-access-failures");
  const row = failures.getByRole("row").filter({ hasText: "jo.tester@example.com" });
  await expect(row).toContainText("Access not removed");
  await expect(row).toContainText("Google returned 403 (permission denied)");
  await expect(row).toContainText("tried 27 times");
  await expect(row).toContainText("since");

  await row.getByRole("button", { name: "Retry" }).click();
  await expect(failures).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("inbox-access-failures")).toHaveCount(0);
});

test("inbox: only owners see an access change that kept failing", async ({ page }) => {
  await withAccessFailure(page);
  await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "approver"] as const);
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-feedback")).toBeVisible();
  await expect(page.getByTestId("inbox-access-failures")).toHaveCount(0);
});
