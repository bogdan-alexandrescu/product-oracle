import { expect, test } from "@playwright/test";

import { login, seedStuckRuns } from "./helpers";

test("stuck runs and failed imports are rows of the Inbox, counted alike by the badge, Home and /inbox", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await login(page);
  const overrunId = await seedStuckRuns(page);

  // 7 waiting in the seed, two questions among them; a stuck lookup, an overrun and a failed import add 3.
  // Looking for an earlier submission is shown, never counted.
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(page.getByText("10 waiting").filter({ visible: true })).toBeVisible();
  await expect(badge).toHaveText("10");
  await expect(page.getByText("Runs 3")).toBeVisible();
  await expect(page.getByText("Questions 2")).toBeVisible();
  const lookups = page.getByTestId("inbox-lookups");
  await expect(lookups.locator("tr[data-row]")).toHaveCount(2);
  await expect(page.getByTestId("inbox-imports")).toContainText("DataError");
  await expect(page.getByTestId("inbox-searches")).toContainText("still looks for submission seg-1-a1");
  await expect(page.getByTestId("inbox-questions")).toContainText("Which metric shows repeat checkout got faster?");

  // Home draws the same rows and the same count; its chips add up to it.
  await page.goto("/home");
  const needs = page.getByTestId("home-needs");
  await expect(needs.getByTestId("panel-count")).toHaveText("10");
  await expect(page.getByText("10 waiting").filter({ visible: true })).toBeVisible();
  await expect(badge).toHaveText("10");
  await expect(needs.getByText("Runs 3")).toBeVisible();
  await expect(needs.getByText("Questions 2")).toBeVisible();
  await expect(needs.locator('tr[data-need="Couldn\'t import"]')).toHaveCount(1);
  await expect(needs.locator('tr[data-need="Looking"]')).toHaveCount(0);

  // The overrun after the run ended: on the run page, with Cancel again.
  await page.goto(`/runs/${overrunId}`);
  await expect(page.getByTestId("run-stuck")).toContainText("over its $13.50 ceiling");

  // Retry the lost submission and the import from the Inbox: both leave, and every count follows.
  await page.goto("/inbox");
  await lookups.locator("tr[data-row]").filter({ hasText: "seg-1-a2" }).getByRole("button", { name: "Retry" }).click();
  await expect(lookups.locator("tr[data-row]")).toHaveCount(1);
  await page.getByTestId("inbox-imports").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("inbox-imports")).toHaveCount(0);
  await expect(page.getByText("8 waiting").filter({ visible: true })).toBeVisible();
  await expect(badge).toHaveText("8");
  await lookups.getByRole("button", { name: "Cancel again" }).click();
  await expect(lookups.getByRole("button", { name: "Cancel again" })).toHaveCount(0);
});
