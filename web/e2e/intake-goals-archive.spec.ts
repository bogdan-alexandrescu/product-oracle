import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/**
 * Before drafting's Goals and Archive (issue #278), driven through the UI of the mock build.
 *
 * Test cards:
 * - "goal from the door": protects=the Goals section lists the goal ticked at the New PRD door
 *   (the goal_alignment gap's entity_ids) with its distance to go; fails_when=it says "No
 *   confirmed company goal yet" or the goal has no distance; no_claim=the summary's text matches.
 * - "archive": protects=Archive asks first, then the page says the brief is archived without a
 *   reload; fails_when=there is no confirmation, the status stays "Waiting for answers" or
 *   Draft with Oracle is still offered; no_claim=reopening an archived brief.
 */

test("goal from the door, then Archive asks and the page says it is archived", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses for repeat buyers");
  await page
    .getByRole("textbox", { name: "What problem does it solve?" })
    .fill("Returning buyers retype their address at every checkout. Saved addresses would make repeat checkout faster.");
  await page.getByRole("group", { name: "Which goals does it serve?" }).getByRole("checkbox", { name: /Raise activation/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);

  const goals = page.getByTestId("intake-goals");
  await expect(goals).toContainText("Raise activation");
  await expect(goals).toContainText("to go");
  await expect(goals).not.toContainText("No confirmed company goal yet");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Archive" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Archive" }).click();

  await expect(page.getByTestId("intake-status")).toHaveText("Archived");
  await expect(page.getByTestId("intake-archived")).toContainText("This brief is archived");
  await expect(page.getByRole("button", { name: "Draft with Oracle" })).toHaveCount(0);
});
