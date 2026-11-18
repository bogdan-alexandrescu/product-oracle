import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass of Nov 17 on Runs and Trash (detailed runs 3 and 9), driven through the UI on the
 * mock's default scenario.
 */

const row = (page: Page, name: string) => page.getByTestId("run-row").filter({ hasText: name });

async function openRun(page: Page, name: string) {
  await login(page);
  await page.goto("/runs");
  await row(page, name).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-timeline")).toBeVisible();
}

test("qa-nov17 runs 3: a deleted run is named by its day and the document it wrote", async ({ page }) => {
  await openRun(page, "Annual billing");
  await page.getByTestId("run-delete").click();
  await page.getByRole("dialog", { name: /^Delete the .* run$/ }).getByRole("button", { name: "Move to Trash" }).click();
  const said = "The run of Oct 16 that wrote Annual billing PRD";
  await expect(page.getByTestId("toasts")).toContainText(said);

  await page.goto("/settings/trash");
  await expect(page.getByRole("main")).toContainText(said);
  await expect(page.getByRole("main")).not.toContainText("that wrote Feedback loop");
});

test("qa-nov17 runs 9: a raw file's first line names its step, never the step's key", async ({ page }) => {
  await openRun(page, "team onboarding");
  await page.getByTestId("artifacts-current").first().getByRole("button", { name: "Ground Truth" }).first().click();
  await expect(page.getByRole("main")).toContainText("# Ground Truth proposal (attempt 1)");
  await expect(page.getByRole("main")).not.toContainText("# baseline");
});
