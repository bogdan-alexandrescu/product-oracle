import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Value / effort follow-ups, on Simple's Priorities (the mock's default company and its "simple-plan" scenario, the
 * dated plan): a Ranked row beside the chart opens the one feature panel; a mark's shape and its name read one goal
 * (the plan's); a count says what its features share in the lone marks' words, rings when it holds the feature just
 * re-estimated, names its first three features, and its open sheet follows the data.
 */

const DESKTOP = { width: 1440, height: 900 };

async function open(page: Page, scenario: string | null): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=value-effort");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByTestId("vxe-point").first()).toBeVisible();
  // The plot is measured and laid out (marks and counts at their pixels).
  await page.waitForTimeout(300);
}

/** Moves Setup checklist (goal value 4, 2 wk) down twice with the arrow keys, onto Alert routing by team's spot: a count of 2. */
async function joinCount(page: Page) {
  const sc = page.locator('[data-testid="vxe-point"][data-code="setup-checklist"]');
  await sc.focus();
  await page.keyboard.press("ArrowDown");
  await expect(sc).toHaveAttribute("aria-label", /goal value 3\.5,/);
  await sc.focus();
  await page.keyboard.press("ArrowDown");
  await expect(sc).toHaveCount(0);
  return page.locator('[data-testid="vxe-crowd"][data-count="2"]');
}

test("desktop: a row in the Ranked list beside the chart opens the feature panel and stays selected", async ({ page }) => {
  await open(page, null);
  const row = page.getByTestId("side-row").nth(2);
  const title = (await row.getByTestId("prio-title").innerText()).trim();
  await row.getByRole("button").first().click();
  const panel = page.getByTestId("item-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(title);
  await expect(row).toHaveAttribute("data-selected", "true");
});

test("the dated plan: a mark draws the no-goal shape only when its name says it has no goal", async ({ page }) => {
  await open(page, "simple-plan");
  const marks = await page.getByTestId("vxe-point").evaluateAll((es) => es.map((e) => ({ code: e.getAttribute("data-code"), shape: e.getAttribute("data-shape"), label: e.getAttribute("aria-label") ?? "" })));
  expect(marks.length).toBeGreaterThan(5);
  for (const m of marks) expect(m.shape === "none", `${m.code}: "${m.label}" draws ${m.shape}`).toBe(m.label.endsWith(", no goal"));
  // Some features with a goal in the plan were drawn as no goal before.
  expect(marks.filter((m) => m.shape !== "none").length).toBeGreaterThan(0);
});

test("the dated plan: a count says what its features share in the lone marks' words", async ({ page }) => {
  await open(page, "simple-plan");
  const counts = page.getByTestId("vxe-crowd");
  const sheet = page.getByTestId("vxe-crowd-sheet");
  const labels = await counts.evaluateAll((es) => es.map((e) => e.getAttribute("aria-label") ?? ""));
  expect(labels.length).toBeGreaterThan(0);
  for (const l of labels) {
    expect(l, "no effort of 0 for PM-owned work").not.toMatch(/effort 0\b/);
    expect(l, "weeks, as lone marks say").not.toMatch(/\bwk\b/);
    expect(l).toMatch(/effort [\d.⁠–]+ weeks?|PM-owned, no effort/);
  }
  // PM-owned features (no effort, drawn at 0.25 wk) share a count somewhere on the plan.
  expect(labels.some((l) => l.includes("PM-owned, no effort")), labels.join("\n")).toBe(true);
  // A count's goal words follow its features' marks: every one with no goal says "no goal", never a goal value of 0.
  for (let i = 0; i < labels.length; i++) {
    await counts.nth(i).click();
    await expect(sheet).toBeVisible();
    const shapes = await sheet.getByTestId("vxe-crowd-row").evaluateAll((es) => es.map((e) => e.getAttribute("data-shape")));
    const title = (await sheet.getByRole("heading").innerText()).replace(/\s+/g, " ");
    if (shapes.every((s) => s === "none")) expect(title).toMatch(/· no goal$/);
    if (shapes.every((s) => s !== "none")) expect(title).not.toContain("no goal");
    expect(title).not.toMatch(/\bwk\b/);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
});

test("the default company: a count's name gives weeks as lone marks do and names its first three features", async ({ page }) => {
  await open(page, null);
  const count = page.locator('[data-testid="vxe-crowd"][data-count="15"]');
  await expect(count).toHaveAccessibleName(/^15 features at effort 1 week · goal value 0 or no goal: \S+ [^,]+, \S+ [^,]+, \S+ [^,]+ and 12 more; show them$/);
  await count.click();
  const rows = page.getByTestId("vxe-crowd-sheet").getByTestId("vxe-crowd-row");
  const first = await rows.evaluateAll((es) =>
    es.slice(0, 3).map((e) => `${e.querySelector('[data-testid="vxe-crowd-code"]')?.textContent} ${e.querySelector("span.truncate")?.textContent}`),
  );
  await page.keyboard.press("Escape");
  await expect(count).toHaveAccessibleName(new RegExp(`: ${first.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} and 12 more; show them$`));
});

test("desktop: a count holding the feature just re-estimated rings as the lone mark did", async ({ page }) => {
  await open(page, null);
  const count = await joinCount(page);
  await expect(count).toHaveAttribute("data-moved", "true");
  await expect(count).toHaveClass(/ring-2 ring-accent/);
});

test("desktop: an open count's sheet follows the data when it reloads", async ({ page }) => {
  await open(page, null);
  const count = await joinCount(page);
  await count.click();
  const sheet = page.getByTestId("vxe-crowd-sheet");
  await expect(sheet.getByTestId("vxe-crowd-row")).toHaveText([/Setup checklist/, /Alert routing by team/]);
  // Undo the last step from its toast while the sheet is open: Setup checklist goes back up to its own spot.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('[data-testid="vxe-point"][data-code="setup-checklist"]')).toHaveAttribute("aria-label", /goal value 3\.5,/);
  await expect(sheet.locator('[data-testid="vxe-crowd-row"][data-code="setup-checklist"]')).toHaveCount(0);
});
