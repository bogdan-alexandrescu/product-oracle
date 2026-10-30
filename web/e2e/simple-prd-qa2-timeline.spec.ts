import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The PRD page's plan, second QA pass (qa-simple-prd-4 ... 47): plain words for people
 * ("16 engineer-weeks capacity, nothing planned yet", no ".0 EW", "Likelihood: Medium · Impact:
 * medium", feature names on the bars, one wording for a decision's day), the goals and their
 * standing on a phone and in a plan with no dates, decisions worded against a milestone kept
 * under it when it has no dates, the no-dates hint and its busy button, a bar or flag that
 * brings the milestone's card into view, a compact phone card whose link leads to the part,
 * "Done when" as bullets, "flow below" that leads to the flow, and goal sub-lines of 13 px.
 * Driven through the UI against the mock's "simple-plan" and "simple-plan-undated" scenarios
 * (Guided setup; M1 Prove it 2 Nov - 27 Nov, M2 Scale volume, M3 Open to all; the mock's
 * today is 22 Oct).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, scenario = "simple-plan", email: string = ADMIN.email, slow?: string) {
  await page.context().addInitScript(
    ([key, value, slowKey, slowWhat]) => {
      localStorage.setItem(key, value);
      if (slowWhat) localStorage.setItem(slowKey, slowWhat);
    },
    [MOCK_SCENARIO_KEY, scenario, MOCK_SLOW_KEY, slow ?? ""] as const,
  );
  await login(page, email);
  await page.goto("/simple");
  await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Guided setup" }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup$/);
  await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("plain words: engineer-weeks without .0, names on the bars, risks and decision days (qa-28, 7, 29)", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("one-pager-meta")).toContainText("56 engineer-weeks");
    const tl = page.getByRole("region", { name: "Timeline" });
    for (const where of [tl, page.getByTestId("milestone-part"), page.getByTestId("one-pager-meta")]) {
      await expect(where).not.toContainText(/\d\.0 EW|\bEW\b/);
      await expect(where).not.toContainText("PM-owned");
    }
    await expect(tl.getByTestId("timeline-legend")).toContainText("Product manager's work, no engineering");
    // A bar names its features, not only their codes.
    const reliability = tl.getByTestId("timeline-lane").filter({ hasText: "Reliability" }).getByTestId("timeline-bar").first();
    await expect(reliability).toContainText("Setup failure alerts");
    await expect(reliability).toHaveAttribute("title", /F-03 Setup failure alerts\nF-06 Setup error report/);
    const part = page.getByTestId("milestone-part");
    await tl.getByRole("group", { name: "Milestones" }).getByRole("button", { name: /M2 Scale volume/ }).click();
    await expect(part.getByTestId("part-dates")).toContainText("16 engineer-weeks, 1 of it buffer");
    await expect(part.getByTestId("part-risks")).toContainText("Likelihood: Medium · Impact: Medium");
    await expect(part.getByTestId("part-risks")).toContainText("Likelihood: Low · Impact: High");
    // The same day in the same words, in the timeline and in the card.
    await expect(tl.getByTestId("timeline-decision").filter({ hasText: "Q8" })).toContainText("at the M1 review, Nov 27");
    await expect(part.getByTestId("part-decisions").getByRole("listitem").filter({ hasText: "Q8" })).toContainText("at the M1 review, Nov 27");
    await expect(part).not.toContainText("M1 exit");
  });

  test("a bar or a flag brings its milestone's card into view (qa-8)", async ({ page }) => {
    await open(page, "simple-plan", ADMIN.email);
    const tl = page.getByRole("region", { name: "Timeline" });
    const part = page.getByTestId("milestone-part");
    const before = await page.evaluate(() => window.scrollY);
    await tl.locator('[data-testid="timeline-bar"][data-milestone="M2"]').first().click();
    await expect(part.getByRole("heading", { level: 2 })).toHaveText("M2 Scale volume");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
    await expect(part.getByRole("heading", { level: 2 })).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    await tl.getByRole("button", { name: "M3 ends Feb 12" }).click();
    await expect(part.getByRole("heading", { level: 2 })).toHaveText("M3 Open to all");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(part.getByRole("heading", { level: 2 })).toBeInViewport();
  });

  test("Done when is a bulleted list and 'flow below' leads to the flow (qa-26, 27)", async ({ page }) => {
    await open(page);
    const part = page.getByTestId("milestone-part");
    const items = part.getByTestId("part-done-when").getByRole("listitem");
    await expect(items.first()).toHaveText("Ten pilot teams finish setup in a day");
    // A bullet (a small round dot), not an empty checkbox square.
    const mark = await items.first().evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return { border: s.borderTopWidth, width: parseFloat(s.width) };
    });
    expect(mark.border).toBe("0px");
    expect(mark.width).toBeLessThanOrEqual(8);
    const flowBelow = part.getByRole("listitem").filter({ hasText: "F-01" }).getByRole("button", { name: "flow below" });
    await flowBelow.click();
    await expect(part.getByTestId("part-flow").filter({ hasText: "F-01 Setup checklist" })).toBeInViewport();
  });

  test("goal sub-lines are at least 13 px (qa-47)", async ({ page }) => {
    await open(page);
    const goal = page.getByTestId("timeline-goal").filter({ hasText: "Reliability" });
    await expect(goal).toContainText("Now 99.6% · on track");
    for (const small of await goal.locator("small").all()) expect(parseFloat(await small.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);
  });

  test("labels in the strip sit on the card's paper, off the lines (qa-30)", async ({ page }) => {
    await open(page);
    const tl = page.getByRole("region", { name: "Timeline" });
    const flag = tl.getByRole("button", { name: "M3 ends Feb 12" });
    await expect(flag).toBeVisible();
    expect(await flag.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    // The Today pill and the month names do not touch.
    const pill = (await tl.getByTestId("timeline-axis").getByText("Today", { exact: true }).boundingBox())!;
    for (const m of await tl.getByTestId("timeline-month").all()) {
      const b = (await m.boundingBox())!;
      expect(b.x >= pill.x + pill.width + 2 || b.x + b.width <= pill.x - 2).toBe(true);
    }
  });

  test("with no dates: goals, each milestone's targets and decisions, and the hint (qa-5, 4, 32)", async ({ page }) => {
    await open(page, "simple-plan-undated", ADMIN.email, "POST /v1/simple/prds/guided-setup/plan/read-again");
    const tl = page.getByRole("region", { name: "Timeline" });
    const goals = tl.getByTestId("timeline-goal");
    await expect(goals).toHaveCount(4);
    await expect(goals.filter({ hasText: "Growth" })).toContainText("M1 100 → M2 250 → M3 600 weekly active teams");
    const m2 = tl.getByTestId("timeline-undated-milestone").filter({ hasText: "Scale volume" });
    await expect(m2).toContainText("250 weekly active teams");
    await expect(m2).toContainText("Q8 The bulk import row limit");
    await expect(m2).toContainText("Q7 Legal input on invite emails");
    await expect(page.getByTestId("milestone-part").getByTestId("part-dates")).toContainText("16 engineer-weeks capacity, nothing planned yet");
    const note = tl.getByTestId("timeline-no-dates");
    await expect(note).toContainText("Add dates to the milestones in the PRD, then read it again.");
    await note.getByRole("button", { name: "Read the plan again" }).click();
    const busy = note.getByRole("button", { name: "Reading the plan…" });
    await expect(busy).toBeVisible();
    await expect(busy).toBeDisabled();
    await expect(note.getByRole("status")).toContainText("Read again");
    await expect(note.getByRole("button", { name: "Read the plan again" })).toBeEnabled();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("the goals and how each stands show on a phone (qa-6)", async ({ page }) => {
    await open(page);
    const goals = page.getByTestId("timeline-goal-list");
    await expect(goals).toBeVisible();
    await expect(goals.getByTestId("timeline-goal").filter({ hasText: "Growth" })).toContainText("Now 40 · behind");
    await expect(goals.getByTestId("timeline-goal").filter({ hasText: "Reliability" })).toContainText("on track");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("a milestone shows once: a compact card whose link leads to its part (qa-15, 28)", async ({ page }) => {
    await open(page);
    const tl = page.getByRole("region", { name: "Timeline" });
    const m1 = tl.getByTestId("timeline-step").first();
    await expect(m1).toContainText("to Nov 27 · 4 weeks · 16 engineer-weeks");
    await expect(m1.getByTestId("part-done-when")).toHaveCount(0);
    await expect(m1).not.toContainText("Ten pilot teams finish setup in a day");
    await expect(page.getByText("Ten pilot teams finish setup in a day")).toHaveCount(1);
    await tl.getByTestId("timeline-step").nth(1).getByRole("link", { name: /^7 features, \d flows? · 2 decisions ›$/ }).click();
    const part = page.getByTestId("milestone-part");
    await expect(part.getByRole("heading", { level: 2 })).toHaveText("M2 Scale volume");
    await expect(part.getByRole("heading", { level: 2 })).toBeInViewport();
  });

  test("with no dates, decisions sit under their milestone (qa-31, 5)", async ({ page }) => {
    await open(page, "simple-plan-undated");
    const tl = page.getByRole("region", { name: "Timeline" });
    await expect(tl.getByTestId("timeline-decision")).toHaveCount(0);
    const steps = tl.getByTestId("timeline-step");
    await expect(steps.filter({ hasText: "Prove it" })).toContainText("Q3 Which sample data to ship");
    await expect(steps.filter({ hasText: "Scale volume" })).toContainText("Q8 The bulk import row limit");
    await expect(page.getByTestId("timeline-goal-list").getByTestId("timeline-goal")).toHaveCount(4);
    await expect(tl.getByTestId("timeline-no-dates")).toContainText("Add dates to the milestones in the PRD, then read it again.");
  });
});
