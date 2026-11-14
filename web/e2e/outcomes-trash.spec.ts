import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes edits (owner, Nov 13), Move to Trash: an outcome goes to Trash from its
 * inspector's menu, leaves the list, its filter counts and the Priorities track record, and
 * Settings › Trash restores it. Mock API, "outcomes" scenario (synthetic: six earlier
 * predictions on Raise activation were assessed, 3 held).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });
const all = (page: Page) => page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ });

test("an outcome moved to Trash leaves the list and the track record, and Restore brings it back", async ({ page }) => {
  // protects=Delete… in the inspector's menu moves the outcome to Trash: its row, the All
  // count and the track record's "held" figures drop; Trash lists it as an Outcome and Restore
  // puts it back; fails_when=no Delete…, the row or a count stays, or Restore loses it;
  // no_claim=the 30-day purge.
  test.setTimeout(90_000);
  await start(page);
  await page.goto("/priorities");
  await expect(page.getByTestId("track-record")).toContainText("3 of 6 held");
  await page.goto("/plan/outcomes");
  await all(page).click();
  await expect(all(page)).toContainText("9");
  await row(page, "Earlier activation bet 1").click();
  await inspector(page).getByRole("button", { name: "Actions for Earlier activation bet 1" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByTestId("delete-dialog");
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "Earlier activation bet 1")).toHaveCount(0);
  await expect(all(page)).toContainText("8");

  await page.goto("/priorities");
  await expect(page.getByTestId("track-record")).toContainText("2 of 5 held");

  await page.goto("/settings/trash");
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Earlier activation bet 1" });
  await expect(entry.getByTestId("trash-kind")).toHaveText("Outcome");
  await entry.getByRole("button", { name: "Restore Earlier activation bet 1" }).click();
  await expect(entry).toHaveCount(0);

  await page.goto("/plan/outcomes");
  await all(page).click();
  await expect(row(page, "Earlier activation bet 1")).toHaveCount(1);
  await expect(all(page)).toContainText("9");
});
