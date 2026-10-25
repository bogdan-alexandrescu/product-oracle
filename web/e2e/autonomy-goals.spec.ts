import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * B6 Goals interview under H11 Autonomy (Shape goals) through the UI, on the mock layer: an
 * owner sets the level on Settings › Autonomy with a reason, then the Baseline follows it.
 * At Observe Oracle opens no goals interview (the plain sentence stands where Make measurable
 * was; the Not measurable flags stay); at Draft Oracle drafts one version for the goal's owner
 * to edit and own, with no "Use version 1" default. The seed's "Cut early churn" is vague.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_goals_autonomy.py.
 */

const OBSERVING = "Oracle is set to observe goals: it flags gaps and drafts nothing. An owner can change this in Settings › Autonomy.";

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });
const churnRow = (page: Page) => page.getByTestId("goal-g.early-churn");
const discuss = (page: Page) => page.getByTestId("goal-discuss");

/** An owner sets Shape goals to `level` on Settings › Autonomy, saying why. */
async function setShapeGoals(page: Page, level: "Observe" | "Draft", why: string) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  await expect(row(page, "goals")).toContainText("Shape goals");
  await step(page, "goals", level).click();
  const sheet = page.getByRole("dialog", { name: "Change Shape goals" });
  await sheet.getByLabel("Why").fill(why);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "goals", level)).toHaveAttribute("aria-pressed", "true");
}

async function openBaseline(page: Page) {
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(churnRow(page)).toBeVisible();
}

// protects=at Observe the Goals panel shows the plain sentence instead of Make measurable and
// Interview vague goals, the Not measurable chip stays, and the goal's drawer says the same
// with what the goal misses; fails_when=a Make measurable or Interview vague goals button is
// still offered, the sentence is missing, or the flag disappears; no_claim=the API's 409
// (pytest tests/test_goals_autonomy.py covers it).
test("goals autonomy: at Observe the Baseline shows the sentence instead of Make measurable", async ({ page }) => {
  await login(page);
  await setShapeGoals(page, "Observe", "We set our goals ourselves this quarter");
  await openBaseline(page);
  await expect(page.getByTestId("goals-observe")).toHaveText(OBSERVING);
  await expect(churnRow(page).getByTestId("not-measurable")).toHaveText("Not measurable");
  await expect(page.getByRole("button", { name: "Make measurable" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Interview vague goals/ })).toHaveCount(0);

  await churnRow(page).getByRole("button", { name: /Cut early churn/ }).first().click();
  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer.getByTestId("goals-observe")).toHaveText(OBSERVING);
  await expect(drawer.getByRole("button", { name: "Make measurable" })).toHaveCount(0);
});

// protects=at Draft Make measurable opens the interview with one version card, a line naming
// who it is drafted for, and no "Use version 1" quick reply; fails_when=two cards, the default
// quick reply, or no named person; no_claim=the API's trimming of a real reply (pytest
// tests/test_goals_autonomy.py covers it).
test("goals autonomy: at Draft Oracle drafts one version with no default", async ({ page }) => {
  await login(page);
  await setShapeGoals(page, "Draft", "Goal owners should write their own targets");
  await openBaseline(page);
  await churnRow(page).getByRole("button", { name: "Make measurable" }).click();
  await expect(discuss(page).getByTestId("version-card")).toHaveCount(1);
  await expect(discuss(page).getByTestId("goals-draft-note")).toContainText("Oracle drafted one version for");
  await expect(discuss(page).getByTestId("goals-draft-note")).toContainText("to edit and own.");
  const quick = discuss(page).getByTestId("quick-replies");
  await expect(quick.getByRole("button")).toHaveText(["I don't know", "Ask someone…"]);
});
