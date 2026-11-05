import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import plan from "../lib/api/mock/fit-date-plan.json";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Bring a date in, the hard case: no set of cuts reaches Jan 8, so "Keep Jan 8 with a smaller goal",
 * under the Draft button in the panel's footer (fd2-a-hard-1512), opens the Baseline goal the M2
 * gate counts toward in a sheet over the panel (a bottom sheet on a phone), the owner's pick
 * "Target and due only": one target value with its comparison and counted noun read as text, and
 * Due opening on the goal's own due date, month first. Saving the lower target reloads the answer,
 * which says the date now reaches Jan 8. A viewer sees no button; with no Baseline goal by the
 * goal's name the panel says so. Only the goal's own unlocked work shrinks, never the must-include
 * item. Mock scenarios "fit-date-hard" and "fit-date-hard-no-goal"
 * (invented data: Larkspur Help Desk's M2 Agent reply flow, the goal 40 replied threads per agent).
 */

/** "Jan 15" from "2027-01-15", as the panel reads a day. */
const words = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sooner = (days: number) => `${days} ${days === 1 ? "day" : "days"} sooner`;

/** The ranked rows, their days and the live date are the API engine's on the mock's plan
 * (web/lib/api/mock/fit-date-plan.json, pinned by api/tests/test_simple_fit_date_mock_plan.py). */
async function readsTheEngine(page: Page, scenarioAt: keyof typeof plan.expect) {
  const want = plan.expect[scenarioAt];
  const rows = page.getByTestId("fit-ranked").locator('[data-testid^="fit-change-"]:not([data-testid="fit-change-lock"])');
  await expect(rows).toHaveCount(want.changes.length);
  expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")))).toEqual(want.changes.map(([id]) => `fit-change-${id}`));
  for (const [id, days] of want.changes) await expect(page.getByTestId(`fit-change-${id}`)).toContainText(sooner(days as number));
  await expect(page.getByTestId("fit-meter-date")).toHaveText(words(want.pick_date));
}

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
  await expect(sheet).toContainText("The PRD asks for at least 40 threads.");
  // Target and due only: one value to type; the comparison and the counted noun are words, not
  // controls (no Comparison or Unit select, no Counted noun field).
  const value = sheet.getByLabel("Target", { exact: true });
  await expect(value).toBeFocused();
  await expect(value).toHaveValue("40");
  await expect(sheet.getByTestId("fit-goal-target")).toHaveText(/^At least\s*threads$/);
  await expect(sheet.locator("select")).toHaveCount(0);
  await expect(sheet.locator('input:not([type="date"])')).toHaveCount(1);
  await expect(sheet.getByLabel("Counted noun")).toHaveCount(0);
  // Due opens on the goal's own due date, read month first.
  await expect(sheet.getByTestId("fit-goal-due")).toHaveText("Mar 31, 2027");
  await expect(sheet.getByLabel("Due")).toHaveValue("2027-03-31");
  await value.fill("25");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  const smaller = page.getByTestId("fit-smaller");
  await expect(smaller).toContainText("Counted against the smaller goal: At least 25 threads (the PRD asks for at least 40 threads).");
  await expect(smaller).toContainText("M2 Agent reply flow now reaches Jan 8.");
  await expect(page.getByTestId("fit-meter-date")).toHaveAttribute("data-state", "reach");
  await expect(page.getByTestId("fit-meter")).toContainText("Reaches Jan 8");
  await expect(page.getByTestId("fit-hard")).toBeHidden();
  await expect(page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" })).toBeHidden();
  // Only the goal's own unlocked work shrinks: moving the bulk reply (a quarter of its size now) saves
  // 2 days, while the must-include Reply drafts in the inbox keeps its full size and stays locked; the
  // days are the API engine's on the same plan (fit-date-plan.json).
  await expect(page.getByTestId("fit-change-bulk")).toContainText("2 days sooner");
  await expect(page.getByTestId("fit-change-drafts")).toContainText("14 days sooner");
  await expect(page.getByTestId("fit-change-drafts").getByRole("checkbox")).toBeDisabled();
  await expect(page.getByTestId("fit-change-tone")).toContainText("7 days sooner");
}

test.describe("desktop", () => {
  test("hard case: keep Jan 8 with a smaller goal, lower the target, and the answer reaches the date", async ({ page }) => {
    await openHard(page);
    // The button sits in the panel's footer under the Draft button (fd2-a-hard-1512), not in a box
    // of its own in the list.
    await expect(page.getByTestId("fit-keep-date")).toHaveCount(0);
    const actions = page.getByTestId("fit-pick-actions");
    const draft = actions.getByRole("button", { name: "Draft 7 changes and the Jan 15 target" });
    const keep = actions.getByRole("button", { name: "Keep Jan 8 with a smaller goal" });
    await expect(keep).toBeInViewport();
    const d = (await draft.boundingBox())!;
    const k = (await keep.boundingBox())!;
    expect(k.y).toBeGreaterThanOrEqual(d.y + d.height);
    expect(Math.abs(k.x - d.x)).toBeLessThanOrEqual(1);
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

  test("a new due date is saved from the sheet, read month first", async ({ page }) => {
    await openHard(page);
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    const sheet = page.getByTestId("fit-goal-sheet");
    await expect(sheet.getByTestId("fit-goal-due")).toHaveText("Mar 31, 2027");
    await sheet.getByLabel("Due").fill("2027-02-26");
    await expect(sheet.getByTestId("fit-goal-due")).toHaveText("Feb 26, 2027");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    // Opened again, the goal reads its new due date.
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    await expect(page.getByTestId("fit-goal-sheet").getByTestId("fit-goal-due")).toHaveText("Feb 26, 2027");
  });

  test("a viewer sees the smaller-goal option without a button", async ({ page }) => {
    await openHard(page, "fit-date-hard", "viewer@example.com");
    await expect(page.getByTestId("fit-keep-date")).toContainText("Or keep Jan 8 and ask for less: the goal is at least 40 threads. Only an owner or approver can change it.");
    await expect(page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" })).toHaveCount(0);
  });

  test("no Baseline goal by the goal's name: the panel says so and shows no button", async ({ page }) => {
    await openHard(page, "fit-date-hard-no-goal");
    await expect(page.getByTestId("fit-keep-date")).toContainText(
      "Oracle finds no Baseline goal named “40 replied threads per agent per day”, so it cannot offer to keep Jan 8 with a smaller goal.",
    );
    await expect(page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" })).toHaveCount(0);
  });

  test("a smaller goal's person-weeks are rounded to a tenth, as the API rounds them", async ({ page }) => {
    // At 25 the goal's own work counts at a quarter: the bulk reply's 5 person-weeks are 1.25, read
    // 1.2 as the API's round(…, 1) reads it (ties to even), and the summary card's 8 are 2, sliced to 1.
    await openHard(page);
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    const sheet = page.getByTestId("fit-goal-sheet");
    await sheet.getByLabel("Target", { exact: true }).fill("25");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("fit-smaller")).toContainText("Counted against the smaller goal: At least 25 threads");
    await expect(page.getByTestId("fit-change-bulk")).toContainText("Saves 1.2 person-weeks.");
    await expect(page.getByTestId("fit-change-summary")).toContainText("2 person-weeks down to 1. Saves 1 person-week.");
  });

  test("each row's days, the ranking and the live date are the API engine's, at 40 and at 25", async ({ page }) => {
    // The slice saves 4 of the summary card's 8 person-weeks: 10 days, below the bulk reply's 13
    // (5 person-weeks); at 25 both save 2 days and the slice, the smaller harm, ranks first.
    await openHard(page);
    await readsTheEngine(page, "fit-date-hard@40");
    await expect(page.getByTestId("fit-change-summary")).toContainText("10 days sooner");
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    const sheet = page.getByTestId("fit-goal-sheet");
    await sheet.getByLabel("Target", { exact: true }).fill("25");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("fit-smaller")).toContainText("Counted against the smaller goal: At least 25 threads");
    await readsTheEngine(page, "fit-date-hard@25");
    await expect(page.getByTestId("fit-change-summary")).toContainText("2 days sooner");
  });

  test("at 21 the slice saves one day, read singular, as the API engine measures it", async ({ page }) => {
    await openHard(page);
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    const sheet = page.getByTestId("fit-goal-sheet");
    await sheet.getByLabel("Target", { exact: true }).fill("21");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    await readsTheEngine(page, "fit-date-hard@21");
    await expect(page.getByTestId("fit-change-summary")).toContainText("1 day sooner");
  });

  test("the default case reads the API engine's rows and date, and one person-week or one day reads singular", async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "fit-date"] as const);
    await login(page);
    await page.goto("/simple/roadmap");
    await page.getByRole("button", { name: "Bring this date in" }).click();
    await readsTheEngine(page, "fit-date@40");
    // The split saves 1 person-week; with it alone ticked the meter reads it singular.
    const ticked = page.getByTestId("fit-ranked").getByRole("checkbox", { checked: true });
    while ((await ticked.count()) > 0) await ticked.first().click();
    await page.getByTestId("fit-change-snippets").getByRole("checkbox").click();
    await expect(page.getByTestId("fit-meter")).toContainText("1 person-week off the milestone, 1 change picked.");
    await expect(page.getByTestId("fit-change-snippets")).toContainText("Saves 1 person-week.");
    // The draft's PRD line names the sliced item only, in the API's words, not its sizes.
    await page.getByTestId("fit-change-summary").getByRole("checkbox").click();
    await page.getByTestId("fit-draft").click();
    const diff = page.getByTestId("fit-diff");
    await expect(diff).toContainText("Thread summary card: First slice only in this milestone");
    await expect(diff).not.toContainText("person-weeks");
  });

  for (const [target, row] of [
    ["27", "2.8 person-weeks down to 1.5."],
    ["33", "5.2 person-weeks down to 3."],
  ] as const) {
    test(`at ${target} the slice shrinks the smaller item, as the API slices it`, async ({ page }) => {
      // The API's slice lever ships half the item's whole weeks (ceil(pw) / 2) and saves the rest:
      // the summary card's 8 person-weeks slice to 4; a smaller goal shrinks the card first, then slices it.
      // What it saves, the rows, their days and the live date are the API engine's (plan.expect).
      const want = plan.expect[`fit-date-hard@${target}`];
      const saved = want.changes.find(([id]) => id === "summary")![2] as number;
      await openHard(page);
      await expect(page.getByTestId("fit-change-summary")).toContainText("8 person-weeks down to 4. Saves 4 person-weeks.");
      await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
      const sheet = page.getByTestId("fit-goal-sheet");
      await sheet.getByLabel("Target", { exact: true }).fill(target);
      await sheet.getByRole("button", { name: "Save" }).click();
      await expect(sheet).toBeHidden();
      await expect(page.getByTestId("fit-smaller")).toContainText(`Counted against the smaller goal: At least ${target} threads`);
      await readsTheEngine(page, `fit-date-hard@${target}`);
      const summary = page.getByTestId("fit-change-summary");
      await expect(summary).toContainText(`${row} Saves ${saved} person-weeks.`);
      // The live total with the slice alone ticked.
      const ticked = page.getByTestId("fit-ranked").getByRole("checkbox", { checked: true });
      while ((await ticked.count()) > 0) await ticked.first().click();
      await expect(page.getByTestId("fit-meter")).toContainText("0 person-weeks off the milestone, 0 changes picked.");
      await summary.getByRole("checkbox").click();
      await expect(page.getByTestId("fit-meter")).toContainText(`${saved} person-weeks off the milestone, 1 change picked.`);
    });
  }

  test("at 30 the rows, their days and the live date are the API engine's", async ({ page }) => {
    await openHard(page);
    await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
    const sheet = page.getByTestId("fit-goal-sheet");
    await sheet.getByLabel("Target", { exact: true }).fill("30");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("fit-smaller")).toContainText("Counted against the smaller goal: At least 30 threads");
    await readsTheEngine(page, "fit-date-hard@30");
  });
});

/** Nothing in the open sheet reaches past the screen's right edge, and nothing scrolls sideways. */
async function fitsTheWidth(page: Page, width: number) {
  const sheet = page.getByTestId("fit-goal-sheet");
  await expect(sheet.getByLabel("Target", { exact: true })).toBeVisible();
  const over = await page.evaluate((w) => {
    const dialog = document.querySelector('[data-testid="fit-goal-sheet"] [role="dialog"]')!;
    const wide = [dialog, ...dialog.querySelectorAll("*")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > w + 0.5 || r.left < -0.5);
    });
    const scrolls = [document.scrollingElement!, dialog, ...dialog.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden");
    return { wide: wide.map((el) => el.outerHTML.slice(0, 80)), scrolls: scrolls.map((el) => el.outerHTML.slice(0, 80)) };
  }, width);
  expect(over).toEqual({ wide: [], scrolls: [] });
}

for (const width of [390, 393]) {
  test.describe(`${width} wide`, () => {
    test.use({ ...PHONE, viewport: { width, height: 844 } });

    test("the smaller-goal sheet fits with no sideways scroll", async ({ page }) => {
      await openHard(page);
      await page.getByRole("button", { name: "Keep Jan 8 with a smaller goal" }).click();
      await fitsTheWidth(page, width);
    });
  });
}

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
