import { crowdWhere, type CountRow } from "../app/simple/priorities/mark-counts";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Value / effort on Simple's Priorities (the mock's default company; its undated goal buckets for a rename), after PRs 1411 and 1420: effort reads
 * "1 week" / "N weeks" in the drag preview, a Ranked row's detail and the toast after a re-estimate; a feature whose
 * goal has no value reads its goal's name in a count, only one with no goal "no goal"; and each goal's shape follows
 * the goal itself, so two goals with one name draw two shapes.
 */

const DESKTOP = { width: 1440, height: 900 };

async function open(page: Page, tab: string, scenario: string | null = null): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto(`/simple/priorities?tab=${tab}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
}

async function openChart(page: Page, scenario: string | null = null): Promise<void> {
  await open(page, "value-effort", scenario);
  await expect(page.getByTestId("vxe-point").first()).toBeVisible();
  await page.waitForTimeout(300);
}

const mark = (page: Page, code: string) => page.locator(`[data-testid="vxe-point"][data-code="${code}"]`);

test("a drag's preview, the toast and the moved tag after it, and a Ranked row's detail say weeks", async ({ page }) => {
  await openChart(page);
  const am = mark(page, "alert-mobile");
  const box = (await am.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
    steps: 8,
  });
  const readout = page.getByTestId("vxe-drag-readout");
  await expect(readout).toHaveText(/^effort [\d.]+ weeks?$/);
  const effort = /^effort ([\d.]+)/.exec((await readout.innerText()).trim())![1];
  const words = `effort ${effort} ${effort === "1" ? "week" : "weeks"}`;
  await page.mouse.up();
  await expect(readout).toHaveCount(0);
  await expect(page.getByText(new RegExp(`^Re-estimated .+: ${words}$`))).toBeVisible();
  const side = page.locator('[data-testid="side-row"][data-code="alert-mobile"]');
  await expect(side.getByTestId("moved")).toHaveText(new RegExp(`^(rank stays #\\d+|now #\\d+) \\(${words}\\)$`));
  await mark(page, "alert-mobile").click();
  await expect(side.getByTestId("side-numbers")).toHaveText(new RegExp(`^goal value [\\d.]+ · confidence [\\d.]+ · ${effort} ${effort === "1" ? "week" : "weeks"} · score [\\d.]+$`));
});

test("a Ranked row's detail says 1 week for one week of effort", async ({ page }) => {
  await openChart(page);
  // Setup checklist (2 weeks) moves left twice with the arrow keys, to 1 week.
  const sc = mark(page, "setup-checklist");
  await sc.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(sc).toHaveAttribute("aria-label", /effort 1\.5 weeks/);
  await expect(page.locator('[data-testid="side-row"][data-code="setup-checklist"]').getByTestId("moved")).toHaveText(/\(effort 1\.5 weeks\)$/);
  await sc.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText(/^Re-estimated .+: effort 1 week$/)).toBeVisible();
  await page.locator('[data-testid="side-row"][data-code="setup-checklist"]').getByRole("button").first().click();
  await expect(page.locator('[data-testid="side-row"][data-code="setup-checklist"]').getByTestId("side-numbers")).toContainText(" · 1 week · score ");
});

/*
 * The mock gives every ranked feature a goal value, so a goal with no value (as the API sends when Oracle has none)
 * is read here from the words a count's name and sheet title use.
 */
test("a count reads a valueless goal by its name; only a feature with no goal reads 'no goal'", () => {
  type R = CountRow & { goal: string | null };
  const row = (code: string, goal: string | null, goal_value: number | null, effort: number | null = 1): R => ({
    feature_id: code,
    code,
    title: code,
    rank: 1,
    goal,
    goal_value,
    effort,
  });
  const goalOf = (r: R) => r.goal;
  expect(crowdWhere([row("a", "Grow retention", null), row("b", "Grow retention", null)], goalOf)).toBe("effort 1 week · Grow retention");
  expect(crowdWhere([row("a", "Grow retention", null), row("b", "Faster activation", 2)], goalOf)).toBe("effort 1 week · goal value 2 or Grow retention");
  expect(crowdWhere([row("a", "Grow retention", null), row("b", null, 0)], goalOf)).toBe("effort 1 week · goal value 0 or Grow retention or no goal");
  expect(crowdWhere([row("a", null, 0), row("b", null, 0)], goalOf)).toBe("effort 1 week · goal value 0 · no goal");
  expect(crowdWhere([row("a", "Grow retention", 2, 2), row("b", null, 0, 4)], goalOf)).toBe("effort 2⁠–⁠4 weeks · goal value 0⁠–⁠2 or no goal");
});

test("two goals with one name draw two shapes, each kept when a goal is renamed", async ({ page }) => {
  await openChart(page, "goal-buckets-undated");
  const shapes = () => page.getByTestId("vxe-point").evaluateAll((es) => Object.fromEntries(es.map((e) => [e.getAttribute("data-code"), e.getAttribute("data-shape")])));
  const before = await shapes();
  const legend = page.getByRole("list", { name: "Legend" });
  const goals = legend.getByRole("listitem").filter({ has: page.locator("svg") });
  const names = (await goals.allInnerTexts()).map((t) => t.trim()).filter((t) => t && t !== "No goal" && t !== "Below the line");
  expect(names).toContain("Grow retention");
  const other = names.find((n) => n !== "Grow retention")!;
  const grow = legend.getByRole("listitem").filter({ hasText: /^Grow retention$/ });
  await expect(grow).toHaveCount(1);
  // Rename the other goal to Grow retention in Goal buckets, as a person would.
  await page.getByRole("tab", { name: "Goal buckets" }).click();
  await page.getByRole("button", { name: `Edit ${other}` }).click();
  const form = page.getByTestId("goal-form");
  await form.getByLabel("Goal").fill("Grow retention");
  await form.getByRole("button", { name: "Save goal" }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("tab", { name: "Value / effort" }).click();
  await expect(page.getByTestId("vxe-point").first()).toBeVisible();
  await page.waitForTimeout(300);
  // Each goal keeps its shape, though both now read "Grow retention"; the legend keys both, each by its own shape.
  await expect(legend.getByRole("listitem").filter({ hasText: new RegExp(`^${other}$`) })).toHaveCount(0);
  await expect(grow).toHaveCount(2);
  expect(await shapes()).toEqual(before);
});
