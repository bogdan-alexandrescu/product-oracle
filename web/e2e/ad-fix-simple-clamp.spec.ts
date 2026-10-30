import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * BGD 2026-10-30, "Clamp above the line": on /simple/priorities with a dated plan (the mock's
 * "simple-plan" scenario, Nov 2 – Feb 12), what makes the line is listed first: 15 features,
 * whose ranks run to #26. A row dragged onto a row above the line lands at the last rank still
 * above the line (#15), never at the target's own rank when that rank sits below it.
 *
 * protects: dragging Bulk import (#21) onto Pricing page words (#26, the last row above the line)
 *   asks for rank 15, says it lands above the line, and moves it to #15, still above the line.
 * fails_when: the move asks for rank 26 (the target's rank, past the 15 ranks above the line).
 * protects (review of the clamp): a drop onto any other row above the line keeps that row's rank:
 *   Pricing page words (#26) dragged up onto Bulk import (#21) asks for rank 21, not 15.
 * fails_when: every drop onto a row above the line ranked past 15 asks for rank 15.
 * no_claim: a drop onto a row below the line, or the arrow keys.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const rowByTitle = (page: Page, title: string): Locator =>
  page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(title, { exact: true }) });

async function dragOnto(page: Page, name: string, onto: Locator): Promise<void> {
  const handle = page.getByRole("button", { name: `Drag ${name} to reorder` });
  await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const from = (await handle.boundingBox())!;
  const target = (await onto.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2 + 2, { steps: 10 });
  await page.mouse.up();
}

for (const [where, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`a row dragged onto the last row above the line lands at the last rank above it (${where})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple/priorities");
    await expect(page.getByTestId("simple-priorities")).toBeVisible();
    const above = page.locator('[data-testid="prio-row"][data-above="true"]');
    await expect(above).toHaveCount(15);
    const last = above.last();
    await expect(last.getByTestId("prio-title")).toHaveText("Pricing page words");
    await expect(last.getByTestId("prio-rank")).toHaveText("26");
    const bulk = rowByTitle(page, "Bulk import");
    await expect(bulk.getByTestId("prio-rank")).toHaveText("21");

    await dragOnto(page, "Bulk import (F-07)", last);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("Move Bulk import (F-07) to rank 15");
    await expect(dialog.getByTestId("move-lands")).toContainText("above the line");
    await dialog.getByLabel("Reason").fill("Ship it with the first launch");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved Bulk import (F-07) to rank 15" })).toBeVisible();
    await expect(bulk.getByTestId("prio-rank")).toHaveText("15");
    await expect(bulk).toHaveAttribute("data-above", "true");
  });
}

for (const [where, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`a row dragged onto another row above the line takes that row's rank (${where})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await login(page, ADMIN.email);
    await page.goto("/simple/priorities");
    await expect(page.getByTestId("simple-priorities")).toBeVisible();
    const pricing = rowByTitle(page, "Pricing page words");
    await expect(pricing.getByTestId("prio-rank")).toHaveText("26");
    const bulk = rowByTitle(page, "Bulk import");
    await expect(bulk.getByTestId("prio-rank")).toHaveText("21");
    await expect(bulk).toHaveAttribute("data-above", "true");

    await dragOnto(page, "Pricing page words (F-04)", bulk);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("Move Pricing page words (F-04) to rank 21");
    await dialog.getByLabel("Reason").fill("Ship it with the first launch");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved Pricing page words (F-04) to rank 21" })).toBeVisible();
    await expect(pricing.getByTestId("prio-rank")).toHaveText("21");
  });
}
