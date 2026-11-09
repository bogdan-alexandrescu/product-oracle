import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * kr-in-priorities, on the mock's "goal-key-results" scenario (invented: Faster activation has two confirmed key
 * results, KR 1 with a feature on it, Guided setup checklist, and KR 2 with none yet).
 *
 * Card kr-buckets: protects = Goal buckets draws one bucket for the goal, never one per key result; both key results
 * are listed inside it; the key result's feature is counted and listed under the goal; fails_when = a key result has a
 * bucket of its own, a key result is missing from its goal's bucket or its feature is not under the goal.
 * Card kr-legend: protects = the Value / effort chart's legend lists the goal once and no key result, and the key
 * result's feature draws with its goal's shape; fails_when = a key result is a legend entry or a shape of its own.
 */

const KR1 = "Half of new teams set up in one day";
const KR2 = "New teams send a first alert in week one";
const FEATURE = "Guided setup checklist";

async function open(page: Page, tab: "buckets" | "value-effort" | "ranked") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, themeKey]) => {
      localStorage.setItem(key, "goal-key-results");
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, THEME_KEY] as const,
  );
  await login(page);
  await page.goto(`/simple/priorities?tab=${tab}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
}

test("Goal buckets: one bucket for the goal, its key results inside it, a key result's feature under the goal", async ({ page }) => {
  await open(page, "buckets");
  const buckets = page.getByRole("region", { name: "Goal buckets" }).locator('[data-testid="goal-bucket"], [data-testid="plan-goal"]');
  await expect(buckets.first()).toBeVisible();
  const goal = buckets.filter({ has: page.getByRole("heading", { name: "Faster activation", exact: true }) });
  await expect(goal).toHaveCount(1);
  // No bucket is a key result's.
  await expect(buckets.getByRole("heading", { name: new RegExp(`${KR1}|${KR2}`) })).toHaveCount(0);
  // Both key results inside the goal's bucket, by name.
  const krs = goal.getByRole("list", { name: "Faster activation's key results" }).getByTestId("goal-kr");
  await expect(krs).toHaveCount(2);
  await expect(krs.nth(0)).toContainText(KR1);
  await expect(krs.nth(1)).toContainText(KR2);
  // The key result's feature is counted and listed under its goal.
  await expect(goal.getByTestId("bucket-features")).toContainText(FEATURE);
});

test("Value / effort: the legend lists the goal once, and the key result's feature draws with its goal's shape", async ({ page }) => {
  await open(page, "value-effort");
  const legend = page.getByRole("list", { name: "Legend" });
  await expect(legend).toBeVisible();
  const goal = legend.getByRole("listitem").filter({ hasText: /^Faster activation$/ });
  await expect(goal).toHaveCount(1);
  await expect(legend.getByRole("listitem").filter({ hasText: new RegExp(`${KR1}|${KR2}`) })).toHaveCount(0);
  const shape = await goal.getAttribute("data-shape");
  const marks = page.locator('[data-testid="vxe-point"][data-code="kr-setup-list"]');
  await expect(marks).toHaveCount(1);
  await expect(marks).toHaveAttribute("data-shape", shape!);
});
