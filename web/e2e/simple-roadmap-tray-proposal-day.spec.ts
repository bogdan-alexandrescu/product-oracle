import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The roadmap's Needs a decision panel listed two proposals on one milestone in the same words,
 * so a person could not tell the one that has waited for weeks from the newer one. Each row now
 * says the day it was proposed, month first ("Oct 22", "Nov 4"), as Home does. Mock scenario
 * "simple-milestones" (invented goals, items and people): an approver who is not the roadmap's
 * owner proposes a change to "M1 Alerts live for 50 teams" on Oct 22 (the mock's today) and
 * another on Nov 4; the roadmap's owner reads both in the panel.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const APPROVER = "approver@example.com";
const M1 = "M1 Alerts live for 50 teams";
const card = (page: Page) => page.getByTestId("ms-card");

async function roadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function propose(page: Page, name: string) {
  await page.getByTestId("ms-label").filter({ hasText: M1 }).click();
  await expect(card(page)).toHaveAttribute("data-rights", "propose");
  await card(page).getByLabel("Name").fill(name);
  await card(page).getByTestId("ms-propose").click();
  await expect(page.getByTestId("ms-toast")).toContainText(`Proposed a change to ${M1}`);
  await expect(card(page)).toHaveCount(0);
}

test("two proposals on one milestone each show the day they were made, month first", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-milestones"] as const);
  await login(page, APPROVER);
  await roadmap(page);
  await propose(page, "Alerts live for 60 teams");
  // Thirteen days later the same person proposes again.
  await page.clock.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  await roadmap(page);
  await propose(page, "Alerts live for 70 teams");

  // The roadmap's owner signs in and opens Needs a decision.
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page);
  await roadmap(page);
  await page.getByTestId("needs-decision").click();
  const rows = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Milestone 'Alerts live for 50 teams': change it" });
  await expect(rows).toHaveCount(2);
  const day = (words: string) => rows.filter({ has: page.getByTestId("tray-proposal-day").filter({ hasText: new RegExp(`^\\s*·\\s*${words}$`) }) });
  await expect(day("Oct 22")).toHaveCount(1);
  await expect(day("Nov 4")).toHaveCount(1);
});

/*
 * The day was on every row, a key date's proposal too, and never with its year: a proposal
 * left from last year read like this year's. Now only a milestone's proposal says its day, with
 * the year when it is not this one ("Oct 22, 2026" read in January 2027).
 */
test("only a milestone's proposal says its day, with the year once it is not this one", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-milestones"] as const);
  await login(page, APPROVER);
  await roadmap(page);
  await propose(page, "Alerts live for 60 teams");
  // The same person proposes a key date too.
  await roadmap(page);
  await page.getByTestId("format-gantt").click();
  await page.getByTestId("key-dates-open").click();
  const editor = page.getByTestId("key-dates-editor");
  await editor.getByLabel("Roadmap", { exact: true }).selectOption({ index: 1 });
  await editor.getByLabel("New key date's name").fill("Product launch");
  await editor.getByLabel("New key date's day").fill("2026-12-08");
  await editor.getByRole("button", { name: "Propose" }).click();
  await expect(page.getByText(/Added the key date 'Product launch' proposed/)).toBeVisible();

  // The roadmap's owner reads them in the new year.
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.clock.setSystemTime(new Date("2027-01-06T12:00:00Z"));
  await login(page);
  await roadmap(page);
  await page.getByTestId("needs-decision").click();
  const tray = page.getByTestId("decision-tray");
  const milestone = tray.getByTestId("tray-proposal").filter({ hasText: "Milestone 'Alerts live for 50 teams': change it" });
  await expect(milestone.getByTestId("tray-proposal-day")).toHaveText(/^\s*·\s*Oct 22, 2026$/);
  const keyDate = tray.getByTestId("tray-proposal").filter({ hasText: "Key date 'Product launch'" });
  await expect(keyDate).toBeVisible();
  await expect(keyDate.getByTestId("tray-proposal-day")).toHaveCount(0);
  await expect(keyDate).not.toContainText("Oct 22");
});
