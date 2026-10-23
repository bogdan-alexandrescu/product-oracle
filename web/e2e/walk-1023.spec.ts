import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #505, the walk of 2026-10-23, driven through the UI on the mock layer as a person would.
 * #370: a control a role can never use is hidden (a commenter sees no track controls; an
 * approver sees them). #396: person words, no raw ids or field names (the goal drawer names
 * who locked a goal and labels its attributes and history). "Why it needs you" names what
 * changed once, with one count.
 */

const withScenario = (page: Page, scenario: string) =>
  page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);

const TRACK_CONTROLS = ["Rename", "Change owner", "Add milestone", "Check now", "Draft roadmap from this track", "Push to tracker"];

const track = (page: Page) => page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });

async function openPlan(page: Page, email: string) {
  await login(page, email);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(track(page)).toBeVisible();
}

// protects = a commenter's track card offers no control the API refuses them; fails_when = a
// commenter sees Rename, a status switch or an action they can never use.
test("a commenter on the Plan sees no track controls", async ({ page }) => {
  await openPlan(page, "commenter@example.com");
  const t = track(page);
  await expect(t.getByTestId("track-owner")).toBeVisible();
  for (const name of TRACK_CONTROLS) await expect(t.getByRole("button", { name })).toHaveCount(0);
  await expect(t.getByRole("group", { name: "Track status" })).toHaveCount(0);
  await expect(t).not.toContainText("needs the approver role");
  // The milestones stay readable.
  await expect(t.getByTestId("track-milestone").first()).toBeVisible();
});

// protects = an approver still has every track control; fails_when = hiding them for commenters
// hides them for approvers too.
test("an approver on the Plan sees the track controls", async ({ page }) => {
  await openPlan(page, "approver@example.com");
  const t = track(page);
  for (const name of TRACK_CONTROLS) await expect(t.getByRole("button", { name })).toBeEnabled();
  await expect(t.getByRole("group", { name: "Track status" })).toBeVisible();
});

// protects = the goal drawer names who locked it and labels its attributes and history in
// words; fails_when = "member 5e6b65ac", owner_text or "owner_confidence: 0.425 → 1" shows.
test("the goal drawer shows a person's name and labelled attributes and history", async ({ page }) => {
  await withScenario(page, "goal-words");
  await login(page, "commenter@example.com");
  await page.goto("/baseline");
  await page.getByTestId("goal-g.activation").getByRole("button", { name: "Raise activation" }).click();
  const d = page.getByRole("dialog", { name: "Raise activation" });

  const lock = d.getByTestId("lock-note");
  await expect(lock).toContainText("Locked by Approver");
  await expect(lock).not.toContainText("member");

  await expect(d.getByLabel("Attributes")).toBeVisible();
  const terms = await d.getByLabel("Attributes").locator("dt").allInnerTexts();
  expect(terms).toEqual(expect.arrayContaining(["Owner (as written)", "Target (as written)", "Horizon (as written)", "Owner confidence"]));
  for (const t of terms) expect(t).not.toContain("_");
  await expect(d.locator('[data-attr="owner_confidence"]')).toHaveText("100%");

  const history = d.getByTestId("entity-history").getByRole("listitem").first();
  await expect(history).toContainText("Owner confidence: 43% → 100%");
  await expect(history).not.toContainText("_");
});

// protects = "Why it needs you" says what changed once; fails_when = "42 baseline items changed;
// 11 baseline items changed" (two counts of one thing) shows.
test("Why it needs you names one count", async ({ page }) => {
  await openPlan(page, "approver@example.com");
  await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Daily alert digest email" }).first().click();
  const why = page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-why");
  await expect(why).toContainText("11 baseline items changed");
  await expect(why).not.toContainText("42 baseline items");
  await expect(why).not.toContainText(";");
});
