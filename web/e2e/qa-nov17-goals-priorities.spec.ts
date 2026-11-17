import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple Goal map and Priorities, the QA of Nov 17, on the default mock scenario (invented data), driven through
 * the UI as the owner.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openPriorities(page: Page, tab = "") {
  await login(page);
  await page.goto(`/simple/priorities${tab ? `?tab=${tab}` : ""}`);
}

const rankedRow = (page: Page, name: string) => page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-title").filter({ hasText: name }) });

test.describe("Priorities, desktop", () => {
  test.use({ viewport: DESKTOP });

  test("G3: a ranked row's old proof reads the day it was checked, never 'proof old'", async ({ page }) => {
    // protects: the Ranked list's pill on a feature with an old proof says "Exists · checked <month day>"
    // fails_when: the pill reads "Exists · proof old"
    await openPriorities(page);
    const pill = rankedRow(page, "Alert routing by team").getByTestId("prio-name").getByTestId("cs-mark");
    await expect(pill).toHaveText(/^Exists · checked [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  });
});
