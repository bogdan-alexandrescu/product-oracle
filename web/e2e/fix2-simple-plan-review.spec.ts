import { MOCK_FAIL_ONCE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Review of fix2-simple-plan (/simple/priorities): with a dated plan the Ranked list shows what
 * makes the line first, so a row's visual neighbour is not its neighbour by rank; a move with the
 * keys or a drag stays in rank order. Also: Value / effort's marks name the plan's goal, a
 * proposal always says so, the goal drawer keeps the focus. Mock company, desktop 1440x900.
 */

async function setUp(page: Page, opts: { scenario?: string; email?: string } = {}) {
  const { scenario = null, email = ADMIN.email } = opts;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value]) => {
      if (value) localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, scenario] as const,
  );
  await login(page, email);
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId(query ? "simple-priorities" : "prio-row").first()).toBeVisible();
}

const rows = (page: Page): Locator => page.getByTestId("prio-row");
const moveDialog = (page: Page): Locator => page.getByRole("dialog", { name: /^Why move / });

/** The rows' ranks and whether each makes the line, as listed. */
async function listed(page: Page): Promise<{ rank: number; above: boolean; title: string }[]> {
  return rows(page).evaluateAll((els) =>
    els.map((e) => ({
      rank: Number(e.querySelector('[data-testid="prio-rank"]')!.textContent),
      above: e.getAttribute("data-above") === "true",
      title: e.querySelector('[data-testid="prio-title"]')!.textContent ?? "",
    })),
  );
}

/** Where the dialog asks to move the item: its rank, or null when the move is refused. */
async function askedRank(page: Page): Promise<number | null> {
  const heading = (await moveDialog(page).getByRole("heading").textContent()) ?? "";
  const m = heading.match(/to rank (\d+)$/);
  return m ? Number(m[1]) : null;
}

test.describe("fix2-simple-plan review: moves on a dated plan stay in rank order", () => {
  test("ArrowDown on the last row above the line asks for the next rank, never a higher one", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page);
    const list = await listed(page);
    const split = list.findIndex((r) => !r.above);
    expect(split).toBeGreaterThan(0);
    const last = list[split - 1];
    // The plan regroups the list: the next row by rank is not the one under it.
    expect(list[split].rank).toBeLessThan(last.rank);
    await rows(page).nth(split - 1).getByRole("button", { name: /^Drag / }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(moveDialog(page)).toBeVisible();
    expect(await askedRank(page)).toBe(last.rank + 1);
  });

  test("ArrowUp on the first row below the line asks for the rank just above it", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page);
    const list = await listed(page);
    const split = list.findIndex((r) => !r.above);
    const first = list[split];
    await rows(page).nth(split).getByRole("button", { name: /^Drag / }).focus();
    await page.keyboard.press("ArrowUp");
    await expect(moveDialog(page)).toBeVisible();
    await expect(moveDialog(page)).not.toContainText("Can't go below");
    expect(await askedRank(page)).toBe(first.rank - 1);
  });

  test("a drag across the line keeps the row in its own part", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page);
    const list = await listed(page);
    const split = list.findIndex((r) => !r.above);
    const last = list[split - 1];
    const handle = rows(page).nth(split - 1).getByRole("button", { name: /^Drag / });
    await handle.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const from = (await handle.boundingBox())!;
    const target = (await rows(page).nth(split + 1).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, target.y + target.height / 2 + 2, { steps: 10 });
    await page.mouse.up();
    // Dropped past the line, it asks for nothing that would jump it ranks up.
    await page.waitForTimeout(300);
    if (await moveDialog(page).isVisible()) {
      const asked = await askedRank(page);
      if (asked != null) expect(asked).toBeGreaterThan(last.rank);
    }
    expect(await rows(page).nth(split - 1).getByTestId("prio-rank").textContent()).toBe(String(last.rank));
  });
});

test.describe("fix2-simple-plan review: Value / effort, proposals, the goal drawer", () => {
  test("a mark the plan gives a goal does not say 'no goal'", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await open(page);
    const goals = await rows(page).evaluateAll((els) => els.map((e) => [e.getAttribute("data-code"), e.querySelector('[data-testid="prio-goal"]')!.textContent] as const));
    const withGoal = goals.filter(([, g]) => g !== "No goal").map(([c]) => c!);
    expect(withGoal.length).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Value / effort" }).click();
    await expect(page.getByTestId("vxe-point").first()).toBeVisible();
    for (const code of withGoal) await expect(page.locator(`[data-testid="vxe-point"][data-code="${code}"]`)).not.toHaveAttribute("aria-label", /no goal/);
  });

  test("a proposal says so even when the list cannot be read again", async ({ page }) => {
    await setUp(page, { email: "commenter@example.com" });
    await open(page);
    await page.locator('[data-testid="prio-row"][data-code="alert-mobile"]').getByRole("button", { name: /^Drag / }).focus();
    await page.keyboard.press("ArrowUp");
    const dialog = moveDialog(page);
    await dialog.getByLabel("Reason").fill("Push is what the beta users asked for");
    // The read after the proposal fails once.
    await page.evaluate((key) => localStorage.setItem(key, "GET /v1/simple/priorities"), MOCK_FAIL_ONCE_KEY);
    await dialog.getByRole("button", { name: "Propose", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Proposed: / })).toBeVisible();
  });

  test("the desktop goal drawer keeps the focus inside it", async ({ page }) => {
    await setUp(page);
    await open(page, "?tab=buckets");
    await page.getByRole("button", { name: "Suggestions for Grow retention" }).click();
    const drawer = page.getByTestId("goal-panel");
    await expect(drawer).toBeVisible();
    const inside = () => drawer.evaluate((d) => d.contains(document.activeElement));
    await expect.poll(inside).toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(true);
    }
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside()).toBe(true);
    }
  });
});
