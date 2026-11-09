import { stableUuid } from "../lib/api/mock/ids";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITIES_PLAN_KEY_RESULTS_SCENARIO } from "../lib/api/mock/simple-priorities";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * kr-in-priorities, on the mock's "goal-key-results" scenario (invented: Faster activation has two confirmed key
 * results, KR 1 with a feature on it, Guided setup checklist, and a target, and KR 2 with none yet; KR 1's own confirmed
 * subgoal, Setup takes ten minutes, and a proposed key result, Teams share a first report, kr-fold), and on
 * "priorities-plan-key-results" (a dated plan whose goal Activation is a key result of Growth).
 *
 * Card kr-buckets: protects = Goal buckets draws one bucket for the goal, never one per key result; both key results
 * are listed inside it, each with its code once and its target behind an (i), KR 1's confirmed subgoal after KR 1 and
 * the proposed key result not listed (as the API lists them: confirmed subgoals at any depth); the key result's feature
 * is counted, listed with its weeks and its grip under the goal; a goal with no key results lists none; fails_when = a
 * key result has a bucket of its own, is missing from its goal's bucket, reads two codes, a proposed one is listed, or
 * its feature is not under the goal.
 * Card kr-plan-buckets: protects = with a dated plan, the key result is listed in its goal's card, a slice naming it
 * sits under that goal, and the goals are numbered 1 to n; fails_when = a key result has a card, its slice loses its
 * goal, or the numbers skip the key result's.
 * Card kr-legend: protects = the Value / effort chart's legend lists the goal once and no key result, and the key
 * result's feature draws with its goal's shape; fails_when = a key result is a legend entry or a shape of its own.
 * Card kr-ranked: protects = the Ranked list names the goal on a key result's feature, and a key result's list
 * (the Goal map's "Open the goal" on it, not on the map yet) lists its features; fails_when = that list is empty.
 */

const KR1 = "Half of new teams set up in one day";
const KR2 = "New teams send a first alert in week one";
const SUB = "Setup takes ten minutes";
const PROPOSED = "Teams share a first report";
const FEATURE = "Guided setup checklist";

async function open(page: Page, tab: "buckets" | "value-effort" | "ranked", scenario = "goal-key-results", query = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, themeKey, name]) => {
      localStorage.setItem(key, name);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scenario] as const,
  );
  await login(page);
  await page.goto(`/simple/priorities?tab=${tab}${query}`);
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
  // Both key results inside the goal's bucket, by name, each with its code once; KR 1's confirmed subgoal after it
  // (kr-fold, as the API folds it in), the proposed key result not listed.
  const krs = goal.getByRole("list", { name: "Faster activation's key results" }).getByTestId("goal-kr");
  await expect(krs).toHaveCount(3);
  await expect(krs.nth(0).getByText(KR1)).toHaveText(`KR 1 ${KR1}`);
  await expect(krs.nth(1).getByText(SUB)).toHaveText(`G-A.1.1 ${SUB}`);
  await expect(krs.nth(2).getByText(KR2)).toHaveText(`KR 2 ${KR2}`);
  await expect(krs.filter({ hasText: PROPOSED })).toHaveCount(0);
  // KR 1's target behind its (i); KR 2 has none.
  await expect(krs.nth(2).getByTestId("goal-kr-tip")).toHaveCount(0);
  await krs.nth(0).getByTestId("goal-kr-tip").click();
  await expect(page.getByText("New teams set up in one day: 50%")).toBeVisible();
  // The key result's feature is listed under its goal, with its weeks and its grip.
  const row = goal.getByTestId("plan-feature").filter({ hasText: FEATURE });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("plan-feature-total")).toHaveText(/^3 /);
  await expect(row.getByRole("button", { name: `Move ${FEATURE} to another goal` })).toBeVisible();
  // A goal with no key results lists none.
  const other = buckets.filter({ has: page.getByRole("heading", { name: "Cut support load", exact: true }) });
  await expect(other).toHaveCount(1);
  await expect(other.getByTestId("goal-krs")).toHaveCount(0);
});

test("Goal buckets, dated plan: the key result in its goal's card, its slice under the goal, goals numbered 1 to n", async ({ page }) => {
  await open(page, "buckets", PRIORITIES_PLAN_KEY_RESULTS_SCENARIO);
  const cards = page.getByRole("region", { name: "Goal buckets" }).getByTestId("plan-goal");
  await expect(cards.first()).toBeVisible();
  // No card is the key result's.
  await expect(cards.filter({ has: page.getByRole("heading", { name: "Activation", exact: true }) })).toHaveCount(0);
  const growth = cards.filter({ has: page.getByRole("heading", { name: "Growth", exact: true }) });
  await expect(growth).toHaveCount(1);
  const krs = growth.getByRole("list", { name: "Growth's key results" }).getByTestId("goal-kr");
  await expect(krs).toHaveCount(1);
  await expect(krs.getByText("Activation")).toHaveText(/Activation$/);
  await krs.getByTestId("goal-kr-tip").click();
  await expect(page.getByText("Teams that finish setup in a day: 65%")).toBeVisible();
  // A slice naming the key result (its feature not in the goal buckets yet) sits under the goal.
  await expect(growth.locator('[data-testid="plan-feature"][data-code="F-20"]')).toHaveCount(1);
  await expect(cards.filter({ has: page.getByRole("heading", { name: "Reliability", exact: true }) }).getByTestId("goal-krs")).toHaveCount(0);
  // The goals are numbered 1 to n, the key result's number left out.
  const numbers = await page.getByRole("region", { name: "Goal buckets" }).getByTestId("goal-order").allTextContents();
  expect(numbers.map((n) => n.trim())).toEqual(numbers.map((_, i) => String(i + 1)));
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

test("Ranked: a key result's feature names its goal, and the key result's list finds it", async ({ page }) => {
  await open(page, "ranked");
  const row = page.getByTestId("prio-row").filter({ hasText: FEATURE });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("prio-goal")).toHaveText(/Faster activation$/);
  // The Goal map opened on the key result (as Home's "Goal map" opens it on a goal): not on the map yet, its
  // "Open the goal" leads to its list.
  await page.goto(`/simple/goals?goal=${stableUuid("simple-goal/kr-setup-day")}`);
  const off = page.getByTestId("gm-off-map");
  await expect(off).toContainText(KR1);
  await off.getByRole("link", { name: "Open the goal" }).click();
  await expect(page).toHaveURL(/\/simple\/priorities\?goal=kr-setup-day/);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  // Wait for the row lifted to its top goal (the key results loaded), so the count tests ?goal's match, not the raw rows.
  const listed = page.getByTestId("prio-row").filter({ hasText: FEATURE });
  await expect(listed.getByTestId("prio-goal")).toHaveText(/Faster activation$/);
  await expect(listed).toHaveCount(1);
});
