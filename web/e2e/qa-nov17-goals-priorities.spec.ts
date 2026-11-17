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

test.describe("Goal map, desktop", () => {
  test.use({ viewport: DESKTOP });

  test("G5: a chip's milestone line wraps rather than ending in '…'", async ({ page }) => {
    // protects: on the Goal map, each feature chip's milestone words are readable in full (up to two lines)
    // fails_when: a chip's milestone line is cut on one line
    await login(page);
    await page.goto("/simple/goals");
    const lines = page.getByTestId("gm-chip-ms");
    await expect(lines.first()).toBeVisible();
    for (const l of await lines.all()) {
      const cut = await l.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
      expect(cut, `${await l.textContent()} is cut`).toBe(false);
    }
  });
});

test.describe("Priorities, phone", () => {
  test.use({ viewport: PHONE });

  test("G7: a Goal buckets row keeps its ✎ and ⋯ on the name's line", async ({ page }) => {
    // protects: at 390 a bucket row's edit and more buttons sit beside the feature's name
    // fails_when: ✎ and ⋯ wrap to a line under the name
    await openPriorities(page, "buckets");
    const row = page.getByTestId("plan-feature").filter({ has: page.getByTestId("plan-feature-name").filter({ hasText: "Weekly alert digest" }) }).first();
    const name = (await row.getByTestId("plan-feature-name").boundingBox())!;
    const more = (await row.getByRole("button", { name: /^More for / }).boundingBox())!;
    const mid = more.y + more.height / 2;
    expect(mid).toBeGreaterThanOrEqual(name.y - 4);
    expect(mid).toBeLessThanOrEqual(name.y + name.height + 4);
  });

  test("G9: a ranked row's title keeps its width; the pill drops under it", async ({ page }) => {
    // protects: at 390 a ranked row's name wraps as words do, never one word per line beside its pill and ⋯
    // fails_when: a title of three or more words takes more than two lines
    await openPriorities(page);
    const rows = page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-name").getByTestId("cs-mark") });
    await expect(rows.first()).toBeVisible();
    let checked = 0;
    for (const r of await rows.all()) {
      const title = r.getByTestId("prio-title");
      const words = ((await title.textContent()) ?? "").trim().split(/\s+/).length;
      if (words < 3) continue;
      const [height, line] = await title.evaluate((el) => {
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight);
        return [el.getBoundingClientRect().height, Number.isNaN(lh) ? parseFloat(cs.fontSize) * 1.4 : lh];
      });
      expect(height, `${await title.textContent()} wraps a word per line`).toBeLessThanOrEqual(line * 2 + 2);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
