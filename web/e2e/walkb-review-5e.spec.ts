import { expect, test } from "./test";

import { SIMPLE_ITEM_BASIS_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// walkb-roadmap review 5e: a date source recorded on an item of a roadmap read in Simple
// (Alert rules engine, key alert-rules) reads on Plan › Dates by the item's name, never by
// its key.

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("Plan › Dates names a Simple roadmap item, not its key", async ({ page }) => {
      await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, SIMPLE_ITEM_BASIS_SCENARIO]);
      await login(page);
      await page.goto("/plan/dates");
      const row = page.getByTestId("dates-table").locator('[data-basis="ENG-450"]');
      await expect(row).toBeVisible();
      await expect(row).toContainText("Item: Alert rules engine");
      await expect(page.getByTestId("dates-table")).not.toContainText("alert-rules");
    });
  });
}
