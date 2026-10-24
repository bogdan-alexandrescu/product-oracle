import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
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
  await expect(add).toContainText("Subgoal of Cut early churn");
  await add.getByLabel("Subgoal title").fill(SUB);
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId(`goal-${SUB_KEY}`);
  await expect(row).toBeVisible();
  // A company without goal codes (#304): neither the goal nor its subgoal draws one.
  await expect(row.getByTestId("code-tag")).toHaveCount(0);
  await expect(row).not.toContainText("G3.1");
  await expect(churn.getByTestId("code-tag")).toHaveCount(0);

  // Its own target, through the goal form.
  await row.getByRole("button", { name: SUB, exact: true }).click();
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
  await churn.getByRole("button", { name: "Hide subgoals of Cut early churn" }).click();
  await expect(row).toHaveCount(0);
  await churn.getByRole("button", { name: "Show subgoals of Cut early churn" }).click();
  await expect(row).toBeVisible();

  // Link a feature to the subgoal.
  await page.getByRole("button", { name: "Guided setup" }).first().click();
  const f = drawer(page, "Guided setup");
  await f.getByRole("button", { name: "Link to goal" }).click();
  const link = f.getByRole("form", { name: "Link to goal" });
  await link.getByLabel("Goal").selectOption({ label: SUB });
  await link.getByLabel("Contribution").selectOption("3");
  await link.getByRole("button", { name: "Link" }).click();
  await expect(f.getByRole("list", { name: "Supports" })).toContainText(SUB);
  await expect(f.getByLabel(`Contribution to ${SUB}`)).toHaveValue("3");

  // Plan: the parent's card rolls up from its subgoal and lists it.
  await page.goto("/plan");
  const card = page.getByTestId("plan-goals").getByTestId("home-goal-G3");
  await expect(card.getByTestId("goal-rollup")).toHaveText("60% · from subgoals");
  await expect(card.getByTestId("home-goal-G3.1")).toContainText(SUB);
  await expect(card.getByTestId("home-goal-G3.1")).toContainText("60%");
  await expect(card.getByTestId("home-goal-G3.1").getByTestId("code-tag")).toHaveCount(0);
  await expect(page.getByTestId("plan-goals").getByTestId("home-goal-G1").getByTestId("goal-subgoals")).toHaveCount(0);

  // New PRD: the subgoal sits under its goal, folds, and can be picked.
  await page.goto("/documents/new?kind=prd");
  const goals = page.getByRole("group", { name: "Which goals does it serve?" });
  await expect(goals.getByTestId("goal-pick-G3.1")).toContainText(SUB);
  await expect(goals.getByTestId("goal-pick-G3.1").getByTestId("code-tag")).toHaveCount(0);
  await goals.getByRole("button", { name: "Hide subgoals of Cut early churn" }).click();
  await expect(goals.getByTestId("goal-pick-G3.1")).toHaveCount(0);
  await goals.getByRole("button", { name: "Show subgoals of Cut early churn" }).click();
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
  await row.getByRole("button", { name: SUB, exact: true }).click();
  const d = drawer(page, SUB);
  await d.getByLabel("Parent goal").selectOption({ label: "Raise activation" });
  await d.getByRole("button", { name: "Move" }).click();
  const underActivation = page.getByTestId("goal-g.activation").getByRole("button", { name: "Hide subgoals of Raise activation" });
  await expect(underActivation).toBeVisible();
  await expect(row.getByTestId("code-tag")).toHaveCount(0);
  await expect(page.getByTestId("goal-g.early-churn").locator('[data-attr="progress"]')).toHaveText("–");

  await d.getByRole("button", { name: "Promote to goal" }).click();
  await expect(d).toContainText("Promoted to a goal.");
  await expect(underActivation).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Promote to goal" })).toHaveCount(0);

  await d.getByLabel("Parent goal").selectOption({ label: "Cut early churn" });
  await d.getByRole("button", { name: "Move" }).click();
  await expect(page.getByTestId("goal-g.early-churn").getByRole("button", { name: "Hide subgoals of Cut early churn" })).toBeVisible();
  await expect(row.getByTestId("code-tag")).toHaveCount(0);
  // Archiving asks why, as any archive does; the parent then no longer counts it.
  await d.getByRole("button", { name: "Archive subgoal" }).click();
  const ask = d.getByRole("form", { name: "Archive" });
  await ask.getByLabel("Reason").fill("Folded into the activation work.");
  await ask.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId(`goal-${SUB_KEY}`)).toHaveCount(0);
  await expect(page.getByTestId("goal-g.early-churn").locator('[data-attr="progress"]')).toHaveText("–");

  await signOut(page);
  await login(page, "viewer@example.com");
  await page.goto("/baseline");
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add subgoal" })).toHaveCount(0);
});

// protects: in a company that writes its own goal codes (#304, "G-B Growth"), a subgoal's
// code is its parent's plus its place, in that style (G-B.1), and its chip shows code and
// name on the Baseline, on Plan and in its card.
// fails_when: the subgoal shows a place code (G2.1), no code, or a slug; or the chip drops its name.
// no_claim: codes inside agent-written text.
test("in the company's code style a subgoal is G-B.1, its chip showing code and name", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "named-codes"), MOCK_SCENARIO_KEY);
  await openBaseline(page);
  const growth = page.getByTestId("goal-g.paid-conversion");
  await growth.getByRole("button", { name: "Add subgoal" }).click();
  const add = page.getByRole("form", { name: "Add subgoal" });
  await expect(add).toContainText("Subgoal of G-B Growth");
  await add.getByLabel("Subgoal title").fill("Win back lapsed teams");
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId("goal-g.paid-conversion.win-back-lapsed-teams");
  await expect(row.getByTestId("code-tag")).toHaveText("G-B.1");
  await expect(row.getByRole("button", { name: "Win back lapsed teams", exact: true })).toBeVisible();
  await expect(row).not.toContainText("G2.1");
  // Its inspector's header names it by the same code as its chip.
  await row.getByRole("button", { name: "Win back lapsed teams", exact: true }).click();
  const d = drawer(page, "Win back lapsed teams");
  await expect(d.getByTestId("drawer-code")).toHaveText("G-B.1");
  await d.getByRole("button", { name: "Close" }).click();

  await page.goto("/plan");
  const sub = page.getByTestId("plan-goals").getByTestId("home-goal-G2.1");
  await expect(sub.getByTestId("code-tag")).toHaveText("G-B.1");
  await expect(sub.getByTestId("code-name")).toHaveText("Win back lapsed teams");
  await sub.getByTestId("code-chip").click();
  const card = page.getByTestId("code-card");
  await expect(card.getByTestId("code-tag")).toHaveText("G-B.1");
  await expect(card.getByTestId("card-name")).toHaveText("Win back lapsed teams");
});

/** Adds a subgoal under G-B Growth in the named-codes company and returns its row. */
async function addGrowthSubgoal(page: Page, title: string, key: string) {
  await page.getByTestId("goal-g.paid-conversion").getByRole("button", { name: "Add subgoal" }).click();
  const add = page.getByRole("form", { name: "Add subgoal" });
  await add.getByLabel("Subgoal title").fill(title);
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId(`goal-g.paid-conversion.${key}`);
  await expect(row).toBeVisible();
  return row;
}

// protects: a subgoal's code is fixed by the order it was added under its parent, so a
// code quoted in a PRD keeps naming the same subgoal: a sibling's weight change, a new
// sibling or an archived one never renumbers it.
// fails_when: G-B.1 and G-B.2 swap when the second one is made heavier, or a later
// subgoal takes an archived one's number.
// no_claim: a subgoal moved to another parent (it is numbered by when it was created).
test("a subgoal keeps its code when a sibling's weight changes or a sibling is archived", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "named-codes"), MOCK_SCENARIO_KEY);
  await openBaseline(page);
  const first = await addGrowthSubgoal(page, "Win back lapsed teams", "win-back-lapsed-teams");
  const second = await addGrowthSubgoal(page, "Grow team seats", "grow-team-seats");
  await expect(first.getByTestId("code-tag")).toHaveText("G-B.1");
  await expect(second.getByTestId("code-tag")).toHaveText("G-B.2");

  // The second subgoal becomes the heavier one: it is listed first, and keeps G-B.2.
  await second.getByRole("button", { name: "Grow team seats", exact: true }).click();
  const d = drawer(page, "Grow team seats");
  await d.getByRole("button", { name: "Edit" }).click();
  const form = d.getByRole("form", { name: "Edit" });
  await form.locator("label", { hasText: "Weight" }).getByRole("spinbutton").fill("5");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(second.locator('[data-attr="weight"]')).toContainText("5");
  await d.getByRole("button", { name: "Close" }).click();
  await expect(second.getByTestId("code-tag")).toHaveText("G-B.2");
  await expect(first.getByTestId("code-tag")).toHaveText("G-B.1");

  // The first is rejected: the second stays G-B.2, and a new one is G-B.3, not G-B.1.
  await first.getByRole("button", { name: "Win back lapsed teams", exact: true }).click();
  const f = drawer(page, "Win back lapsed teams");
  await f.getByRole("button", { name: "Reject" }).click();
  await f.getByRole("form", { name: "Reject" }).getByRole("button", { name: "Reject" }).click();
  await expect(first).toHaveCount(0);
  await expect(second.getByTestId("code-tag")).toHaveText("G-B.2");
  await f.getByRole("button", { name: "Close" }).click();
  const third = await addGrowthSubgoal(page, "Shorter trials", "shorter-trials");
  await expect(third.getByTestId("code-tag")).toHaveText("G-B.3");

  await page.goto("/plan");
  await expect(page.getByTestId("plan-goals").getByText("G-B.2", { exact: true })).toBeVisible();
});

// protects: a proposed subgoal is rejected, not archived: its inspector offers Reject and
// says Rejected; only a confirmed subgoal offers Archive subgoal.
// fails_when: a proposed subgoal shows "Archive subgoal", or its message says Archived.
// no_claim: archiving a confirmed subgoal (the move, promote and archive test).
test("a proposed subgoal offers Reject, not Archive subgoal, and says Rejected", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("goal-g.early-churn").getByRole("button", { name: "Add subgoal" }).click();
  const add = page.getByRole("form", { name: "Add subgoal" });
  await add.getByLabel("Subgoal title").fill(SUB);
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId(`goal-${SUB_KEY}`);
  await row.getByRole("button", { name: SUB, exact: true }).click();
  const d = drawer(page, SUB);
  await expect(d.getByRole("button", { name: "Promote to goal" })).toBeVisible();
  await expect(d.getByRole("button", { name: "Archive subgoal" })).toHaveCount(0);
  await d.getByRole("button", { name: "Reject" }).click();
  const ask = d.getByRole("form", { name: "Reject" });
  await ask.getByLabel(/Reason/).fill("A duplicate of the activation work.");
  await ask.getByRole("button", { name: "Reject" }).click();
  await expect(d).toContainText(`Rejected “${SUB}”.`);
  await expect(d).not.toContainText("Archived");
  await expect(row).toHaveCount(0);
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
    const title = row.getByRole("button", { name: SUB, exact: true });
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeInViewport();
    expect(await contrast(title)).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page.getByTestId("goal-g.early-churn").locator('[data-attr="progress"]'))).toBeGreaterThanOrEqual(4.5);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await page.getByTestId("goal-g.early-churn").getByRole("button", { name: "Hide subgoals of Cut early churn" }).click();
    await expect(row).toHaveCount(0);

    await page.goto("/plan");
    const card = page.getByTestId("plan-goals").getByTestId("home-goal-G3");
    await card.getByTestId("home-goal-G3.1").scrollIntoViewIfNeeded();
    await expect(card.getByTestId("home-goal-G3.1")).toBeInViewport();
    expect(await contrast(card.getByTestId("goal-rollup"))).toBeGreaterThanOrEqual(4.5);
  });
}
