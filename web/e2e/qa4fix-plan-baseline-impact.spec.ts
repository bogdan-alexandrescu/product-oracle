import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 4 on /baseline and the Impact pages (qa4-plan-42, 43, 45, 46, 50, 51, 52), through the
 * UI on the mock API. Each test's card: protects=<the observable>; fails_when=<the wrong result>;
 * no_claim=<what green does not prove>.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openBaseline(page: Page) {
  await login(page);
  await page
    .getByTestId("nav-baseline")
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/baseline/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Baseline" }),
  ).toBeVisible();
  await expect(page.getByTestId("goal-g.activation").first()).toBeVisible();
}

const goalsTable = (page: Page) => page.getByRole("grid", { name: "Goals" });
const ledger = (page: Page) =>
  page.getByRole("table", { name: "Feature × goal" });

const scenario = (page: Page, name: string) =>
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [MOCK_SCENARIO_KEY, name],
  );

/** PRDs > Checkout redesign > v2 > Impact. */
async function openVersionImpact(page: Page, signIn = true) {
  if (signIn) await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("link", { name: "Impact", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\/impact$/);
}

/** ... > Impact > Table > an output > its "Recorded change". */
async function openRecordedChange(page: Page, output: string, signIn = true) {
  await openVersionImpact(page, signIn);
  await page
    .getByRole("group", { name: "View" })
    .getByRole("button", { name: "Table" })
    .click();
  await page
    .getByRole("grid", { name: "Affected outputs" })
    .getByText(output)
    .first()
    .click();
  await page
    .getByRole("complementary", { name: new RegExp(output) })
    .getByRole("link", { name: "Recorded change" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/impact\/changes\//);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  // protects=qa4-plan-42: Plan and the Baseline give a goal's progress by one method, the same
  // figure; fails_when=Plan says "2.6 pts to go" and the Baseline "78% of the way to ≥ 12%";
  // no_claim=the API's roll-up of a parent from its subgoals.
  test("qa4-plan-42: a goal's progress reads the same on Plan and on the Baseline", async ({
    page,
  }) => {
    await login(page);
    await page
      .getByTestId("nav-plan")
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/plan/);
    const plan = page.getByTestId("plan-goals");
    const toGo = (tag: string) =>
      plan.getByTestId(`home-goal-${tag}`).getByTestId("goal-to-go");
    await expect(toGo("G1")).toHaveText("7 pts to go");
    await expect(toGo("G2")).toHaveText("2.6 pts to go");

    await page
      .getByTestId("nav-baseline")
      .filter({ visible: true })
      .first()
      .click();
    const progress = (key: string) =>
      goalsTable(page)
        .getByTestId(`goal-${key}`)
        .locator('[data-attr="progress"]');
    await expect(progress("g.activation")).toHaveText("7 pts to go (38% now)");
    await expect(progress("g.paid-conversion")).toHaveText(
      "2.6 pts to go (9.4% now)",
    );
    await expect(goalsTable(page)).not.toContainText("of the way");
  });

  // protects=qa4-plan-50: "Jun 30" and a progress figure never break inside; fails_when="Medium ·
  // Jun" over "30", or "2.6 pts" over "to go"; no_claim=other columns.
  test("qa4-plan-50: the horizon's date and the progress figure stay on one line", async ({
    page,
  }) => {
    await openBaseline(page);
    const row = goalsTable(page).getByTestId("goal-g.paid-conversion");
    const horizon = row.locator('[data-attr="horizon"]');
    await expect(horizon).toHaveText("Medium · Jun 30");
    // The space inside the date does not break.
    expect(await horizon.evaluate((e) => e.textContent)).toContain("Jun 30");
    const figure = row
      .locator('[data-attr="progress"]')
      .getByText("2.6 pts to go", { exact: true });
    await expect(figure).toBeVisible();
    expect(await figure.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe(
      "nowrap",
    );
    // One line high.
    expect((await figure.boundingBox())!.height).toBeLessThanOrEqual(26);
  });

  // protects=qa4-plan-51: the "Features traced" tile says which feature is not traced, and that
  // feature carries the mark in Feature × goal; fails_when=5 of 6 with no way to tell which;
  // no_claim=features linked only to a proposed goal.
  test("qa4-plan-51: the Features traced tile names the feature that is not traced", async ({
    page,
  }) => {
    await openBaseline(page);
    const tile = page.getByTestId("kpi-traced");
    await expect(tile).toContainText("5");
    await expect(tile).toContainText("6");
    await tile.getByRole("button", { name: "About Features traced" }).click();
    await expect(
      page.getByRole("tooltip").filter({ visible: true }),
    ).toContainText("Not traced: Dark mode");
    await expect(
      ledger(page)
        .getByTestId("feature-f.dark-mode")
        .getByText("Serves no goal"),
    ).toBeVisible();
  });

  // protects=qa4-plan-52: the fill button says what it does; fails_when="Read targets from 1
  // goal's text"; no_claim=what the fill reads.
  test("qa4-plan-52: the fill button reads 'Fill targets from the goal's wording (1)'", async ({
    page,
  }) => {
    await openBaseline(page);
    const goals = page.getByRole("region", { name: "Goals", exact: true });
    const fill = goals.getByRole("button", {
      name: "Fill targets from the goal's wording (1)",
    });
    await expect(fill).toBeVisible();
    await expect(goals).not.toContainText("Read targets from");
    await fill.click();
    const ask = page.getByRole("alertdialog", {
      name: "Fill targets from the goal's wording (1)",
    });
    await expect(ask).toContainText("Cut early churn");
    await ask.getByRole("button", { name: "Back" }).click();
  });

  // protects=qa4-plan-45: a recorded change's back link sits above the title, and the title does
  // not repeat the version the link names; fails_when="‹ Impact of Checkout redesign PRD v2" on
  // the row of "Impact: Checkout redesign PRD v2 › Success metrics section edited"; no_claim=phones.
  test("qa4-plan-45: the change's back link is above a title that does not repeat it", async ({
    page,
  }) => {
    await scenario(page, "impact");
    await openRecordedChange(page, "Saved addresses tech brief");
    const back = page.getByTestId("impact-back").filter({ visible: true });
    await expect(back).toContainText("Checkout redesign PRD v2");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Impact: Success metrics section edited");
    const b = (await back.boundingBox())!;
    const t = (await h1.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(t.y + 1);
    // The lineage still names the change in full.
    await expect(
      page
        .getByRole("region", { name: "Lineage" })
        .getByTestId("lineage-subject"),
    ).toContainText(
      "Checkout redesign PRD v2 › Success metrics section edited",
    );
  });

  // protects=qa4-plan-46: the Lineage legend lists only what the diagram draws; fails_when=
  // "deleted upstream" beside a diagram with nothing deleted; no_claim=the line styles.
  test("qa4-plan-46: the Lineage legend lists 'deleted upstream' only when something was deleted", async ({
    page,
  }) => {
    await scenario(page, "impact");
    await login(page);
    await page.goto("/baseline");
    await page
      .getByTestId("feature-f.guided-setup")
      .getByRole("button", { name: "Guided setup" })
      .click();
    await page
      .getByRole("dialog", { name: "Guided setup" })
      .getByRole("link", { name: "What if it changed?" })
      .click();
    await expect(page).toHaveURL(/\/impact\/entities\//);
    const legend = page.getByTestId("lineage-legend").filter({ visible: true });
    await expect(legend).toContainText("depends on");
    await expect(legend).not.toContainText("deleted upstream");

    // A change that deleted a requirement draws the red dashed line, and says so.
    await openRecordedChange(page, "Acceptance tests", false);
    await expect(
      page.getByTestId("lineage-legend").filter({ visible: true }),
    ).toContainText("deleted upstream");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  // protects=qa4-plan-43: a phone shows the facts a desktop does: Proposed on Usage export,
  // padded goal pills, and each goal's Metric, Horizon and Owner; fails_when=the pill is gone,
  // the code touches the pill's border, or the goal drops those fields; no_claim=tablets.
  test("qa4-plan-43: on a phone the Baseline keeps Proposed, pads goal pills and keeps goal fields", async ({
    page,
  }) => {
    await openBaseline(page);
    const usage = ledger(page).getByTestId("feature-f.usage-export");
    await expect(usage.getByText("Proposed", { exact: true })).toBeVisible();

    const guided = ledger(page).getByTestId("feature-f.guided-setup");
    const pill = guided
      .locator("td")
      .filter({ has: page.getByTestId("code-chip") })
      .first()
      .locator(":scope > span")
      .nth(1);
    await expect(pill).toBeVisible();
    expect(
      await pill.evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft)),
    ).toBeGreaterThanOrEqual(6);

    const activation = goalsTable(page).getByTestId("goal-g.activation");
    await expect(activation.locator('[data-attr="metric"]')).toBeVisible();
    await expect(activation.locator('[data-attr="metric"]')).toHaveText(
      "Accounts that finish setup within 7 days",
    );
    await expect(activation.locator('[data-attr="horizon"]')).toBeVisible();
    await expect(activation.locator('[data-attr="owner"]')).toBeVisible();
    await expect(activation).toContainText("Owner");
  });
});
