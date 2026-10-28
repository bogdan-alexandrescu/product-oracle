import { expect, test } from "./test";

import { login, signOut } from "./helpers";

/*
 * Errors in plain words: a missing run says so without its id and leads back to Runs, and a
 * role refusal names who may act, never a status number.
 * protects = what a person reads when a call fails; fails_when = an id, a status such as
 * "(403)" or the API's "Requires the approver role" shows; no_claim = the API's own refusals.
 */

test("a run that does not exist says so, with a way back to Runs", async ({ page }) => {
  await login(page);
  await page.goto("/runs/no-such-run");
  const note = page.getByRole("alert").filter({ hasText: "doesn't exist" });
  await expect(note).toContainText("This run doesn't exist or was deleted.");
  await expect(page.getByText("no-such-run")).toHaveCount(0);
  await note.getByRole("link", { name: "Back to Runs" }).click();
  await expect(page).toHaveURL(/\/runs$/);
});

test("a role refusal says who can act, not a status", async ({ page, context }) => {
  // The approver opens the build sheet; an owner, in another tab, makes them a commenter.
  await login(page, "approver@example.com");
  await page.goto("/baseline");
  await page.getByRole("button", { name: "Build baseline" }).click();
  const sheet = page.getByRole("dialog", { name: "Build the baseline" });
  await expect(sheet.getByTestId("build-estimate")).toHaveText("Estimate $7.00");

  const owner = await context.newPage();
  await owner.goto("/home");
  await signOut(owner);
  await login(owner);
  await owner.goto("/settings/members");
  await owner.getByLabel("Role for approver@example.com").selectOption("commenter");
  const dialog = owner.getByTestId("role-dialog");
  await dialog.getByLabel("Hand over Decides document reviews").selectOption({ label: "Admin" });
  await dialog.getByRole("button", { name: "Change role" }).click();
  await expect(owner.getByLabel("Role for approver@example.com")).toHaveValue("commenter");
  await owner.close();

  await sheet.getByRole("button", { name: "Start" }).click();
  const refused = sheet.getByRole("alert");
  await expect(refused).toContainText("Only approvers and owners can do this.");
  await expect(refused).not.toContainText("403");
  await expect(refused).not.toContainText("Requires the");
});
