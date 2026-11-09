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
