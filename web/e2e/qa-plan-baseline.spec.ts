import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 1 on /baseline (qa-plan-2, 3, 11, 12, 16, 43-50, prod-7), through the UI on the mock
 * layer. Each test's card: protects=<the observable>; fails_when=<the wrong result>;
 * no_claim=<what green does not prove>.
 */

const PHONE = { width: 390, height: 844 };

async function openBaseline(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
}

const goalsTable = (page: Page) => page.getByRole("grid", { name: "Goals" });

/** Texts under `root` that cut their own content off sideways (ellipsis or clip). */
async function clippedTexts(root: Locator): Promise<string[]> {
  return root.evaluate((el) =>
    [el, ...el.querySelectorAll<HTMLElement>("*")]
      .filter((e) => {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || e.closest(".sr-only") || e.clientWidth <= 1) return false;
        return cs.overflowX !== "visible" && e.scrollWidth > e.clientWidth + 1;
      })
      .map((e) => (e.textContent ?? "").trim()),
  );
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// protects=qa-plan-2: the goals' names and their Not measurable chips are whole; the action
// column is narrow; fails_when=a name or chip is cut mid-word, or the actions take 232 px;
// no_claim=widths above 1320 px.
test("goals table: names and chips are whole, the actions column is narrow", async ({ page }) => {
  await openBaseline(page);
  const table = goalsTable(page);
  for (const key of ["g.activation", "g.paid-conversion", "g.early-churn"]) {
    const goal = table.getByTestId(`goal-${key}`).locator("td").first();
    expect(await clippedTexts(goal)).toEqual([]);
    expect((await goal.boundingBox())!.width).toBeGreaterThan(180);
  }
  await expect(table.getByTestId("goal-g.early-churn").getByTestId("not-measurable")).toHaveText("Not measurable");
  const act = table.getByTestId("goal-g.early-churn").locator("td").last();
  expect((await act.boundingBox())!.width).toBeLessThanOrEqual(140);
  await expect(table.getByTestId("goal-g.early-churn").getByRole("button", { name: "Add subgoal" })).toBeVisible();
});

// protects=qa-plan-3: with a feature's drawer open the Goals table keeps the goal's name and
// drops Weight and Horizon; fails_when=the Goal column is squeezed away; no_claim=other tables.
test("goals table: an open drawer drops Weight and Horizon, not the goal's name", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  await expect(page.getByRole("dialog", { name: "Guided setup" })).toBeVisible();
  const table = goalsTable(page);
  await expect(table.getByRole("columnheader", { name: "Goal", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Weight" })).toBeHidden();
  await expect(table.getByRole("columnheader", { name: "Horizon" })).toBeHidden();
  const name = table.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation", exact: true });
  await expect(name).toBeVisible();
  expect((await name.boundingBox())!.width).toBeGreaterThan(100);
  expect(await clippedTexts(table.getByTestId("goal-g.activation").locator("td").first())).toEqual([]);
});

// protects=qa-plan-16: on a phone Make measurable and Add subgoal never overlap;
// fails_when=their boxes intersect; no_claim=other rows' actions.
test("phone: Make measurable and Add subgoal do not overlap", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openBaseline(page);
  const churn = page.getByTestId("goal-g.early-churn");
  const make = churn.getByTestId("make-measurable");
  const add = churn.getByRole("button", { name: "Add subgoal" });
  await expect(make).toBeVisible();
  await expect(add).toBeVisible();
  expect(overlaps((await make.boundingBox())!, (await add.boundingBox())!)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// protects=qa-plan-43: Progress says what its number is; fails_when=it reads "50% own";
// no_claim=the roll-up maths (subgoals.spec, pytest).
test("goals table: progress reads '50% of target'", async ({ page }) => {
  await openBaseline(page);
  const progress = page.getByTestId("goal-g.activation").locator('[data-attr="progress"]');
  await expect(progress).toHaveText("50% of target");
  await expect(progress).not.toContainText("own");
});

// protects=qa-plan-47: Fill from text says it changes the goals and asks first, naming them;
// Back changes nothing; fails_when=the click writes at once; no_claim=the parse rules.
test("Fill goals from text asks first, naming the goal, and Back changes nothing", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Fill goals from text (1 goal)" }).click();
  const ask = page.getByRole("alertdialog", { name: "Fill 1 goal from text" });
  await expect(ask).toContainText("Cut early churn");
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(ask).toHaveCount(0);
  const churn = page.getByTestId("goal-g.early-churn");
  await expect(churn.locator('[data-attr="target"]')).toHaveAttribute("data-text", "true");

  await page.getByRole("button", { name: "Fill goals from text (1 goal)" }).click();
  await ask.getByRole("button", { name: "Fill 1 goal from text" }).click();
  await expect(page.getByRole("status")).toContainText("1 goal filled.");
  await expect(churn.locator('[data-attr="target"]')).toHaveText("< 8%");
});

// protects=prod-7 and qa-plan-44: rings name their unit and a legend says what the marks are;
// Delivery and Review headers say which state; fails_when=a bare ring, "Conf." or "State";
// no_claim=the ring's drawing.
test("feature × goal: a legend, Confidence and Delivery headers; goals' Review header", async ({ page }) => {
  await openBaseline(page);
  const ledger = page.getByRole("table", { name: "Feature × goal" });
  await expect(page.getByTestId("ledger-legend")).toContainText("Rings: confidence, 0 to 100%");
  await expect(ledger.getByRole("columnheader", { name: "Delivery" })).toBeVisible();
  await expect(ledger.getByRole("columnheader", { name: "Confidence" })).toBeVisible();
  await expect(ledger.getByRole("columnheader", { name: "Conf." })).toHaveCount(0);
  await expect(page.getByTestId("feature-f.guided-setup").getByRole("img", { name: "Confidence 71%" })).toBeVisible();
  await expect(goalsTable(page).getByRole("columnheader", { name: "Review", exact: true })).toBeVisible();
  await expect(goalsTable(page).getByRole("columnheader", { name: "State", exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /Flagged/ }).click();
  await expect(page.getByRole("columnheader", { name: "Review", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "State", exact: true })).toHaveCount(0);
});

// protects=qa-plan-11 and qa-plan-45: a proposal's Details say the change in words, and its
// sentence names states as the app does; fails_when="update entity", "attrs.status: planned",
// or "to planned (was idea)"; no_claim=other kinds of proposal.
test("proposals: Details read 'Change: Delivery status → Planned'", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("tab", { name: /Proposals/ }).click();
  const dark = page.getByTestId("proposal").filter({ hasText: "Dark mode" });
  await expect(dark.getByTestId("proposal-summary")).toHaveText("Set Dark mode’s delivery status to Planned (was Idea)");
  await dark.getByText("Details", { exact: true }).click();
  await expect(dark.getByTestId("proposal-op")).toHaveText("Change:");
  await expect(dark.getByLabel("Proposed fields")).toHaveText("delivery status → Planned");
  await expect(dark).not.toContainText("attrs.");
  await expect(dark).not.toContainText("update entity");
});

// protects=qa-plan-12: a conflict reads in words, on a 0-100 scale, with the rule as a
// sentence that explains why the leading claim leads; fails_when=in_progress, 0.52, a mono
// field name or "confidence tie (0.52 vs 0.58)"; no_claim=the rule's maths (pytest).
test("conflicts: values in words, percentages, and why the leading claim leads", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("tab", { name: /Conflicts/ }).click();
  const open = page.getByTestId("conflict").filter({ hasText: "Saved carts" });
  await expect(open.getByTestId("conflict-field")).toHaveText("Delivery status");
  const claims = open.getByTestId("claim");
  await expect(claims.nth(0)).toContainText("In progress");
  await expect(claims.nth(0)).toContainText("Leading");
  await expect(claims.nth(0).getByTestId("confidence")).toHaveText("52%");
  await expect(claims.nth(1)).toContainText("Planned");
  await expect(claims.nth(1).getByTestId("confidence")).toHaveText("58%");
  const rule = open.getByTestId("conflict-rule");
  await expect(rule).toContainText("Why it leads:");
  await expect(rule).toContainText("52% and 58% is too close to call");
  await expect(rule).toContainText("outranks");
  await expect(open).not.toContainText("in_progress");
  await expect(open).not.toContainText("0.52");
  const field = await open.getByTestId("conflict-field").evaluate((e) => getComputedStyle(e).fontFamily);
  expect(field).not.toMatch(/mono/i);
});

// protects=qa-plan-46: the drawer's attribute keys read as words and its stat labels are
// whole; fails_when="status"/"effort" raw, or "Confide…"; no_claim=other kinds' attributes.
test("entity drawer: attribute labels in words, Confidence label whole", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("feature-f.guided-setup").getByRole("button", { name: "Guided setup" }).click();
  const d = page.getByRole("dialog", { name: "Guided setup" });
  const labels = d.getByLabel("Attributes").locator("dt");
  await expect(labels).toContainText(["Status", "Effort"]);
  const stat = d.locator("dl").first().locator("dt").filter({ hasText: "Confidence" });
  await expect(stat).toBeVisible();
  expect(await clippedTexts(stat)).toEqual([]);
});

// protects=qa-plan-48: an owner-only gap is titled by its question, and the stepper has no stray
// separators; fails_when="Make … measurable" for it, or "·" between the buttons;
// no_claim=Oracle's turns.
test("interview: owner-only gap asks who owns it; the stepper has no separators", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Interview vague goals (2)" }).click();
  const discuss = page.getByTestId("goal-discuss");
  await expect(discuss.getByRole("heading", { name: "Who should own “Grow paid conversion”?" })).toBeVisible();
  const stepper = discuss.getByTestId("interview-stepper");
  await expect(stepper.getByTestId("stepper-position")).toHaveText("Goal 1 of 2");
  expect(await stepper.innerText()).not.toContain("·");
});

// protects=qa-plan-49: the Items tab's empty state names the kinds, and it has one Add;
// fails_when="No items of this kind yet" under All, or Add item beside Add;
// no_claim=a company with items.
test("items: the empty state names the kinds, and one Add control", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("tab", { name: /Items/ }).click();
  const list = page.getByRole("grid", { name: "Items" });
  await expect(list.getByTestId("table-empty")).toHaveText("No risks, assumptions, requirements or strategy choices yet");
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(1);
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /Risks/ }).click();
  await expect(list.getByTestId("table-empty")).toHaveText("No risks yet");
});

// protects=qa-plan-50: on a phone the tabs are one scrolling line, the confirmed chip does not
// stand alone, and the feature list keeps delivery state and confidence; fails_when=the tabs
// wrap onto two lines, the chip shows, or a feature drops Delivery/Confidence;
// no_claim=desktop.
test("phone: tabs scroll on one line; features keep delivery and confidence", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openBaseline(page);
  const tabs = page.getByRole("tab");
  const first = (await tabs.first().boundingBox())!;
  const last = (await tabs.last().boundingBox())!;
  expect(Math.abs(last.y - first.y)).toBeLessThan(2);
  const strip = page.getByRole("tablist", { name: "Baseline views" });
  expect(await strip.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await expect(page.getByTestId("confirmed-chip")).toBeHidden();

  const guided = page.getByTestId("feature-f.guided-setup");
  await expect(guided.getByTestId("phone-feature-delivery")).toBeVisible();
  await expect(guided.getByTestId("phone-feature-delivery")).toHaveText("In progress");
  await expect(guided.getByTestId("phone-feature-confidence")).toBeVisible();
  await expect(guided.getByRole("img", { name: "Confidence 71%" })).toBeVisible();
  expect(await clippedTexts(guided)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
