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

  test("G4: a Value / effort mark names its feature on hover; the side list's names are not cut", async ({ page }) => {
    // protects: a mark showing only its code ("F-06") carries the code with the name as its tooltip, and the side list's
    // names wrap rather than end in "…"
    // fails_when: the mark has no title naming the feature, or a side-list name is cut
    await openPriorities(page, "value-effort");
    const mark = page.getByTestId("vxe-point").filter({ has: page.getByTestId("vxe-name").filter({ hasText: "Weekly alert digest" }) });
    await expect(mark).toHaveAttribute("title", "F-06 Weekly alert digest");
    const names = page.getByTestId("side-row").getByTestId("prio-title");
    await expect(names.first()).toBeVisible();
    for (const n of await names.all()) {
      const cut = await n.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
      expect(cut, `${await n.textContent()} is cut`).toBe(false);
    }
  });
});
