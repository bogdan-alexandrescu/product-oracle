import { expect, type Locator, type Page } from "./test";

/*
 * PV-1 One count per spot: on Value / effort a feature is drawn by its own mark, or, where marks would cover each
 * other, by a count whose sheet lists it. These read a feature wherever the chart draws it, through the UI.
 */

/** Opens the count that holds a feature and returns the feature's row in the count's sheet (the sheet stays open). */
export async function countRowOf(page: Page, code: string): Promise<Locator> {
  const counts = page.getByTestId("vxe-crowd");
  const sheet = page.getByTestId("vxe-crowd-sheet");
  for (let i = 0; i < (await counts.count()); i++) {
    await counts.nth(i).click();
    await expect(sheet).toBeVisible();
    const row = sheet.locator(`[data-testid="vxe-crowd-row"][data-code="${code}"]`);
    if (await row.count()) return row;
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
  throw new Error(`no count holds ${code}`);
}

/** Every feature's code on the chart, by item: on its mark, or on its row in its count's sheet (each opened and closed). */
export async function chartCodes(page: Page): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = await page
    .getByTestId("vxe-point")
    .evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-code"), e.querySelector('[data-testid="vxe-code"]')?.textContent ?? null])));
  const counts = page.getByTestId("vxe-crowd");
  const sheet = page.getByTestId("vxe-crowd-sheet");
  for (let i = 0; i < (await counts.count()); i++) {
    await counts.nth(i).click();
    await expect(sheet).toBeVisible();
    Object.assign(
      out,
      await sheet
        .getByTestId("vxe-crowd-row")
        .evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-code"), e.querySelector('[data-testid="vxe-crowd-code"]')?.textContent ?? null]))),
    );
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
  return out;
}
