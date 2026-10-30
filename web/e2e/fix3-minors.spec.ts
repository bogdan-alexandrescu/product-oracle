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

/** The rows as listed: rank, whether each makes the line, title. */
async function listed(
  page: Page,
): Promise<{ rank: number; above: boolean; title: string }[]> {
  return rows(page).evaluateAll((els) =>
    els.map((e) => ({
      rank: Number(e.querySelector('[data-testid="prio-rank"]')!.textContent),
      above: e.getAttribute("data-above") === "true",
      title: e.querySelector('[data-testid="prio-title"]')!.textContent ?? "",
    })),
  );
}

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
      await expect(dialog.getByTestId("move-lands")).toHaveText(`It lands just under ${list[to].title}, above the line.`);
    });

    test("dragged past the line, it asks for the last rank above it and stays above it", async ({ page }) => {
      await open(page, width, height);
      const list = await listed(page);
      const split = list.findIndex((r) => !r.above);
      const [moving, last] = [list[split - 2], list[split - 1]];
      await drag(page, split - 2, split + 1);
      const dialog = moveDialog(page);
      await expect(dialog.getByRole("heading")).toHaveText(new RegExp(`to rank ${last.rank}$`));
      await expect(dialog.getByTestId("move-lands")).toHaveText(`It lands just under ${last.title}, above the line.`);
      await dialog.getByLabel("Reason").fill("Ship it with the plan");
      await dialog.getByRole("button", { name: /^Move/ }).click();
      await expect(dialog).toBeHidden();
      await expect(rows(page).nth(split - 1).getByTestId("prio-title")).toHaveText(moving.title);
      const after = await listed(page);
      expect(after[split - 1]).toEqual({ rank: last.rank, above: true, title: moving.title });
    });
  });
}
