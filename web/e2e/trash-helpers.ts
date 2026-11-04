import { expect, type Locator, type Page } from "./test";

/* Trash and ritual steps Home's specs share (home-honest-loading, home-deleted-roadmap). */

/**
 * Deletes every row of a list through its Actions menu (Delete…, then Move to Trash); a row
 * whose run has not finished cannot go (Trash says to cancel the run first) and stays.
 * Returns how many stayed.
 */
export async function trashEvery(page: Page, rows: Locator): Promise<number> {
  await expect(rows.first()).toBeVisible();
  const kept: string[] = [];
  for (let n = 0; n < 15 && kept.length < (await rows.count()); n++) {
    const menu = rows.nth(kept.length).getByRole("button", { name: /^Actions for / });
    const title = ((await menu.getAttribute("aria-label")) ?? "").replace(/^Actions for /, "");
    const row = rows.nth(kept.length);
    await expect(async () => {
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      if (!(await page.getByRole("menuitem", { name: "Delete…" }).isVisible())) await row.getByRole("button", { name: `Actions for ${title}` }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const dialog = page.getByRole("dialog", { name: `Delete ${title}` });
    const blocked = dialog.getByText("Cancel the run first");
    const second = dialog.getByLabel("Delete it here; the external copy stays where it is");
    // The dialog reads what goes with it first: then it can go, asks once more, or cannot go.
    await expect(blocked.or(second).or(dialog.getByRole("button", { name: "Move to Trash", disabled: false }))).toBeVisible();
    if (await blocked.isVisible()) {
      kept.push(title);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      continue;
    }
    if (await second.isVisible()) await second.check();
    await dialog.getByRole("button", { name: "Move to Trash" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rows.getByRole("button", { name: `Actions for ${title}`, exact: true })).toHaveCount(0);
  }
  return kept.length;
}

/** Pauses every ritual but the monthly roadmap refresh (Company › Rituals), so it is Home's next review. */
export async function onlyTheRoadmapRefresh(page: Page) {
  await page.goto("/company/rituals");
  const on = page
    .getByTestId("ritual-row")
    .filter({ has: page.getByTestId("ritual-state").filter({ hasText: /^On$/ }) })
    .filter({ hasNotText: "Monthly roadmap refresh" });
  await expect(on.first()).toBeVisible();
  for (let n = 0; n < 15 && (await on.count()) > 0; n++) {
    const before = await on.count();
    // The row's corner, clear of its links (a phone opens the ritual in a sheet).
    await on.first().click({ position: { x: 4, y: 4 } });
    await page.getByRole("button", { name: "Pause", exact: true }).filter({ visible: true }).click();
    await expect(on).toHaveCount(before - 1);
    if (await page.getByTestId("ritual-sheet").isVisible()) await page.keyboard.press("Escape");
  }
  await expect(on).toHaveCount(0);
}
