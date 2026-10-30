import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Train AB's leftover minors (/simple/priorities, the "simple-plan" mock's dated plan): a row
 * dragged among the rows that make the line stays among them, its rank at most the last of
 * theirs, and the move dialog says where it lands. Desktop 1440x900 and phone 390x844.
 */

const rows = (page: Page): Locator => page.getByTestId("prio-row");
const moveDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: /^Why move / });

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      "simple-plan",
    ] as const);
  await login(page);
  await page.goto("/simple/priorities");
  await expect(rows(page).first()).toBeVisible();
}

/** The rows as listed: rank, whether each makes the line, title, and code chip. */
async function listed(
  page: Page,
): Promise<{ rank: number; above: boolean; title: string; code: string }[]> {
  return rows(page).evaluateAll((els) =>
    els.map((e) => ({
      rank: Number(e.querySelector('[data-testid="prio-rank"]')!.textContent),
      above: e.getAttribute("data-above") === "true",
      title: e.querySelector('[data-testid="prio-title"]')!.textContent ?? "",
      code: e.querySelector('[data-testid="prio-code"]')!.textContent ?? "",
    })),
  );
}

/** A row named as the move dialog's heading names it: its title, then its short code. */
const named = (r: { title: string; code: string }): string => (r.code && r.code !== r.title ? `${r.title} (${r.code})` : r.title);

/** Drags row `from`'s handle to just past the middle of row `to`, as a person would. */
async function drag(page: Page, from: number, to: number): Promise<void> {
  const handle = rows(page)
    .nth(from)
    .getByRole("button", { name: /^Drag / });
  await rows(page)
    .nth(to)
    .evaluate((e) => e.scrollIntoView({ block: "center" }));
  await handle.evaluate((e) => e.scrollIntoView({ block: "nearest" }));
  const h = (await handle.boundingBox())!;
  const target = (await rows(page).nth(to).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, target.y + target.height / 2 + 2, {
    steps: 12,
  });
  await page.mouse.up();
}

for (const [device, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  test.describe(`fix3-minors: a drag above the line stays above it (${device})`, () => {
    test("dragged onto a row above the line, it asks for that row's rank and says it lands under it, above the line", async ({ page }) => {
      await open(page, width, height);
      const list = await listed(page);
      const split = list.findIndex((r) => !r.above);
      // Two rows next to each other above the line, with rows that miss it between them by rank.
      const from = list.findIndex((r, i) => i + 1 < split && list.some((x) => !x.above && x.rank > r.rank && x.rank < list[i + 1].rank));
      expect(from).toBeGreaterThanOrEqual(0);
      const to = from + 1;
      await drag(page, from, to);
      const dialog = moveDialog(page);
      await expect(dialog.getByRole("heading")).toHaveText(new RegExp(`to rank ${list[to].rank}$`));
      await expect(dialog.getByTestId("move-lands")).toHaveText(`It lands just under ${named(list[to])}, above the line.`);
    });

    test("dragged past the line, it asks for the last rank above it and stays above it", async ({ page }) => {
      await open(page, width, height);
      const list = await listed(page);
      const split = list.findIndex((r) => !r.above);
      const moving = list[split - 2];
      // BGD (train AD): a drop onto the last row above the line asks for the last rank still
      // above it, as many as rows make the line (#15 here), not that row's own rank (#26).
      const lastAboveRank = list.filter((r) => r.above).length;
      // At that rank it lands under the row above the line that comes just before it by rank.
      const byRank = list.filter((r) => r !== moving).sort((a, b) => a.rank - b.rank);
      byRank.splice(lastAboveRank - 1, 0, moving);
      const aboveByRank = byRank.filter((r) => r.above);
      const under = aboveByRank[aboveByRank.indexOf(moving) - 1];
      await drag(page, split - 2, split + 1);
      const dialog = moveDialog(page);
      await expect(dialog.getByRole("heading")).toHaveText(new RegExp(`to rank ${lastAboveRank}$`));
      await expect(dialog.getByTestId("move-lands")).toHaveText(`It lands just under ${named(under)}, above the line.`);
      await dialog.getByLabel("Reason").fill("Ship it with the plan");
      await dialog.getByRole("button", { name: /^Move/ }).click();
      await expect(dialog).toBeHidden();
      await expect(rows(page).filter({ hasText: moving.title }).getByTestId("prio-rank")).toHaveText(String(lastAboveRank));
      const after = await listed(page);
      const at = after.findIndex((r) => r.title === moving.title);
      expect(after[at]).toEqual({ rank: lastAboveRank, above: true, title: moving.title, code: moving.code });
      expect(after[at - 1].title).toBe(under.title);
      expect(at).toBeLessThan(after.findIndex((r) => !r.above));
    });

    // fix3-minors review: the clamp holds for any dated plan, also one whose rows are already in
    // rank order (what makes the line has the first ranks), not only one the dates regroup.
    test("in a dated plan whose line two far-apart rows make, the list splits at the line in rank order", async ({ page }) => {
      await open(page, width, height);
      // A line on a picked day that only two rows make, far apart by rank.
      await page.locator("#prio-line").selectOption("pick");
      await page.getByLabel("The line's date").fill("2026-11-16");
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByTestId("line-caption")).toContainText(/^\d+ of \d+ miss Nov 16, 2026/);
      const list = await listed(page);
      expect(list.filter((r) => r.above).length).toBe(2);
      // QA pass 3 (qa-simple-plan-2): the list is split at the line, the two that make it first.
      expect(list.map((r) => r.above).slice(0, 3)).toEqual([true, true, false]);
      // Each side keeps rank order; the drag past the line is the test above (a row needed by
      // another stays where it is, so this one does not drag here).
      const ranks = (above: boolean) => list.filter((r) => r.above === above).map((r) => r.rank);
      for (const side of [ranks(true), ranks(false)]) expect(side).toEqual([...side].sort((a, b) => a - b));
    });
  });
}
