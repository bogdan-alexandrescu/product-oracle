import { expect, test } from "./test";

import { login, seedStuckRuns } from "./helpers";

test("stuck runs and failed imports are rows of the Inbox, counted alike by the badge, Home and /inbox", async ({ page }) => {
  // Retry and Cancel again ask in the page (UI test finding E5), never in a browser dialog.
  const native: string[] = [];
  page.on("dialog", (d) => {
    native.push(d.message());
    void d.dismiss();
  });
  await login(page);
  const overrunId = await seedStuckRuns(page);

  // 11 waiting in the seed, two questions and the pending access request (A5) among them; a
  // stuck lookup, an overrun and a failed import add 3.
  // Looking for an earlier submission is shown, never counted.
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  const tabs = page.getByTestId("inbox-state-tabs");
  await expect(page.getByText("14 waiting").filter({ visible: true })).toBeVisible();
  await expect(badge).toHaveText("14");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveText("New14");
  const lookups = page.getByTestId("inbox-lookups");
  await expect(lookups.locator("tr[data-row]")).toHaveCount(2);
  await expect(page.getByTestId("inbox-imports")).toContainText("DataError");
  await expect(page.getByTestId("inbox-questions").locator("tr[data-row]")).toHaveCount(2);
  await expect(page.getByTestId("inbox-questions")).toContainText("Which metric shows repeat checkout got faster?");
  // Looking rows are not items: under Open, and the tab does not count them.
  await tabs.getByRole("tab", { name: /^Seen/ }).click();
  await expect(page.getByTestId("inbox-searches")).toContainText("still looks for submission seg-1-a1");
  await expect(tabs.getByRole("tab", { name: /^Seen/ })).toHaveText("Seen");

  // Home draws the same rows and the same count; its chips add up to it.
  await page.goto("/home");
  const needs = page.getByTestId("home-needs");
  await expect(needs.getByTestId("panel-count")).toHaveText("14");
  await expect(page.getByText("14 waiting").filter({ visible: true })).toBeVisible();
  await expect(badge).toHaveText("14");
  // Runs counts the two stuck runs and the failed import; six lines and '+8 more in Inbox'.
  await expect(needs.getByText("Runs 3")).toBeVisible();
  await expect(needs.getByText("Questions 2")).toBeVisible();
  await expect(needs.locator('tr[data-need="Stuck run"]')).toHaveCount(2);
  await expect(needs.getByTestId("home-needs-more")).toHaveText("+8 more in Inbox");
  await expect(needs.locator('tr[data-need="Looking"]')).toHaveCount(0);

  // The overrun after the run ended: on the run page, with Cancel again.
  await page.goto(`/runs/${overrunId}`);
  await expect(page.getByTestId("run-stuck")).toContainText("over its $13.50 ceiling");

  // Retry the lost submission and the import from the Inbox: both leave, and every count follows.
  // A second visit: what was new is Open.
  await page.goto("/inbox");
  await tabs.getByRole("tab", { name: /^Seen/ }).click();
  await lookups.locator("tr[data-row]").filter({ hasText: "seg-1-a2" }).getByRole("button", { name: "Retry" }).click();
  const retry = page.getByRole("alertdialog", { name: "Retry" });
  await expect(retry).toContainText("This can start a paid duplicate run");
  await retry.getByRole("button", { name: "Retry" }).click();
  await expect(lookups.locator("tr[data-row]")).toHaveCount(1);
  await page.getByTestId("inbox-imports").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("inbox-imports")).toHaveCount(0);
  await expect(page.getByText("12 waiting").filter({ visible: true })).toBeVisible();
  await expect(badge).toHaveText("12");
  await expect(tabs.getByRole("tab", { name: /^Seen/ })).toHaveText("Seen12");
  // Back first: nothing is cancelled.
  await lookups.getByRole("button", { name: "Cancel again" }).click();
  const again = page.getByRole("alertdialog", { name: "Cancel again" });
  await expect(again).toContainText("Cancel again? Oracle cancels this workflow again; nothing restarts.");
  await again.getByRole("button", { name: "Back" }).click();
  await expect(again).toHaveCount(0);
  await expect(lookups.getByRole("button", { name: "Cancel again" })).toHaveCount(1);
  await lookups.getByRole("button", { name: "Cancel again" }).click();
  await again.getByRole("button", { name: "Cancel again" }).click();
  await expect(lookups.getByRole("button", { name: "Cancel again" })).toHaveCount(0);
  expect(native).toEqual([]);
});
