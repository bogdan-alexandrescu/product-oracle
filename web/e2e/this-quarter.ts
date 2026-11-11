import { expect, type Page } from "./test";

/**
 * Dates features into this quarter through the one feature panel, as a person would: on
 * Simple › Priorities' Ranked list, each feature's name opens its panel, where "Change the dates"
 * takes a start and an end (YYYY-MM-DD). Used where a scenario's work is dated past this quarter
 * (board-quarters: Now is the calendar quarter of the dates) and a spec needs it this quarter.
 */
export async function dateIntoThisQuarter(page: Page, features: { title: string; start: string; end: string }[]): Promise<void> {
  await page.getByRole("tab", { name: "Ranked list" }).click();
  for (const f of features) {
    const row = page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").getByText(f.title, { exact: true }) });
    const name = row.getByRole("button", { name: f.title, exact: true });
    await name.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await name.click();
    const panel = page.getByTestId("floating-card");
    await expect(panel.getByTestId("card-name")).toContainText(f.title);
    await panel.getByRole("button", { name: "Change the dates" }).click();
    const edit = panel.getByTestId("card-dates-edit");
    await edit.getByLabel("Start", { exact: true }).fill(f.start);
    await edit.getByLabel("End", { exact: true }).fill(f.end);
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toHaveCount(0);
    await panel.getByRole("button", { name: "Close" }).first().click();
    await expect(panel).toHaveCount(0);
    await expect(row).toHaveAttribute("data-above", "true");
  }
}
