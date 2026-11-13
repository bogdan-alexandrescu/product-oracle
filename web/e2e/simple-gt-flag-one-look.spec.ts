import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator } from "./test";

/*
 * Train BQ review: one "Not in the Ground Truth" flag (docs/ground-truth.md), the same on every page
 * that names a feature: the Roadmap's rows, Priorities' ranked list and the Goal map's chips all show
 * the Roadmap's warn chip, never a neutral tag on one page and a warn chip on another. Mock data only
 * (invented).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const NOT_IN_GT = "Not in the Ground Truth";

/** The flag's look: what kind of chip it is, and its colours and shape as a person sees them. */
async function look(flag: Locator) {
  await expect(flag).toHaveText(NOT_IN_GT);
  return {
    kind: await flag.getAttribute("data-kind"),
    ...(await flag.evaluate((e) => {
      const s = getComputedStyle(e);
      return { color: s.color, background: s.backgroundColor, radius: s.borderTopLeftRadius };
    })),
  };
}

test("the Not in the Ground Truth flag looks the same on the Roadmap, Priorities and the Goal map", async ({ page }) => {
  // protects=the flag on Priorities' ranked list and on the Goal map's chips is the Roadmap's warn chip
  // (same kind, colours and shape); fails_when=one page shows it as a neutral tag and another as a warn chip;
  // no_claim=which features are flagged, the flag's size in each place.
  // The mock reads its scenario at sign-in: the Goal map's hard one has a chip with no code.
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "goal-map-hard"] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
  const chip = page.locator('[data-testid="gm-chip"][data-track="none"]').filter({ hasText: "Faster ID check" });
  const goalMap = await look(chip.getByTestId("not-in-gt"));

  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("format-timeline").click();
  const rules = page.locator('[data-testid="timeline-row"][data-item="alert-rules"]').first();
  await rules.scrollIntoViewIfNeeded();
  const roadmap = await look(rules.getByTestId("not-in-gt"));
  expect(roadmap.kind).toBe("warn");
  expect(goalMap).toEqual(roadmap);

  await page.goto("/simple/priorities");
  const prio = await look(page.locator('[data-testid="prio-row"][data-code="alert-sso"]').getByTestId("not-in-gt"));
  expect(prio).toEqual(roadmap);
});
