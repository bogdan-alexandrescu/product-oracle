import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * fix2-simple-roadmap review: the minors left after the lane's fixes, on /simple/roadmap
 * against the mock's default scenario (web/lib/api/mock/simple-roadmap.ts), on a desktop
 * (1440x900) and a phone (390x844), each driven as a person would.
 */

const URL = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  /** qa-simple-roadmap-10: before Enter is pressed, the quick add says where it puts the item. */
  test("quick add says where Enter puts the item", async ({ page }) => {
    await open(page);
    const hint = page.getByTestId("quick-add-enter-hint");
    await expect(hint).toHaveCount(0);
    await page.getByLabel("Add an item").fill("A new idea from the test");
    const roadmap = page.getByTestId("quick-add-roadmap");
    if (await roadmap.count()) await roadmap.selectOption({ label: "Alerts roadmap" });
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(/^Enter adds it to Q[1-4] \d{4}$/);
  });

  /**
   * qa-simple-roadmap-11: on the Gantt, a short slice widened to its minimum width stops
   * where the next slice of the same item starts, so neighbouring slices never overlap
   * (the "simple-plan-lanes" scenario: every piece planned, at the coarser week scale).
   */
  for (const unit of ["day", "week"]) {
    test(`Gantt slices of one item never overlap (${unit} scale)`, async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan-lanes"] as const);
      await login(page);
      await page.goto(`${URL}?roadmap=onboarding-roadmap`);
      await page.getByTestId("format-gantt").click();
      await page.getByTestId(`unit-${unit}`).click();
      const slices = page.locator('g[data-testid="slice-bar"]');
      await expect(slices.first()).toBeVisible();
      // Each item's slices share one parent group: compare neighbours within it.
      const overlaps = await slices.evaluateAll((gs) => {
        const byParent = new Map<Element, DOMRect[]>();
        for (const g of gs) {
          const r = g.querySelector("rect[data-slice-body]")!.getBoundingClientRect();
          byParent.set(g.parentElement!, [...(byParent.get(g.parentElement!) ?? []), r]);
        }
        return [...byParent.values()].flatMap((boxes) => {
          boxes.sort((a, b) => a.left - b.left);
          return boxes.slice(1).flatMap((b, i) => (boxes[i].right > b.left + 0.5 ? [`${boxes[i].right} > ${b.left}`] : []));
        });
      });
      expect(overlaps).toEqual([]);
    });
  }

  /**
   * qa-simple-roadmap-23, -41: on the Waterfall, Discover is drawn in a colour of its own
   * (not the grey of "not in a milestone"), each phase's key shows the same ink as its bars,
   * and an estimated segment's hatch is the phase's own ink at full strength, not a pale stripe.
   */
  for (const scheme of ["light", "dark"] as const) {
    test(`Waterfall phases match their keys (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await page.getByTestId("format-waterfall").click();
      const discover = page.locator('rect[data-testid="phase"][data-phase="discover"]').first();
      await expect(discover).toBeAttached();
      expect(await page.locator('rect[data-testid="phase"][fill="var(--na)"]').count()).toBe(0);
      const keys = page.getByTestId("phase-key");
      await expect(keys.filter({ hasText: "Discover" })).toHaveCount(1);
      for (const phase of ["discover", "build", "beta", "launch"]) {
        const solid = page.locator(`rect[data-testid="phase"][data-phase="${phase}"][data-estimated="false"]`).first();
        if (!(await solid.count())) continue;
        const ink = await solid.getAttribute("fill");
        const label = phase[0].toUpperCase() + phase.slice(1);
        await expect(keys.filter({ hasText: label }).locator("[data-ink]")).toHaveAttribute("data-ink", ink!);
      }
      const stripe = page.locator("pattern#simple-hatch-build line");
      await expect(stripe).toHaveAttribute("stroke-width", "3");
      expect(await stripe.getAttribute("opacity")).toBeNull();
    });
  }
});

