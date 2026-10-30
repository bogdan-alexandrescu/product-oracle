import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/**
 * F4 Engineering review stop, lane A (issue #181, review fix 1): the Engineering check of
 * Baseline to PRD, on by default in the Draft with Oracle sheet, waits for the engineering
 * lead, who works it on its own review screen. On the mock layer, driven as a person would.
 *
 * Test cards:
 * - "sheet toggle" (AC18): protects=the stop on by default with its help, in the estimate;
 *   fails_when=the switch is missing, unchecked, or unchecking it does not lower the estimate
 *   by $5.00; no_claim=the Engineering dates stop (lane B).
 * - "lead decides" (AC19-21): protects=the Inbox row, Review, Approve gated on every verdict
 *   and the blocking answer, the notes Not feasible and With changes need, a changed size in
 *   the Baseline; fails_when=Approve opens early, the tally does not move, a verdict saves
 *   without its note, or the run does not move on to the priority order; no_claim=the API's
 *   prompts to the prioritizer (api/tests/test_eng_review_stop.py).
 * - "started from the UI" (fix 1): protects=a run started in the sheet passes the stop through
 *   the UI; fails_when=its check has no briefs or no way to Approve; no_claim=the real agents.
 * - "approver, lead named" (AC24, Train N owner 2026-10-24): protects=who does not decide
 *   never sees Approve; the screen reads the review's own can_suggest (an approver who is not
 *   the lead suggests, as the API answers); fails_when=Approve or Send back shows, the
 *   waits-for line is missing, or the screen hides Suggest the API allows; no_claim=the API's
 *   rule (api/tests/test_eng_review_screen.py).
 * - "can_suggest false" (Train N): protects=a role the review answers can_suggest false for
 *   (the mock role viewer) reads the screen with no verdict or size controls; fails_when=it
 *   is offered Suggest; no_claim=other roles.
 * - "inspector per feature" (fix 2): protects=a note half typed for one feature stays with it;
 *   fails_when=selecting another feature keeps the open note, so Save verdict would save it
 *   against that feature; no_claim=the verdict route (api/tests/test_eng_review_stop.py).
 * - "check once" (fix 2): protects=the run page names the check on its line only, and the
 *   lead's Waiting chip counts it; fails_when=a non-decider sees it twice (a chip and the line)
 *   or the lead's row has no Waiting chip; no_claim=other stops' rows.
 * - "commenter suggests" (fix 2, AC6): protects=a commenter suggests from the screen, an
 *   approver (no lead named) stages it, the screen names only who decides; fails_when=the
 *   commenter has no controls, a suggestion counts before it is staged, or the screen says it
 *   waits for a lead nobody is; no_claim=AC24's approver with a lead named.
 * - "phone" (AC26): protects=the screen at 390 px; fails_when=rows are not cards, the decision
 *   bar is off screen, or the page scrolls sideways; no_claim=other phone layouts.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const row = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const inspector = (page: Page) => page.getByTestId("brief-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Draft with Oracle" });

async function briefToSheet(page: Page, title: string) {
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Buyers drop off when the total shows up late in checkout.");
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(sheet(page)).toBeVisible();
}

async function verdict(page: Page, key: string, choice: string, note?: string) {
  await row(page, key).getByRole("button").first().click();
  await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: choice, exact: true }).click();
  if (note != null) {
    const save = inspector(page).getByRole("button", { name: "Save verdict" });
    await expect(save).toBeDisabled();
    await inspector(page).getByRole("textbox").first().fill(note);
    await save.click();
  }
  await expect(row(page, key).getByTestId("brief-verdict")).toHaveText(choice);
}

async function openCheckAsLead(page: Page) {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await expect(inboxRow.getByTestId("checkpoint-label")).toHaveText("Engineering check · guided-onboarding · 3 features · 1 blocking");
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
}

test("sheet toggle: Engineering check is on with its help, and unchecking it lowers the estimate by $5.00", async ({ page }) => {
  await login(page, "approver@example.com");
  await briefToSheet(page, "Price shown early");
  const toggle = sheet(page).getByRole("switch", { name: "Engineering check" });
  await expect(toggle).toBeChecked();
  await expect(sheet(page).getByTestId("stop-help").filter({ hasText: "feasibility" })).toHaveText("The engineering lead checks feasibility and sizes before the priority order.");
  await sheet(page).getByRole("button", { name: "Estimate" }).click();
  await expect(sheet(page).getByTestId("draft-estimate")).toContainText("$29.50 estimated");
  await toggle.uncheck();
  await expect(sheet(page).getByTestId("draft-estimate")).toContainText("$24.50 estimated");
});

test("lead decides: Approve waits for every verdict and the blocking answer, then the run moves on with the new size", async ({ page }) => {
  await openCheckAsLead(page);
  const approve = bar(page).getByRole("button", { name: "Approve" });
  await expect(approve).toBeDisabled();
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("0 of 3 decided · 1 blocking question");
  await expect(row(page, "f.guided-setup").getByTestId("brief-questions")).toHaveText("2 open · 1 blocking");
  await expect(row(page, "f.guided-setup").getByTestId("brief-reasons")).toContainText("Blocking question unanswered");

  await verdict(page, "f.guided-setup", "Feasible");
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("1 of 3 decided · 1 blocking question");
  await verdict(page, "f.sample-data", "Feasible with changes", "Ship a smaller catalogue first");
  await verdict(page, "f.saved-carts", "Not feasible as scoped", "Needs a server-side cart store we do not have");
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("3 of 3 decided · 1 blocking question");
  await expect(approve).toBeDisabled();

  await row(page, "f.guided-setup").getByRole("button").first().click();
  await inspector(page).getByRole("textbox", { name: /^Answer: Does the payment sandbox/ }).fill("Yes, the sandbox takes test orders.");
  await inspector(page).getByRole("button", { name: "Answer" }).first().click();
  await expect(inspector(page).getByTestId("answer")).toContainText("Answered by");
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("3 of 3 decided");

  await row(page, "f.saved-carts").getByRole("button").first().click();
  await inspector(page).getByRole("group", { name: "Size" }).getByRole("button", { name: "XL" }).click();
  await expect(row(page, "f.saved-carts").getByTestId("brief-size")).toContainText("XL");
  // Nothing is lost on refresh: the choices are the shared draft's.
  await page.reload();
  await expect(row(page, "f.saved-carts").getByTestId("brief-verdict")).toHaveText("Not feasible as scoped");
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-priority").getByTestId("segment-state")).toHaveText("Running");
  await page.goto("/baseline");
  await page.getByTestId("feature-f.saved-carts").getByRole("button", { name: "Saved carts" }).click();
  await expect(page.getByRole("dialog", { name: "Saved carts" }).locator('[data-attr="effort"]')).toHaveText("XL");
});

test("started from the UI: a run from the sheet waits at its Engineering check and is approved there", async ({ page }) => {
  await login(page);
  await briefToSheet(page, "Faster checkout total");
  await sheet(page).getByRole("button", { name: "Estimate" }).click();
  await expect(sheet(page).getByTestId("draft-estimate")).toContainText("$29.50 estimated");
  await sheet(page).getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await page.getByRole("button", { name: "Refresh progress" }).click();
  const featureSet = page.getByTestId("segment-feature_set");
  await featureSet.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("segment-eng_review").getByTestId("segment-state")).toHaveText("Running");
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const line = page.getByTestId("segment-eng_review").getByTestId("review-screen-line");
  await expect(line).toContainText("3 features · 1 blocking");
  await line.getByRole("link", { name: "Review" }).click();

  for (const key of ["price-early", "guest-checkout", "saved-cards"]) await verdict(page, key, "Feasible");
  await row(page, "price-early").getByRole("button").first().click();
  await inspector(page).getByRole("textbox", { name: /^Answer:/ }).fill("Yes, within 150 ms.");
  await inspector(page).getByRole("button", { name: "Answer" }).click();
  await bar(page).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("segment-priority").getByTestId("segment-state")).toHaveText("Running");
});

test("approver, lead named: the screen suggests as the review's can_suggest says, never decides, and says who it waits for", async ({ page }) => {
  await withScenario(page, "eng-check");
  await login(page, "approver@example.com");
  await page.goto("/runs");
  await page.goto(`/runs/7a11c0de-0000-4000-8000-0000000000f4`);
  const line = page.getByTestId("segment-eng_review").getByTestId("review-screen-line");
  await expect(line).toContainText("Waits for the engineering lead");
  await line.getByRole("link", { name: "View" }).click();
  await expect(page.getByTestId("view-only")).toContainText("Suggestions only");
  await expect(page.getByTestId("view-only")).toContainText("Waits for the engineering lead");
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
  await expect(inspector(page).getByRole("group", { name: "Verdict" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Send back to architect" })).toHaveCount(0);
});

test("can_suggest false: a viewer (mock role) reads the screen with no Suggest", async ({ page }) => {
  await withScenario(page, "eng-check");
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, "viewer"] as const);
  await login(page, "approver@example.com");
  await page.goto(`/runs/7a11c0de-0000-4000-8000-0000000000f4`);
  const line = page.getByTestId("segment-eng_review").getByTestId("review-screen-line");
  await line.getByRole("link", { name: "View" }).click();
  await expect(page.getByTestId("view-only")).toContainText("View only");
  await expect(page.getByTestId("view-only")).not.toContainText("Suggestions only");
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
  await expect(inspector(page).getByRole("group", { name: "Verdict" })).toHaveCount(0);
  await expect(inspector(page).getByRole("group", { name: "Size" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("phone: at 390 px the rows are cards, the decision bar stays on screen and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheckAsLead(page);
  const first = await row(page, "f.guided-setup").boundingBox();
  const second = await row(page, "f.sample-data").boundingBox();
  expect(first && second && second.y >= first.y + first.height).toBeTruthy();
  await expect(bar(page).getByRole("button", { name: "Approve" })).toBeInViewport();
  await page.mouse.wheel(0, 2000);
  await expect(bar(page).getByRole("button", { name: "Approve" })).toBeInViewport();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

test("inspector per feature: a note typed for one feature never saves against another", async ({ page }) => {
  await openCheckAsLead(page);
  await row(page, "f.sample-data").getByRole("button").first().click();
  await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: "Feasible with changes", exact: true }).click();
  await inspector(page).getByRole("textbox", { name: "Note: what changes" }).fill("Ship a smaller catalogue first");
  await row(page, "f.saved-carts").getByRole("button").first().click();
  await expect(inspector(page)).toHaveAccessibleName("Brief: Saved carts");
  await expect(inspector(page).getByRole("textbox", { name: "Note: what changes" })).toHaveCount(0);
  await expect(inspector(page).getByRole("button", { name: "Save verdict" })).toHaveCount(0);
  await expect(row(page, "f.saved-carts").getByTestId("brief-verdict")).toHaveText("Decide");
});

test("check once: the lead's row says Waiting, an approver sees the check on its line only", async ({ page }) => {
  await withScenario(page, "eng-check");
  await login(page, "commenter@example.com");
  await page.goto("/runs/7a11c0de-0000-4000-8000-0000000000f4");
  const segment = page.getByTestId("segment-eng_review");
  await expect(segment.getByTestId("review-screen-line")).toContainText("Waiting for you");
  await expect(segment.getByTestId("checkpoint-waiting")).toBeVisible();
  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto("/runs/7a11c0de-0000-4000-8000-0000000000f4");
  await expect(segment.getByTestId("review-screen-line")).toHaveCount(1);
  await expect(segment.getByTestId("checkpoint-eng_review")).toHaveCount(0);
  await expect(segment.getByTestId("checkpoint-waiting")).toHaveCount(0);
});

test("commenter suggests: with no lead named a commenter suggests, an approver stages it, and the screen waits for an approver", async ({ page }) => {
  await withScenario(page, "eng-check-no-lead");
  await login(page, "commenter@example.com");
  await page.goto("/runs/7a11c0de-0000-4000-8000-0000000000f4");
  await page.getByTestId("segment-eng_review").getByTestId("review-screen-line").getByRole("link", { name: "View" }).click();
  await expect(page.getByTestId("view-only")).toContainText("Waits for an approver");
  await expect(page.getByTestId("view-only")).not.toContainText("engineering lead");
  await row(page, "f.sample-data").getByRole("button").first().click();
  await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: "Feasible", exact: true }).click();
  await expect(inspector(page).getByTestId("verdict-now")).toContainText("Feasible (suggested)");
  await expect(inspector(page).getByTestId("suggestion")).toContainText("Feasible");
  await expect(row(page, "f.sample-data").getByTestId("brief-verdict")).toHaveText("Decide");
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("0 of 3 decided · 1 blocking question");
  await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
  const screen = page.url();

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(screen);
  await row(page, "f.sample-data").getByRole("button").first().click();
  await inspector(page).getByTestId("suggestion").getByRole("button", { name: "Stage" }).click();
  await expect(row(page, "f.sample-data").getByTestId("brief-verdict")).toHaveText("Feasible");
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("1 of 3 decided · 1 blocking question");
});
