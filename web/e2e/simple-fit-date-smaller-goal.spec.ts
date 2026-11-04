import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Bring a date in, the hard case: no set of cuts reaches Jan 8, so "Keep Jan 8 with a smaller goal"
 * opens the Baseline goal the M2 gate counts toward (its target and due date, the target focused)
 * in a sheet over the panel (a bottom sheet on a phone). Saving the lower target reloads the answer,
 * which says the date now reaches Jan 8. A viewer sees no button; with no Baseline goal by the
 * goal's name the panel says so. Mock scenarios "fit-date-hard" and "fit-date-hard-no-goal"
 * (invented data: Larkspur Help Desk's M2 Agent reply flow, the goal 40 replied threads per agent).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function openHard(page: Page, scenario = "fit-date-hard", email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto("/simple/roadmap");
  await page.getByRole("button", { name: "Bring this date in" }).click();
  await expect(page.getByTestId("fit-hard")).toContainText("No set of cuts reaches Jan 8.");
}

async function lowerTheGoal(page: Page) {
  await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
  const sheet = page.getByTestId("fit-goal-sheet");
  await expect(sheet.getByRole("dialog", { name: "Goal: 40 replied threads per agent per day" })).toBeVisible();
  await expect(sheet).toContainText("The PRD asks for At least 40 threads.");
  const value = sheet.getByLabel("Value");
  await expect(value).toBeFocused();
  await expect(value).toHaveValue("40");
  await expect(sheet.getByLabel("Due")).toBeVisible();
  await value.fill("30");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  const smaller = page.getByTestId("fit-smaller");
  await expect(smaller).toContainText("Counted against the smaller goal: At least 30 threads (the PRD asks for At least 40 threads).");
  await expect(smaller).toContainText("M2 Agent reply flow now reaches Jan 8.");
  await expect(page.getByTestId("fit-meter-date")).toHaveAttribute("data-state", "reach");
  await expect(page.getByTestId("fit-meter")).toContainText("Reaches Jan 8");
  await expect(page.getByTestId("fit-hard")).toBeHidden();
  await expect(page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" })).toBeHidden();
}

test.describe("desktop", () => {
  test("hard case: keep Jan 8 with a smaller goal, lower the target, and the answer reaches the date", async ({ page }) => {
    await openHard(page);
    await expect(page.getByTestId("fit-keep-date")).toContainText("Or keep Jan 8 and ask for less: the goal is At least 40 threads.");
    // Esc closes the goal's sheet and leaves the panel open.
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    await expect(page.getByTestId("fit-goal-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("fit-goal-sheet")).toBeHidden();
    await expect(page.getByTestId("fit-panel")).toBeVisible();
    // Cancel changes nothing.
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    await page.getByTestId("fit-goal-sheet").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("fit-goal-sheet")).toBeHidden();
    await expect(page.getByTestId("fit-meter-date")).toHaveAttribute("data-state", "miss");
    await lowerTheGoal(page);
    await expect(page.getByRole("button", { name: "Draft 7 changes" })).toBeVisible();
  });

  test("a viewer sees the smaller-goal option without a button", async ({ page }) => {
    await openHard(page, "fit-date-hard", "viewer@example.com");
    await expect(page.getByTestId("fit-keep-date")).toContainText("Only an owner or approver can change it.");
    await expect(page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" })).toHaveCount(0);
  });

  test("no Baseline goal by the goal's name: the panel says so and shows no button", async ({ page }) => {
    await openHard(page, "fit-date-hard-no-goal");
    await expect(page.getByTestId("fit-keep-date")).toContainText(
      "Oracle finds no Baseline goal named “40 replied threads per agent per day”, so it cannot offer to keep Jan 8 with a smaller goal.",
    );
    await expect(page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" })).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the goal opens as a bottom sheet; lowering it reaches the date", async ({ page }) => {
    await openHard(page);
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    const sheet = page.getByTestId("fit-goal-sheet");
    await expect(sheet.getByTestId("sheet-handle")).toBeVisible();
    const box = await sheet.getByRole("dialog").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(844 - 2);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await lowerTheGoal(page);
  });
});
