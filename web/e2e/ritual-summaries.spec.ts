import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * #556 item 1: every ritual's summary is Markdown and renders as Markdown, not only the
 * competitive digest's. Driven through the UI on the mock layer (lib/api/mock/rituals.ts):
 * the "rituals" scenario's Monthly roadmap refresh (a non-digest kind) and the "metrics"
 * scenario's Weekly metrics review. Each mock summary carries a heading, a list, bold text and
 * two links no summary may draw: one to another host (/\evil.example) and one to javascript:.
 */

const APPROVER = "approver@example.com";

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function withScenario(page: Page, scenario: string, time: Date) {
  await page.clock.install({ time });
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
}

async function openRitual(page: Page, title: string) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByTestId("company-tab-rituals").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/company\/rituals$/);
  await page.getByTestId("ritual-row").filter({ hasText: title }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

/** The written summary: a heading, bold text and a list; no literal # or **; the unsafe links are text. */
async function expectMarkdown(summary: Locator, heading: string, bold: string) {
  await expect(summary).toContainText("Written by Oracle", { timeout: 15_000 });
  await expect(summary.getByRole("heading", { name: heading })).toBeVisible();
  await expect(summary.locator("strong").filter({ hasText: bold })).toBeVisible();
  await expect(summary.locator("li").first()).toBeVisible();
  const text = await summary.innerText();
  expect(text).not.toContain("#");
  expect(text).not.toContain("**");
  await expect(summary.getByText("another site")).toBeVisible();
  await expect(summary.getByText("a script")).toBeVisible();
  await expect(summary.getByRole("link", { name: "another site" })).toHaveCount(0);
  await expect(summary.getByRole("link", { name: "a script" })).toHaveCount(0);
  await expect(summary.locator('a[href^="javascript:"], a[href*="evil.example"]')).toHaveCount(0);
}

test("#556: a roadmap refresh's summary renders as Markdown and its unsafe links as text", async ({ page }) => {
  // protects=#556 item 1 for a non-digest kind; fails_when=the summary shows '#' or '**'
  // literally, has no heading or bold text, or draws a /\host or javascript: link;
  // no_claim=the ritual_summary flow's Markdown itself (api tests).
  await withScenario(page, "rituals", new Date("2026-10-23T12:00:00Z"));
  await login(page, APPROVER);
  await openRitual(page, "Monthly roadmap refresh");
  const summary = page.getByTestId("occurrence-summary");
  await summary.getByRole("button", { name: "Summarize with Oracle" }).click();
  await expectMarkdown(summary, "What to discuss first", "Usage alerts PRD");
  await expect(summary.getByRole("link", { name: "roadmap run" })).toHaveAttribute("href", "/runs");
});

test("#556: a metrics review's summary renders as Markdown and its unsafe links as text", async ({ page }) => {
  // protects=#556 item 1 for the metrics review (Explain with Oracle); fails_when=as above;
  // no_claim=the metrics_variance flow's Markdown itself.
  await withScenario(page, "metrics", new Date("2026-10-19T12:00:00Z"));
  await login(page, APPROVER);
  await openRitual(page, "Weekly metrics review");
  const summary = page.getByTestId("occurrence-summary");
  await summary.getByRole("button", { name: "Explain with Oracle" }).click();
  await expectMarkdown(summary, "Weekly metrics review", "Weekly active teams");
});
