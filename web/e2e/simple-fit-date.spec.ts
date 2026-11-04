import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Bring a date in, in Simple (the owner's picks FD1 a "On the roadmap date", FD2 a "Ranked list,
 * live date", FD3 a "Draft, check, approve"). Simple Roadmap shows the goal's target and its date
 * on today's plan; "Bring this date in" opens Oracle's ranked changes in a side panel (a sheet on a
 * phone) with a live date meter; "Draft N changes" shows what changes in the PRD and every date
 * that moves; "Approve both" makes them live, and Roadmap and Home show the new date. Driven
 * through the UI against the mock's "fit-date" and "fit-date-hard" scenarios (invented data:
 * Larkspur Help Desk's M2 Agent reply flow, target Jan 29, on today's plan Mar 12).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scenario = "fit-date", scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("fit-goal")).toBeVisible();
}

const tick = (page: Page, id: string) => page.getByTestId(`fit-change-${id}`).getByRole("checkbox");

test.describe("desktop", () => {
  test("the late goal opens Oracle's ranked changes, the live date follows the ticks, the draft is approved", async ({ page }) => {
    await open(page);
    const goal = page.getByTestId("fit-goal");
    await expect(goal).toContainText("Goal: 40 replied threads per agent per day");
    await expect(goal).toContainText("Target Jan 29");
    await expect(page.getByTestId("fit-on-plan")).toHaveText("Mar 12");
    await expect(goal).toContainText("6 weeks late");
    await expect(page.getByTestId("fit-lane-M2")).toContainText("Send check before a draft goes out");

    await page.getByRole("button", { name: "Bring this date in" }).click();
    const panel = page.getByTestId("fit-panel");
    await expect(panel).toContainText("Bring M2 Agent reply flow in");
    await expect(panel).toContainText("Target Jan 29; on today’s plan Mar 12. 4 engineers at 70% focus.");
    // The roadmap stays in view beside the side panel.
    await expect(page.getByTestId("fit-lane-M2")).toBeInViewport();

    // Oracle's own pick is ticked; the meter reaches the target in green.
    const meter = page.getByTestId("fit-meter-date");
    await expect(meter).toHaveText("Jan 25");
    await expect(meter).toHaveAttribute("data-state", "reach");
    await expect(page.getByTestId("fit-meter")).toContainText("Reaches Jan 29, 4 days to spare.");
    await expect(tick(page, "bulk")).toBeChecked();
    await expect(tick(page, "focus")).not.toBeChecked();
    // Ranked by days saved: the first change saves the most.
    await expect(page.getByTestId("fit-ranked").locator("ol > li").first()).toContainText("1. Reply to similar threads at once");
    await expect(page.getByTestId("fit-change-bulk")).toContainText("16 days sooner");
    await expect(page.getByTestId("fit-change-bulk")).toContainText("Goal at risk");

    // Unticking the biggest change misses the target: amber, with how late.
    await tick(page, "bulk").click();
    await expect(meter).toHaveText("Feb 10");
    await expect(meter).toHaveAttribute("data-state", "miss");
    await expect(page.getByTestId("fit-meter")).toContainText("12 days after Jan 29.");
    await expect(page.getByRole("button", { name: "Draft 4 changes" })).toBeVisible();
    await tick(page, "bulk").click();
    await expect(meter).toHaveText("Jan 25");

    // A must-include item shows but cannot be ticked; the locked box says what Oracle will not cut.
    await expect(tick(page, "drafts")).toBeDisabled();
    const locked = page.getByTestId("fit-locked");
    await expect(locked).toContainText("Oracle will not cut these");
    await expect(locked).toContainText("Send check before a draft goes out (3 person-weeks). Guardrail");
    await expect(locked).toContainText("Hide card numbers in drafts (2 person-weeks). Safety");
    // Drafting is the capacity queue, not a run: no made-up time or cost.
    await expect(panel).toContainText("Oracle drafts the next PRD and roadmap versions for you to check.");
    await expect(panel).not.toContainText("seconds");
    await expect(panel).not.toContainText("$0.");

    // The draft: what changes in the PRD and every date that moves, old struck through.
    await page.getByRole("button", { name: "Draft 5 changes" }).click();
    const diff = page.getByTestId("fit-diff");
    await expect(panel).toContainText("Check the new drafts");
    await expect(diff).toContainText("Reply faster in the shared inbox: version 3 → 4");
    await expect(diff).toContainText("Roadmap dates: version 6 → 7");
    const m2 = page.getByTestId("fit-diff-dates").locator("li").filter({ hasText: "M2 Agent reply flow" });
    await expect(m2.locator("del")).toHaveText("Mar 12");
    await expect(m2.locator("ins")).toHaveText("Jan 25");
    await expect(page.getByTestId("fit-needs-estimate")).toContainText("Thread summary card needs a new estimate: Tomas Brook is asked");

    // Back to the picks keeps them; drafting again returns to the check.
    await page.getByRole("button", { name: "Back to the picks" }).click();
    await expect(tick(page, "bulk")).toBeChecked();
    await page.getByRole("button", { name: "Draft 5 changes" }).click();
    await page.getByRole("button", { name: "Approve both", exact: true }).click();

    // Live: the roadmap reads the new date, the sliced item's date waits for its new estimate.
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("fit-approved")).toContainText("PRD version 4 and roadmap version 7 are live: M2 lands Jan 25.");
    await expect(page.getByTestId("fit-on-plan")).toHaveText("Jan 25");
    await expect(page.getByRole("button", { name: "Bring this date in" })).toHaveCount(0);
    const lane = page.getByTestId("fit-lane-M2");
    await expect(lane.locator("del").first()).toHaveText("Mar 12");
    await expect(lane.locator("li").filter({ hasText: "Thread summary card (first slice)" })).toContainText("Estimate pending");

    // Home shows the milestone on its date and what moved.
    await page.getByRole("navigation").getByRole("link", { name: "Home" }).click();
    const home = page.getByTestId("fit-home");
    await expect(home).toContainText("M2 Agent reply flow is on its date");
    await expect(home).toContainText("It now lands Jan 25 (was Mar 12), 4 days before Jan 29.");
    await expect(home).toContainText("Tone presets left this PRD");
  });

  test("hard case: no set reaches the target, so it says so with the best date", async ({ page }) => {
    await open(page, "fit-date-hard");
    await expect(page.getByTestId("fit-goal")).toContainText("Target Jan 8");
    await expect(page.getByTestId("fit-goal")).toContainText("9 weeks late");
    await page.getByRole("button", { name: "Bring this date in" }).click();
    const hard = page.getByTestId("fit-hard");
    await expect(hard).toContainText("No set of cuts reaches Jan 8. The earliest is Jan 16, 8 days after.");
    await expect(hard).toContainText("Cutting it would reach Jan 8; Oracle will not offer it.");
    await expect(hard).toContainText("Every change is picked. Another engineer counts only after a 3-week start, so lands too late to help. Two items stay whatever the date:");
    await expect(page.getByTestId("fit-meter-date")).toHaveAttribute("data-state", "miss");
    await expect(page.getByRole("button", { name: "Draft 7 changes and the Jan 16 target" })).toBeVisible();
    await page.getByRole("button", { name: "Draft 7 changes and the Jan 16 target" }).click();
    await expect(page.getByTestId("fit-diff")).toContainText("No set of cuts reaches Jan 8, so you approve the new target too.");
    await expect(page.getByRole("button", { name: "Approve both and the Jan 16 target" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the answer opens as a sheet and the live date follows a tick", async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "fit-date"] as const);
    await login(page);
    await page.goto("/simple/roadmap");
    await page.getByRole("button", { name: "Bring this date in" }).click();
    const panel = page.getByTestId("fit-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await expect(page.getByTestId("fit-meter-date")).toHaveText("Jan 25");
    await tick(page, "focus").click();
    await expect(page.getByTestId("fit-meter-date")).toHaveText("Jan 19");
    await expect(page.getByRole("button", { name: "Draft 6 changes" })).toBeVisible();
  });
});
