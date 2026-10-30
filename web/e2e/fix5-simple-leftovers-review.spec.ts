import { MOCK_NOW } from "../lib/api/mock/clock";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * simple-leftovers review, driven through the UI on the mock layer: the Timeline in the
 * "simple-plan" scenario (Guided setup's plan; Team invites has two slices in M1 and Oracle's
 * date suggestion), a week after the mock's "now", so Team invites starts at the chart's left
 * edge and its "?" (the suggestion's button) sits right of the pill.
 *
 * Desktop only: a phone's Timeline (B3) draws its pills without names, so no name can sit
 * under a "?" there (fix4-plan-simple-roadmap's phone tests cover its rows).
 * no_claim for every test here: the API (the mock stands in: api/tests/test_simple_plan*.py).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const WEEK_ON = new Date(new Date(MOCK_NOW).getTime() + 7 * 86_400_000);

test.describe("desktop", () => {
  test.use(DESKTOP);

  // Card simple-leftovers-review-slice-mark: protects = a sliced pill whose name is written
  // beside it starts that name past Oracle's "?" when the "?" sits right of the pill, as a
  // pill with no slices does; fails_when = the name starts 6px past the pill, under the "?";
  // no_claim = the name's exact cut (it ends at the row's next pill, ellipsized).
  test("a sliced pill's name beside it never runs under Oracle's '?'", async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await page.clock.setSystemTime(WEEK_ON);
    await login(page);
    await page.goto("/simple/roadmap");
    const chart = page.getByTestId("simple-chart");
    await expect(chart).toHaveAttribute("data-format", "timeline");
    await page.getByTestId("group-milestone").click();
    const invites = chart.locator('g[data-testid="bar"]').filter({ has: page.locator('[data-testid="slice-label"]', { hasText: /^Team invites/ }) });
    await expect(invites).toHaveCount(1);
    const item = await invites.getAttribute("data-item");
    const mark = chart.locator(`[data-testid="suggestion-open"][data-item="${item}"]`);
    await expect(mark).toBeVisible();
    const name = invites.locator('[data-testid="slice-label"][data-beside="true"]');
    await expect(name).toHaveText(/^Team invites/);
    const m = (await mark.boundingBox())!;
    const n = (await name.boundingBox())!;
    const pill = (await invites.locator("rect[data-body]").boundingBox())!;
    // The "?" is right of the pill here, and the name starts past it.
    expect(m.x).toBeGreaterThan(pill.x + pill.width - 1);
    expect(n.x).toBeGreaterThanOrEqual(m.x + m.width);
    // Every pill's name, in or beside it, clears its own "?".
    const under = await chart.locator('g[data-testid="bar"]').evaluateAll((bars) =>
      bars.flatMap((g) => {
        const q = g.parentElement!.querySelector(`[data-testid="suggestion-open"][data-item="${g.getAttribute("data-item")}"]`);
        if (!q) return [];
        const qb = q.getBoundingClientRect();
        return [...g.querySelectorAll('[data-testid="slice-label"], [data-testid="bar-label"]')]
          .filter((t) => {
            const tb = t.getBoundingClientRect();
            return tb.left < qb.right && tb.right > qb.left;
          })
          .map((t) => t.textContent);
      }),
    );
    expect(under).toEqual([]);
  });
});
