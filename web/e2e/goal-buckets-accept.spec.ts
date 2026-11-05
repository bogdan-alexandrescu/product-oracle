import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal buckets, fix round 3 (PR 1224). Card tasks-accept-move: protects = a commenter's move of a
 * planned task to another goal (proposed, the task stays put) shows on Home as "Move to another
 * goal"; once the owner accepts it there, the task shows in the new goal in the dated Goal
 * buckets, for the owner and for the commenter who proposed it, with the goals' feature counts
 * following; fails_when = the accepted move leaves the task under its old goal. The mock's
 * "simple-plan" (dated): goals Reliability, Growth, Activation and Revenue. Invented data.
 */

async function open(page: Page, who: string) {
  await login(page, who);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
  await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
}

const count = (page: Page, goal: string) => bucket(page, goal).getByText(/^\d+ features? in the plan$/);
const bucket = (page: Page, goal: string) => page.locator('[data-testid="plan-goal"]').filter({ has: page.getByRole("heading", { name: goal, exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, "simple-plan", THEME_KEY] as const,
  );
});

test("a commenter's proposed move, once accepted, moves the task in the dated goal buckets", async ({ page }) => {
  await open(page, "commenter@example.com");
  const growthCount = await count(page, "Growth").textContent();
  const grip = bucket(page, "Reliability").locator('[data-code="F-03"]').getByTestId("feature-grip");
  await grip.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("bucket-live")).toHaveText("Over goal 2, Growth. Enter drops it there.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bucket-note")).toContainText("Proposed moving Setup failure alerts to Growth: it waits for a decision.");
  await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toHaveCount(0);
  await page.goto("/home");
  await signOut(page);

  // The owner decides it on Simple's Home.
  await login(page, ADMIN.email);
  await page.goto("/simple");
  const proposal = page.getByTestId("home-proposal").filter({ hasText: "Move to another goal: Setup failure alerts" });
  await expect(proposal).toBeVisible();
  await proposal.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("home-proposal").filter({ hasText: "Setup failure alerts" })).toHaveCount(0);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toBeVisible();
  await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toHaveCount(0);
  await page.goto("/home");
  await signOut(page);

  // The commenter who proposed it sees the move land.
  await login(page, "commenter@example.com");
  await page.goto("/simple/priorities?tab=buckets");
  await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toBeVisible();
  await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toHaveCount(0);
  expect(growthCount).toMatch(/features? in the plan/);
  await expect(count(page, "Growth")).toHaveText(`${Number(growthCount!.split(" ")[0]) + 1} features in the plan`);
});
