import { expect, type Locator, type Page, test } from "./test";

import { login, openSection, openTab } from "./helpers";

/**
 * Change D (owner decision 2026-10-20): a citation keeps the confidence its writer computed.
 * Sources and the citation card show it beside the source; a low-confidence one wears the
 * app's low-confidence chip; one with no confidence shows its note instead. All as text.
 */

const NOTE = "owner decision (confirmed, locked) <G1>; not evidence-scored";

async function sourceRow(page: Page, title: string): Promise<Locator> {
  return page.getByTestId("sources-list").filter({ visible: true }).getByRole("listitem").filter({ hasText: title });
}

test("Sources: each source's confidence beside it, low ones marked, a note when there is no score", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await openTab(page, "Sources");

  const github = await sourceRow(page, "Address form loses state on back navigation");
  await expect(github.getByTestId("source-label")).toHaveText("GitHub · 0.75");
  await expect(github.getByText("Low confidence")).toHaveCount(0);

  const slack = await sourceRow(page, "#product thread on checkout drop-off");
  await expect(slack.getByTestId("source-label")).toHaveText("Slack · 0.82");

  // Low confidence: the score plus the app's low-confidence chip (a warn chip).
  const interview = await sourceRow(page, "Customer interview 07");
  await expect(interview.getByTestId("source-label")).toHaveText("Meeting notes · 0.35");
  const low = interview.getByTestId("low-confidence");
  await expect(low).toHaveText("Low confidence");
  await expect(low).toHaveClass(/bg-warn-bg/);

  // No score: the note, as text (its angle brackets are characters, not markup).
  const goals = await sourceRow(page, "Q4 goals: activation and retention");
  await expect(goals.getByTestId("source-label")).toHaveText(`Notion · ${NOTE}`);
  await expect(goals.locator("g1")).toHaveCount(0);

  // A citation without any of it: the source alone.
  const funnel = await sourceRow(page, "Funnel export, September");
  await expect(funnel.getByTestId("source-label")).toHaveText("Google Docs");
});

test("citation card: confidence beside the source, low ones marked, the note when unscored", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const problem = await openSection(page, "problem");

  await problem.getByTestId("cite-c4").hover();
  const card = page.getByRole("tooltip");
  await expect(card.getByTestId("cite-source")).toContainText("GitHub · 0.75");
  await expect(card.getByTestId("low-confidence")).toHaveCount(0);

  await problem.getByTestId("cite-c2").hover();
  await expect(card.getByTestId("cite-source")).toContainText("Meeting notes · 0.35");
  await expect(card.getByTestId("low-confidence")).toHaveText("Low confidence");
  await expect(problem.getByTestId("cite-c2")).toHaveAccessibleName(/low confidence 0\.35/);

  const goal = await openSection(page, "goal-trace");
  await goal.getByTestId("cite-c3").hover();
  await expect(card.getByTestId("cite-source")).toContainText(`Notion · ${NOTE}`);
  await expect(card.locator("g1")).toHaveCount(0);
});
