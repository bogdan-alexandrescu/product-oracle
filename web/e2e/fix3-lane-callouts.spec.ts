import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix3, qa-simple-roadmap-4 ("Under the lane", the owner's pick, 2026-10-29): on the desktop's
 * goal lanes (B2) a broken link's callout no longer covers the other pills in its lane; the lane
 * grows one line per row with a callout, and the callout sits under its broken pill in the
 * existing callout's look and words. Group by Track, PRD and Milestone lanes do the same.
 * Driven against the mock's default scenario (Weekly alert digest starts before Alert rules
 * engine, which it depends on, ends).
 */

const DESKTOP = { viewport: { width: 1366, height: 820 } };
const RH = 28;

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const callout = (page: Page, key: string): Locator => page.locator(`[data-testid="broken-callout"][data-item="${key}"]`);

async function open(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(([themeKey, theme]) => localStorage.setItem(themeKey, theme), [THEME_KEY, scheme] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "lanes");
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Every callout clear of every pill; each under its own pill, inside its lane; each lane one line taller per row with a callout. */
async function checkUnder(page: Page) {
  const callouts = page.getByTestId("broken-callout");
  await expect(callouts.first()).toBeVisible();
  await expect(callout(page, "alert-digest")).toBeVisible();
  const pills = page.locator('g[data-testid="bar"] rect[data-body], g[data-testid="slice-bar"] rect[data-slice-body]');
  const pillBoxes = (await Promise.all((await pills.all()).map((p) => p.boundingBox()))).filter((b): b is Box => !!b);
  expect(pillBoxes.length).toBeGreaterThan(1);
  const perLane = new Map<string, Set<number>>();
  for (const c of await callouts.all()) {
    const key = (await c.getAttribute("data-item"))!;
    const cb = (await c.boundingBox())!;
    for (const p of pillBoxes) expect(overlaps(cb, p), `${key}'s callout covers a pill`).toBe(false);
    const b = bar(page, key);
    const bb = (await b.locator("rect[data-body], rect[data-slice-body]").first().boundingBox())!;
    expect(cb.y, `${key}'s callout sits under its pill`).toBeGreaterThanOrEqual(bb.y + bb.height - 1);
    expect(cb.y - (bb.y + bb.height), `${key}'s callout sits right under its pill`).toBeLessThan(RH);
    const laneKey = (await b.getAttribute("data-lane"))!;
    const row = Number(await b.getAttribute("data-row"));
    (perLane.get(laneKey) ?? perLane.set(laneKey, new Set()).get(laneKey)!).add(row);
    const lane = (await page.locator(`[data-testid="chart-group"][data-lane="${laneKey}"]`).boundingBox())!;
    expect(cb.y + cb.height, `${key}'s callout stays in its lane`).toBeLessThanOrEqual(lane.y + lane.height + 0.5);
  }
  for (const [laneKey, calloutRows] of perLane) {
    const rows = new Set(await page.locator(`g[data-testid="bar"][data-lane="${laneKey}"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-row"))));
    const lane = (await page.locator(`[data-testid="chart-group"][data-lane="${laneKey}"]`).boundingBox())!;
    expect(Math.round(lane.height), `lane ${laneKey}: ${rows.size} rows and ${calloutRows.size} callout lines`).toBe((rows.size + calloutRows.size) * RH + 8);
  }
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ ...DESKTOP, colorScheme: scheme });

    test(`a broken link's callout sits under its pill and covers none (goal lanes, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", "goal");
      await checkUnder(page);
      // The callout names both items, in the existing callout's words.
      const c = callout(page, "alert-digest");
      await expect(c).toContainText("Weekly alert digest");
      await expect(c).toContainText("Alert rules engine");
      await expect(c).toContainText("which it depends on, ends");
      // Every pill takes its own clicks (nothing drawn over its middle).
      const hit = await page.locator('g[data-testid="bar"]').evaluateAll((els) =>
        els
          .map((g) => ({ g, r: (g.querySelector("rect[data-body], rect[data-slice-body]") ?? g).getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.y >= 0 && r.y + r.height <= innerHeight)
          .map(({ g, r }) => {
            const at = document.elementFromPoint(r.x + Math.min(r.width / 2, 12), r.y + r.height / 2);
            return { key: g.getAttribute("data-item"), ok: !!at && g.contains(at) };
          }),
      );
      expect(hit.filter((h) => !h.ok)).toEqual([]);
      // A pill next to the broken one still opens its card.
      await bar(page, "alert-mobile").click();
      await expect(bar(page, "alert-mobile")).toHaveAttribute("data-open", "true");
      await page.keyboard.press("Escape");
      // The callout still opens its fixes.
      await c.getByRole("button", { name: "Accept as risk" }).click();
      await expect(page.getByLabel("Why it is an accepted risk")).toBeVisible();
    });

    test(`Group by Track, PRD and Milestone lanes put the callout under its pill too (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      for (const group of ["track", "prd", "milestone"] as const) {
        await page.getByTestId(`group-${group}`).click();
        await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", group);
        await expect.poll(async () => bar(page, "alert-digest").getAttribute("data-lane")).not.toBe(null);
        await expect(async () => checkUnder(page)).toPass({ timeout: 10_000 });
      }
    });
  });
}
