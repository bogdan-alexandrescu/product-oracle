import { expect, test, type Locator, type Page } from "@playwright/test";

import { login, signOut } from "./helpers";

/**
 * Subgoals (#345), driven through the UI as a person would, on the mock layer: add a
 * subgoal under a goal, set its target and a value, link a feature to it, see the parent
 * roll up on Baseline and Plan, pick the subgoal in New PRD; move, promote and archive;
 * the tree at phone width and in both themes.
 */

const SUB = "Fewer cancellations in week one";
const SUB_KEY = "g.early-churn.fewer-cancellations-in-week-one";

const drawer = (page: Page, title: string) => page.getByRole("dialog", { name: title });

async function openBaseline(page: Page) {
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
}

/** Cut early churn (G3) confirmed, with a subgoal under it: its target "at most 5%" from 10%, valued 7% today. */
async function churnWithSubgoal(page: Page) {
  const churn = page.getByTestId("goal-g.early-churn");
  await churn.getByRole("button", { name: "Confirm" }).click();
  await expect(churn.getByRole("button", { name: "Confirm" })).toHaveCount(0);

  await churn.getByRole("button", { name: "Add subgoal" }).click();
  const add = page.getByRole("form", { name: "Add subgoal" });
  await expect(add).toContainText("Subgoal of G3 · Cut early churn");
  await add.getByLabel("Subgoal title").fill(SUB);
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId(`goal-${SUB_KEY}`);
  await expect(row).toContainText("G3.1");

  // Its own target, through the goal form.
  await row.getByRole("button", { name: SUB }).click();
  const d = drawer(page, SUB);
  await d.getByRole("button", { name: "Edit" }).click();
  const form = d.getByRole("form", { name: "Edit" });
  await form.getByLabel("Comparison").selectOption("at_most");
  await form.getByLabel("Value", { exact: true }).fill("5");
  await form.getByLabel("Unit").selectOption("%");
  await form.getByLabel("Start value").fill("10");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(row.locator('[data-attr="target"]')).toHaveText("≤ 5%");

  // A value measured today: 7% of the way from 10% to 5% is 60%.
  const section = d.getByTestId("goal-measurements");
  await section.getByRole("button", { name: "Record value" }).click();
  const rec = section.getByRole("form", { name: "Record value" });
  await rec.getByLabel("Value").fill("7");
  await rec.getByRole("button", { name: "Save" }).click();
  await expect(section.getByTestId("measurement-row")).toHaveCount(1);
  await d.getByRole("button", { name: "Close" }).click();

  await row.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  return row;
}

// protects: a person adds a subgoal under a goal, gives it its own target and value, links
// a feature to it, and sees the parent roll up from it on the Baseline and on Plan, then
// picks the subgoal under its goal in New PRD.
// fails_when: the subgoal shows as a separate top-level goal, the parent keeps "–" or
// says "own", the link cannot be made, or the picker lists the subgoal without its parent.
// no_claim: mock maths (pytest proves the API's roll-up and scoring).
test("add a subgoal, set its target, link a feature, see the parent roll up, pick it in New PRD", async ({ page }) => {
  await openBaseline(page);
  const row = await churnWithSubgoal(page);
  await expect(row.locator('[data-attr="progress"]')).toHaveText("60%own");
  const churn = page.getByTestId("goal-g.early-churn");
  await expect(churn.locator('[data-attr="progress"]')).toHaveText("60%subgoals");
  await expect(churn.locator('[data-attr="progress"]')).toHaveAttribute("data-source", "subgoals");
  // A goal with its own value says so.
  await expect(page.getByTestId("goal-g.activation").locator('[data-attr="progress"]')).toHaveText("50%own");

  // The tree folds.
  await churn.getByRole("button", { name: "Hide subgoals of G3" }).click();
  await expect(row).toHaveCount(0);
  await churn.getByRole("button", { name: "Show subgoals of G3" }).click();
  await expect(row).toBeVisible();

  // Link a feature to the subgoal.
  await page.getByRole("button", { name: "Guided setup" }).first().click();
  const f = drawer(page, "Guided setup");
  await f.getByLabel("Goal to link").selectOption({ label: `G3.1 · ${SUB}` });
  await f.getByRole("combobox", { name: "Contribution" }).selectOption("3");
  await f.getByRole("button", { name: "Link to goal" }).click();
  await expect(f.getByRole("list", { name: "Supports" })).toContainText(SUB);
  await expect(f.getByRole("list", { name: "Supports" })).toContainText("3/3");

  // Plan: the parent's card rolls up from its subgoal and lists it.
  await page.goto("/plan");
  const card = page.getByTestId("plan-goals").getByTestId("home-goal-G3");
  await expect(card.getByTestId("goal-rollup")).toHaveText("60% · from subgoals");
  await expect(card.getByTestId("home-goal-G3.1")).toContainText(SUB);
  await expect(card.getByTestId("home-goal-G3.1")).toContainText("60%");
  await expect(page.getByTestId("plan-goals").getByTestId("home-goal-G1").getByTestId("goal-subgoals")).toHaveCount(0);

  // New PRD: the subgoal sits under its goal, folds, and can be picked.
  await page.goto("/documents/new?kind=prd");
  const goals = page.getByRole("group", { name: "Which goals does it serve?" });
  await expect(goals.getByTestId("goal-pick-G3.1")).toContainText(SUB);
  await goals.getByRole("button", { name: "Hide subgoals of G3" }).click();
  await expect(goals.getByTestId("goal-pick-G3.1")).toHaveCount(0);
  await goals.getByRole("button", { name: "Show subgoals of G3" }).click();
  await goals.getByRole("checkbox", { name: new RegExp(SUB) }).check();
  await expect(goals.getByRole("checkbox", { name: new RegExp(SUB) })).toBeChecked();
});

// protects: a subgoal moves to another goal, is promoted to a goal, and is archived, from
// its inspector; a viewer sees none of these controls.
// fails_when: a move keeps the old parent, a promoted goal still sits under one, an
// archived subgoal still counts, or a viewer is offered Add subgoal.
// no_claim: the API's cycle refusals (pytest).
test("move, promote and archive a subgoal; viewers see no tree controls", async ({ page }) => {
  await openBaseline(page);
  const row = await churnWithSubgoal(page);
  await row.getByRole("button", { name: SUB }).click();
  const d = drawer(page, SUB);
  await d.getByLabel("Parent goal").selectOption({ label: "G1 · Raise activation" });
  await d.getByRole("button", { name: "Move" }).click();
  await expect(row).toContainText("G1.1");
  await expect(page.getByTestId("goal-g.early-churn").locator('[data-attr="progress"]')).toHaveText("–");

  await d.getByRole("button", { name: "Promote to goal" }).click();
  await expect(d).toContainText("Promoted to a goal.");
  await expect(row).not.toContainText("G1.1");
  await expect(d.getByRole("button", { name: "Promote to goal" })).toHaveCount(0);

  await d.getByLabel("Parent goal").selectOption({ label: "G3 · Cut early churn" });
  await d.getByRole("button", { name: "Move" }).click();
  await expect(row).toContainText("G3.1");
  await d.getByRole("button", { name: "Archive subgoal" }).click();
  await expect(page.getByTestId(`goal-${SUB_KEY}`)).toHaveCount(0);
  await expect(page.getByTestId("goal-g.early-churn").locator('[data-attr="progress"]')).toHaveText("–");

  await signOut(page);
  await login(page, "viewer@example.com");
  await page.goto("/baseline");
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add subgoal" })).toHaveCount(0);
});

/** WCAG contrast of an element's text against the first opaque background behind it. */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = rgb(getComputedStyle(node).color);
    let bg = [255, 255, 255];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

for (const scheme of ["light", "dark"] as const) {
  // protects: on a phone (390 px) the goal tree reads and folds, in light and dark.
  // fails_when: the subgoal row is cut off or missing on a phone, the fold does nothing, or
  // its text falls below 4.5:1 contrast in a theme.
  // no_claim: other widths; pixel layout.
  test(`phone tree in ${scheme}: the subgoal reads and folds`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openBaseline(page);
    const row = await churnWithSubgoal(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row).toBeVisible();
    const title = row.getByRole("button", { name: SUB });
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeInViewport();
    expect(await contrast(title)).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page.getByTestId("goal-g.early-churn").locator('[data-attr="progress"]'))).toBeGreaterThanOrEqual(4.5);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await page.getByTestId("goal-g.early-churn").getByRole("button", { name: "Hide subgoals of G3" }).click();
    await expect(row).toHaveCount(0);

    await page.goto("/plan");
    const card = page.getByTestId("plan-goals").getByTestId("home-goal-G3");
    await card.getByTestId("home-goal-G3.1").scrollIntoViewIfNeeded();
    await expect(card.getByTestId("home-goal-G3.1")).toBeInViewport();
    expect(await contrast(card.getByTestId("goal-rollup"))).toBeGreaterThanOrEqual(4.5);
  });
}
