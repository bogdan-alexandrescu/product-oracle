import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 2 on /baseline and the impact page (qa-plan-2, 8, 9, 23-28, 52; qa-onboarding-25-27,
 * 38), through the UI on the mock layer. Each test's card: protects=<the observable>;
 * fails_when=<the wrong result>; no_claim=<what green does not prove>.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openBaseline(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
}

const goalsTable = (page: Page) => page.getByRole("grid", { name: "Goals" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Build the baseline" });

/** True when the element cuts its own content off (sideways or downwards). */
const clipped = (el: Locator) =>
  el.evaluate((e) => {
    const cs = getComputedStyle(e);
    const x = cs.overflowX !== "visible" && e.scrollWidth > e.clientWidth + 1;
    const y = cs.overflowY !== "visible" && e.scrollHeight > e.clientHeight + 1;
    return x || y;
  });

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  // protects=qa-plan-2: Progress says what it is measured from, so it squares with Plan's 38%
  // against 45%; fails_when=it reads "50% of target"; no_claim=the roll-up maths (pytest).
  test("progress says it is measured from the goal's start", async ({ page }) => {
    await openBaseline(page);
    const progress = page.getByTestId("goal-g.activation").locator('[data-attr="progress"]');
    await expect(progress).toHaveText("50% of the way from 31%");
    await expect(progress).toHaveAttribute("title", /31% \(start\) to ≥ 45%; 38% now/);
  });

  // protects=qa-plan-8: a goal with no evidence shows no confidence score, in the table and its
  // drawer; fails_when=a 78 ring beside Evidence 0; no_claim=the API's scoring (pytest).
  test("a goal with no evidence shows no confidence score", async ({ page }) => {
    await openBaseline(page);
    const row = goalsTable(page).getByTestId("goal-g.activation");
    await expect(row.getByRole("img", { name: "Not scored: no evidence yet" })).toBeVisible();
    await expect(row.getByRole("img", { name: /Confidence 78/ })).toHaveCount(0);
    await row.getByRole("button", { name: "Raise activation", exact: true }).click();
    const d = page.getByRole("dialog", { name: "Raise activation" });
    await expect(d.getByRole("img", { name: "Not scored: no evidence yet" })).toBeVisible();
  });

  // protects=qa-plan-9: a goal with metric and target that only lacks an owner says "No owner";
  // fails_when=it is called Not measurable; no_claim=the API's goal check.
  test("an owner-only gap reads 'No owner', not 'Not measurable'", async ({ page }) => {
    await openBaseline(page);
    const paid = goalsTable(page).getByTestId("goal-g.paid-conversion");
    await expect(paid.getByTestId("not-measurable")).toHaveText("No owner");
    await expect(paid).not.toContainText("Not measurable");
    await expect(paid.getByRole("button", { name: "Name an owner" })).toBeVisible();
    // A goal missing more stays Not measurable.
    await expect(goalsTable(page).getByTestId("goal-g.early-churn").getByTestId("not-measurable")).toHaveText("Not measurable");
  });

  // protects=qa-plan-23: the horizon is whole; fails_when="Medium · Jun …"; no_claim=other widths.
  test("the horizon reads whole: 'Medium · Jun 30'", async ({ page }) => {
    await openBaseline(page);
    const h = goalsTable(page).getByTestId("goal-g.paid-conversion").locator('[data-attr="horizon"]');
    await expect(h).toHaveText("Medium · Jun 30");
    expect(await clipped(h)).toBe(false);
    expect(await clipped(h.locator("xpath=.."))).toBe(false);
  });

  // protects=qa-plan-24 and qa-plan-28: targets in one form ("< 8%", not "below 8%") in the
  // Goals table and the Feature × goal targets row; the ledger header is one compact line;
  // fails_when=words beside symbols, or a three-line header; no_claim=Plan's cards.
  test("targets in one form; the Feature × goal header is compact with a targets row", async ({ page }) => {
    await openBaseline(page);
    await expect(goalsTable(page).getByTestId("goal-g.early-churn").locator('[data-attr="target"]')).toHaveText("< 8%");
    const ledger = page.getByRole("table", { name: "Feature × goal" });
    await expect(ledger.getByTestId("ledger-target")).toHaveText(["≥ 45%", "≥ 12%", "< 8%"]);
    await expect(ledger).not.toContainText("below 8%");
    const head = ledger.getByRole("columnheader", { name: "Feature", exact: true });
    expect((await head.boundingBox())!.height).toBeLessThanOrEqual(40);
  });

  // protects=qa-onboarding-27: the build's cost says what it is against the approval line and
  // what happens next; fails_when="Estimate $7.00" alone; no_claim=costs over the line.
  test("the build sheet's estimate names the approval line", async ({ page }) => {
    await login(page);
    await page.goto("/baseline?build=1");
    await expect(sheet(page).getByTestId("build-estimate")).toHaveText("$7.00 estimated · below the $50 approval line · starts at once");
  });

  // protects=qa-onboarding-25 and qa-onboarding-26: a first build on an empty company shows one
  // line about it, no blocker count, and no goals header band over nothing; fails_when=two
  // banners say the same, Blockers 1, or a Goals table with a short header; no_claim=a company
  // with goals (the header there spans its columns).
  test("empty company: one build banner, no blockers, no half-drawn Goals table", async ({ page }) => {
    await scenario(page, "empty");
    await login(page);
    await page.goto("/baseline?build=1");
    await sheet(page).getByRole("button", { name: "Start" }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId("baseline-build-banner")).toContainText("Baseline being built");
    await expect(page.getByTestId("baseline-build-banner")).toContainText("You'll get an Inbox item when it's ready to review.");
    await expect(page.getByText(/^Building the baseline\./)).toHaveCount(0);
    await expect(page.getByTestId("tab-count-blockers")).toHaveText("0");
    const goals = page.getByRole("region", { name: "Goals", exact: true });
    await expect(goals).toContainText("No goals yet");
    await expect(goals.getByRole("columnheader")).toHaveCount(0);
  });

  // protects=qa-onboarding-38: with the Company in Berlin a build's start time names the zone as
  // Settings does (CET/CEST), not "GMT+1"; fails_when=an offset name; no_claim=zones outside Europe.
  test("Berlin: the build banner's time says CET, not GMT+1", async ({ page }) => {
    await login(page);
    await page.goto("/settings/company");
    await page.getByLabel("Company time zone").selectOption("Europe/Berlin");
    await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
    await page.goto("/baseline?build=1");
    await sheet(page).getByRole("button", { name: "Start" }).click();
    const banner = page.getByTestId("baseline-build-banner");
    await expect(banner).toContainText(/started .* (AM|PM) CES?T/);
    await expect(banner).not.toContainText(/GMT[+-]/);
  });

  // protects=qa-plan-52 (with qa-docs-25): a what-if says it is a preview in words, under the
  // title; fails_when=a bare "Preview" badge; no_claim=recorded changes.
  test("impact what-if: the page says it is a preview in words, with no bare badge", async ({ page }) => {
    await scenario(page, "impact");
    await openBaseline(page);
    await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
    await page.getByRole("dialog", { name: "Guided setup" }).getByRole("link", { name: "What if it changed?" }).click();
    await expect(page).toHaveURL(/\/impact\/entities\/[^/]+$/);
    await expect(page.getByText(/Preview only; nothing is marked stale\./)).toBeVisible();
    await expect(page.getByTestId("impact-mode")).toHaveCount(0);
    const header = page.locator("header[data-page-header]").filter({ visible: true });
    await expect(header.getByText("Preview", { exact: true })).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  // protects=qa-plan-25: every Baseline tab is whole on screen (they wrap); fails_when=a tab is
  // cut or behind a scroll arrow; no_claim=Plan's tabs.
  test("the tabs wrap: every tab is whole on screen", async ({ page }) => {
    await openBaseline(page);
    const tabs = page.getByRole("tablist", { name: "Baseline views" }).getByRole("tab");
    await expect(tabs).toHaveCount(6);
    for (const tab of await tabs.all()) {
      const box = (await tab.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
      expect(await clipped(tab)).toBe(false);
    }
    await expect(page.getByRole("button", { name: /^Scroll/ })).toHaveCount(0);
  });

  // protects=qa-plan-26: a goal row reads title and badges, then target and progress, then its
  // actions in one row; fails_when=the badge sits under the gap chip or the buttons float
  // beside the title; no_claim=other tables.
  test("a goal row: title and badges, then target and progress, then actions", async ({ page }) => {
    await openBaseline(page);
    const churn = page.getByTestId("goal-g.early-churn");
    const title = churn.getByRole("button", { name: "Cut early churn", exact: true });
    const badge = churn.getByText("Proposed", { exact: true }).filter({ visible: true });
    const gap = churn.getByTestId("phone-gap");
    const target = churn.locator('[data-attr="target"]');
    const make = churn.getByTestId("make-measurable");
    const confirm = churn.getByRole("button", { name: "Confirm" });
    const add = churn.getByRole("button", { name: "Add subgoal" });
    for (const l of [title, badge, gap, target, make, confirm, add]) await expect(l).toBeVisible();
    const box = async (l: Locator) => (await l.boundingBox())!;
    const [t, b, g, tg, m, c, a] = await Promise.all([title, badge, gap, target, make, confirm, add].map(box));
    // Badges beside or right under the title, above the target line.
    expect(b.y + b.height).toBeLessThanOrEqual(tg.y);
    expect(g.y + g.height).toBeLessThanOrEqual(tg.y);
    expect(t.y).toBeLessThan(tg.y);
    // Actions after the target, in one row.
    for (const x of [m, c, a]) expect(x.y).toBeGreaterThanOrEqual(tg.y + tg.height);
    expect(Math.abs(m.y - c.y)).toBeLessThan(4);
    expect(Math.abs(c.y - a.y)).toBeLessThan(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  // protects=qa-plan-27: the Weak evidence label and its (i) are whole; fails_when=the label's
  // box clips them; no_claim=other KPI strips.
  test("the Weak evidence label is not clipped", async ({ page }) => {
    await openBaseline(page);
    const label = page.getByTestId("kpi-weak").locator("dt");
    await expect(label).toContainText("Weak evidence");
    expect(await clipped(label)).toBe(false);
    const tip = label.getByRole("button");
    const [l, i] = [(await label.boundingBox())!, (await tip.boundingBox())!];
    expect(i.y + i.height).toBeLessThanOrEqual(l.y + l.height + 1);
  });
});
