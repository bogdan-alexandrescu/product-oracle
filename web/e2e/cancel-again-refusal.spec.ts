import { expect, test } from "./test";

import { login, seedStuckRuns } from "./helpers";

/**
 * #396 fixes 3 item 2: Cancel again in the Inbox, refused because another tab already
 * pressed it, says why in the app's words: it never names the workflow's id (the id stays
 * in the refusal's refs, for agents). On the mock layer, driven as a person would.
 */
test("Cancel again pressed twice, from two tabs, is refused without the workflow's id", async ({ context, page }) => {
  // protects=#396 fixes 3 item 2; fails_when=the refusal a person reads names the
  // workflow's id; no_claim=when Cancel again is offered (e2e/inbox-runs.spec.ts).
  await login(page);
  await seedStuckRuns(page);
  await page.goto("/inbox");
  const lookups = page.getByTestId("inbox-lookups");
  await expect(lookups.getByRole("button", { name: "Cancel again" })).toHaveCount(1);

  // A second tab (the browser's sign-in, the same person) presses Cancel again first.
  const other = await context.newPage();
  await other.goto("/inbox");
  // A second visit: what was new is Open.
  await other.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Open/ }).click();
  const otherLookups = other.getByTestId("inbox-lookups");
  await otherLookups.getByRole("button", { name: "Cancel again" }).click();
  await other.getByRole("alertdialog", { name: "Cancel again" }).getByRole("button", { name: "Cancel again" }).click();
  await expect(otherLookups.getByRole("button", { name: "Cancel again" })).toHaveCount(0);

  // This tab still shows it: pressed, it is refused in plain words.
  await page.bringToFront();
  await lookups.getByRole("button", { name: "Cancel again" }).click();
  await page.getByRole("alertdialog", { name: "Cancel again" }).getByRole("button", { name: "Cancel again" }).click();
  const refusal = page.getByRole("alert").filter({ hasText: "nothing to cancel again" });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("Oracle stopped cancelling");
  await expect(refusal).not.toContainText("mock-wf-done");
});
