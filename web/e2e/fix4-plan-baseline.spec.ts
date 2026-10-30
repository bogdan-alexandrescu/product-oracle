import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4 on /baseline and Plan's goal cards (qa-plan-4, 7, 35-40), through the UI on the
 * mock layer. Each test's card: protects=<the observable>; fails_when=<the wrong result>;
 * no_claim=<what green does not prove>.
 */

const DESKTOP = { width: 1366, height: 820 };

async function openBaseline(page: Page, email?: string) {
  await login(page, email);
  await page.getByTestId("nav-baseline").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/baseline/);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
}

const goalsTable = (page: Page) => page.getByRole("grid", { name: "Goals" });
const ledger = (page: Page) => page.getByRole("table", { name: "Feature × goal" });
const box = async (l: Locator) => (await l.boundingBox())!;

/** True when the element cuts its own text off, sideways or below. */
const clipped = (el: Locator) =>
  el.evaluate((e) => {
    const cs = getComputedStyle(e);
    const x = cs.overflowX !== "visible" && e.scrollWidth > e.clientWidth + 1;
    const y = cs.overflowY !== "visible" && e.scrollHeight > e.clientHeight + 1;
    return x || y || cs.textOverflow === "ellipsis";
  });

test.use({ viewport: DESKTOP });

// protects=qa-plan-4: Plan's goal cards and the Baseline's Goals table read one confidence for
// the same goal; fails_when=Plan rings 78 / 66 while the Baseline says not scored (no evidence);
// no_claim=the API's scoring (pytest).
test("qa-plan-4: Plan's goal cards and the Baseline's Goals table show the same confidence", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-plan").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/plan/);
  const plan = page.getByTestId("plan-goals");
  const g1 = plan.getByTestId("home-goal-G1");
  const g2 = plan.getByTestId("home-goal-G2");
  await expect(g1).toContainText("Raise activation");
  // No evidence yet on either goal: no score on Plan either.
  await expect(g1.getByRole("img", { name: "No confidence" })).toBeVisible();
  await expect(g1.getByRole("img", { name: /Confidence 78/ })).toHaveCount(0);
  await expect(g2.getByRole("img", { name: /Confidence 66/ })).toHaveCount(0);

  await page.getByTestId("nav-baseline").filter({ visible: true }).first().click();
  const table = goalsTable(page);
  for (const key of ["g.activation", "g.paid-conversion"]) {
    const row = table.getByTestId(`goal-${key}`);
    await expect(row.getByRole("img", { name: "Not scored: no evidence yet" })).toBeVisible();
    await expect(row.getByRole("img", { name: /^Confidence/ })).toHaveCount(0);
  }
  await table.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Raise activation" });
  await expect(drawer.getByRole("img", { name: "Not scored: no evidence yet" })).toBeVisible();
});

// protects=qa-plan-7: with an item's drawer open the Feature × goal table keeps the feature's
// name whole; its flags wrap under it; fails_when=the name ends in "Usa…"; no_claim=phones.
test("qa-plan-7: an open drawer leaves the feature names whole in Feature × goal", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  await expect(page.getByRole("dialog", { name: "Guided setup" })).toBeVisible();
  const usage = ledger(page).getByTestId("feature-f.usage-export");
  const name = usage.getByRole("button", { name: "Usage export", exact: true });
  await expect(name).toBeVisible();
  expect(await clipped(name)).toBe(false);
  // Its flags and Proposed sit beside the name or wrap below it, never over it.
  const n = await box(name);
  const chips = usage.locator("td").first().getByTestId("flag").or(usage.locator("td").first().getByText("Proposed", { exact: true }));
  for (const other of await chips.all()) {
    if (!(await other.isVisible())) continue;
    const o = await box(other);
    expect(o.x < n.x + n.width && n.x < o.x + o.width && o.y < n.y + n.height && n.y < o.y + o.height).toBe(false);
  }
});

// protects=qa-plan-35: every goal's progress reads in one form, "N% of the way … to <target>";
// fails_when="78% of target" beside "50% of the way from 31%"; no_claim=the roll-up maths.
test("qa-plan-35: goal progress reads in one wording", async ({ page }) => {
  await openBaseline(page);
  const progress = (key: string) => goalsTable(page).getByTestId(`goal-${key}`).locator('[data-attr="progress"]');
  await expect(progress("g.activation")).toHaveText("50% of the way from 31% to ≥ 45%");
  await expect(progress("g.paid-conversion")).toHaveText("78% of the way to ≥ 12%");
  await expect(goalsTable(page)).not.toContainText("of target");
});

// protects=qa-plan-36: the goal's chip, its drawer and its Make measurable discussion name the
// same missing fields; fails_when="unit, comparison, target, horizon, owner" in one place and
// "Target · Horizon · Owner" in the other; no_claim=the interview's wording.
test("qa-plan-36: Make measurable names one list of missing fields everywhere", async ({ page }) => {
  await openBaseline(page, "commenter@example.com");
  const churn = goalsTable(page).getByTestId("goal-g.early-churn");
  await expect(churn.getByTestId("not-measurable")).toHaveAttribute("title", "Missing: target, horizon, owner");
  await churn.getByRole("button", { name: "Cut early churn", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Cut early churn" });
  await expect(drawer.getByTestId("drawer-missing")).toContainText("Missing: target, horizon, owner.");
  await expect(drawer).not.toContainText("unit, comparison");
  await drawer.getByRole("button", { name: "Make measurable" }).click();
  await expect(page.getByTestId("goal-discuss").getByTestId("missing-chip")).toHaveText(["Target", "Horizon", "Owner"]);
});

// protects=qa-plan-37: Add subgoal opens its title field right under the goal it is for;
// fails_when=the field opens above the whole table; no_claim=phones.
test("qa-plan-37: Add subgoal opens under its goal's row", async ({ page }) => {
  await openBaseline(page);
  const table = goalsTable(page);
  const activation = table.getByTestId("goal-g.activation");
  await activation.getByRole("button", { name: "Add subgoal" }).click();
  const form = page.getByRole("form", { name: "Add subgoal" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Subgoal title")).toBeFocused();
  const [row, f, next] = await Promise.all([activation, form, table.getByTestId("goal-g.paid-conversion")].map(box));
  expect(f.y).toBeGreaterThanOrEqual(row.y + row.height - 1);
  expect(f.y + f.height).toBeLessThanOrEqual(next.y + 1);
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
});

// protects=qa-plan-38: the Feature × goal targets row is labelled on its left, and the goals'
// names wrap whole; fails_when="Target" sits under Confidence or "Grow paid conv…" is cut;
// no_claim=other widths.
test("qa-plan-38: the targets row is labelled on the left; goal names wrap", async ({ page }) => {
  await openBaseline(page);
  const t = ledger(page);
  const label = t.getByTestId("ledger-targets").getByRole("rowheader", { name: "Targets" });
  await expect(label).toBeVisible();
  // The words themselves start at the table's left, under Feature, not under Confidence.
  const textX = await label.evaluate((e) => {
    const r = document.createRange();
    r.selectNodeContents(e);
    return r.getBoundingClientRect().x;
  });
  const delivery = await box(t.getByRole("columnheader", { name: "Delivery" }));
  expect(textX).toBeLessThan(delivery.x);
  const paid = t.getByRole("columnheader").getByRole("button", { name: "Grow paid conversion", exact: true });
  await expect(paid).toBeVisible();
  expect(await clipped(paid)).toBe(false);
});

// protects=qa-plan-39: a goal row's actions are the same size and line up; fails_when=Confirm
// is narrower than Add subgoal stacked under it; no_claim=phones (qa-plan-26 covers them).
test("qa-plan-39: a goal row's Confirm and Add subgoal are one size and aligned", async ({ page }) => {
  await openBaseline(page);
  const churn = goalsTable(page).getByTestId("goal-g.early-churn");
  const [c, a] = await Promise.all([churn.getByRole("button", { name: "Confirm" }), churn.getByRole("button", { name: "Add subgoal" })].map(box));
  expect(Math.abs(c.width - a.width)).toBeLessThan(1);
  expect(Math.abs(c.height - a.height)).toBeLessThan(1);
  expect(Math.abs(c.x - a.x)).toBeLessThan(1);
  // Row to row too: activation's Add subgoal stands where churn's does.
  const other = await box(goalsTable(page).getByTestId("goal-g.activation").getByRole("button", { name: "Add subgoal" }));
  expect(Math.abs(other.x - a.x)).toBeLessThan(1);
  expect(Math.abs(other.width - a.width)).toBeLessThan(1);
});

// protects=qa-plan-40: the Goals panel's two buttons say what they do in plain words, with the
// count read as words; fails_when="Interview vague goals (2)" or "Fill goals from text (1 goal)";
// no_claim=other counts.
test("qa-plan-40: the Goals buttons read 'Ask Oracle to sharpen 2 goals' and 'Read targets from 1 goal's text'", async ({ page }) => {
  await openBaseline(page);
  const goals = page.getByRole("region", { name: "Goals", exact: true });
  await expect(goals.getByRole("button", { name: "Ask Oracle to sharpen 2 goals" })).toBeVisible();
  await expect(goals.getByRole("button", { name: "Read targets from 1 goal's text" })).toBeVisible();
  await expect(goals).not.toContainText("Interview vague goals");
  await expect(goals).not.toContainText("Fill goals from text");
  // Its question asks with the same words.
  await goals.getByRole("button", { name: "Read targets from 1 goal's text" }).click();
  const ask = page.getByRole("alertdialog", { name: "Read targets from 1 goal's text" });
  await expect(ask).toContainText("Cut early churn");
  await ask.getByRole("button", { name: "Back" }).click();
});
