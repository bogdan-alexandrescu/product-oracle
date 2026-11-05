import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Answers at a run's stops, on the run page: the questions the engineering lead answered at the
 * Engineering review are listed in the run's Decisions under that stop, each as
 * "<question> → <answer> · <who> · <when>" with a month-first date, so a person sees what was
 * decided there. On the mock layer, driven as a person would.
 *
 * Test card: protects=each answered question shows under the Engineering review decision with its
 * answer, who answered it and when; fails_when=the Decisions show only "Engineering review was
 * approved by …", or a date reads ISO; no_claim=the PRD the agents write with the answers.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const row = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const inspector = (page: Page) => page.getByTestId("brief-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");

async function verdict(page: Page, key: string, choice: string) {
  await row(page, key).getByRole("button").first().click();
  await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: choice, exact: true }).click();
  await expect(row(page, key).getByTestId("brief-verdict")).toHaveText(choice);
}

async function answer(page: Page, question: RegExp, text: string) {
  await inspector(page).getByRole("textbox", { name: question }).fill(text);
  await inspector(page).getByRole("button", { name: "Answer", exact: true }).first().click();
  await expect(inspector(page).getByTestId("answer").filter({ hasText: text })).toBeVisible();
}

test("the run page lists the answered questions under the Engineering review stop", async ({ page }) => {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page.getByTestId("brief-row")).toHaveCount(3);

  for (const key of ["f.guided-setup", "f.sample-data", "f.saved-carts"]) await verdict(page, key, "Feasible");
  await row(page, "f.guided-setup").getByRole("button").first().click();
  await answer(page, /^Answer: Does the payment sandbox/, "Yes, the sandbox takes test orders.");
  await answer(page, /^Answer: Show the checklist on phones/, "Phones come in the second release.");
  await bar(page).getByRole("button", { name: "Approve" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  const section = page.getByRole("complementary", { name: "Run" }).filter({ visible: true }).getByTestId("run-decisions");
  const eng = section.getByTestId("run-decision").filter({ hasText: "Engineering review was approved by Theo Brandt" });
  await expect(eng).toHaveCount(1);
  const answers = eng.getByRole("list", { name: "Answered at Engineering review" }).getByTestId("run-decision-answer");
  await expect(answers).toHaveCount(2);
  const when = String.raw`[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M`;
  await expect(answers.nth(0)).toHaveText(
    new RegExp(String.raw`^Does the payment sandbox take test orders without a live account\? → Yes, the sandbox takes test orders\. · Theo Brandt · ${when}`),
  );
  await expect(answers.nth(1)).toHaveText(
    new RegExp(String.raw`^Show the checklist on phones too\? → Phones come in the second release\. · Theo Brandt · ${when}`),
  );
  // Never an ISO date.
  await expect(section).not.toContainText(/\d{4}-\d{2}-\d{2}/);
});
