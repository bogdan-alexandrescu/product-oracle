import { expect, test, type Page } from "./test";

import { LONG_WORDS_SCENARIO } from "../lib/api/mock/baseline";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { login } from "./helpers";

/*
 * priorities-words: no word in Detailed › Priorities' table breaks inside itself. Production
 * showed "Conversi / on" beside its code G-B in the Goal column and "instrumentatio / n" in
 * Depends on. The "long-words" scenario names goals and features with long single words
 * ("G-B Conversion", "G-A Internationalization", "Address lookup (instrumentation)").
 * protects=each word of the Goal, Feature and Depends on cells sits on one line, or breaks at a
 * hyphen; fails_when=a word's letters span two lines with no hyphen at the break.
 */

const SCROLLBAR = "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #999; }";

// Scrollbars drawn, as Windows and Linux draw them (priorities-scrollbar-room).
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

async function open(page: Page) {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, LONG_WORDS_SCENARIO] as const);
  await login(page, "approver@example.com");
  await page.goto("/priorities");
  await expect(page.locator('tr[data-testid^="priority-row-"]')).toHaveCount(8);
  await expect(page.getByTestId("priority-row-F-3").getByTestId("feature-name")).toContainText("Conversion");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * The words cut inside: for each visible text node in the cells, each character's line (its
 * client rect's top); a word whose letters move to a new line where the letter before the
 * break is no hyphen (nor a soft hyphen, drawn as one) is cut.
 */
function cutWords(page: Page) {
  return page.evaluate(() => {
    const cut: string[] = [];
    const cells = document.querySelectorAll<HTMLElement>(
      'tr[data-testid^="priority-row-"] :is([data-testid="row-goals"], [data-testid="feature-name"], [data-testid="row-deps"])',
    );
    for (const cell of cells) {
      if (!cell.checkVisibility()) continue;
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (const m of node.data.matchAll(/\S+/g)) {
          let top: number | null = null;
          for (let i = 0; i < m[0].length; i++) {
            const r = document.createRange();
            r.setStart(node, m.index + i);
            r.setEnd(node, m.index + i + 1);
            // The last: a letter after a soft hyphen's break also reports the drawn hyphen's box.
            const rect = [...r.getClientRects()].filter((x) => x.width > 0).at(-1);
            if (!rect) continue;
            if (top != null && rect.top > top + 4 && !/[-­]/.test(m[0][i - 1])) {
              cut.push(m[0].replace(/­/g, ""));
              break;
            }
            top = rect.top;
          }
        }
      }
    }
    return cut;
  });
}

for (const width of [1280, 1440, 1512]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`priorities-words: no word in the Goal, Feature and Depends on columns breaks inside itself at ${width} px`, async ({ page }) => {
      await open(page);
      // The feature panel open beside the table, as the page opens.
      const inspector = page.getByTestId("priority-inspector");
      await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(300);
      expect(await cutWords(page), "a word is cut with the feature panel open").toEqual([]);
      // Depends on shows from 1440 px beside the panel: "(instrumentation)" is in it.
      if (width >= 1440) await expect(page.getByTestId("priority-row-F-2").getByTestId("row-deps")).toContainText("instru");
      // Windows-style scrollbars take 15 px from the page.
      await page.addStyleTag({ content: SCROLLBAR });
      await expect.poll(() => page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)).toBeGreaterThanOrEqual(15);
      expect(await cutWords(page), "a word is cut with the scrollbar taking 15 px").toEqual([]);
      // Another feature in the panel: the table's widths stay, and so do its words.
      await page.getByTestId("priority-row-F-7").getByTestId("feature-name").click();
      await expect(inspector).toContainText("Bulk export");
      expect(await cutWords(page), "a word is cut with another feature in the panel").toEqual([]);
      // "Conversion" sits beside its code G-B, on the code's line: the column is sized for it.
      const goal = page.getByTestId("priority-row-F-3").getByTestId("row-goals");
      await expect(goal).toContainText("Conversion");
      const tag = (await goal.getByTestId("code-tag").boundingBox())!;
      const name = (await goal.getByTestId("code-name").boundingBox())!;
      expect(name.x, "the name beside its code").toBeGreaterThan(tag.x + tag.width);
      expect(Math.abs(name.y + name.height / 2 - (tag.y + tag.height / 2)), "on the code's line").toBeLessThan(4);
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("priorities-words: no word in a row's feature or goals breaks inside itself on a phone, the feature panel closed and open", async ({ page }) => {
    await open(page);
    expect(await cutWords(page), "a word is cut on a phone").toEqual([]);
    // The feature panel opens as a sheet and closes again; the rows' words stay whole.
    await page.getByTestId("priority-row-F-5").getByTestId("feature-name").click();
    const sheet = page.getByTestId("priority-sheet");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    expect(await cutWords(page), "a word is cut after the panel closed").toEqual([]);
  });
});
