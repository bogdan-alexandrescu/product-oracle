import { expect, test, type Page } from "@playwright/test";

import { login, signOut } from "./helpers";

/**
 * C4 One New PRD door (issue #153): a short brief and a template, then Oracle asks its
 * questions and drafts. Every step is driven through the UI of the mock build.
 *
 * Test cards:
 * - "brief to draft" (criteria 7, 8): protects=one door from brief to a started run on the
 *   mock; fails_when=any step needs the Runs page, the brief's goal question is asked again,
 *   the sheet loses the template, or the run's details lack it; no_claim=the real cost estimate.
 * - "baseline choice" (criterion 8d): protects=B1 "Reuse base" in the sheet (reuse preselected,
 *   Rebuild one click away and $7.00 dearer, the Confirm the baseline stop only when rebuilding);
 *   fails_when=reuse is not the default, Rebuild does not raise the estimate by the baseline
 *   segment, or the stop shows while reusing; no_claim=the API's 30-day rule.
 * - "stale baseline" (criterion 8d): protects=a baseline that cannot be reused offers no reuse;
 *   fails_when=the reuse choice shows, or the reason is missing from the tooltip;
 *   no_claim=the other two reasons.
 * - "empty skeleton" (criterion 9): protects=the old Create draft path, moved under a quiet link
 *   for approvers; fails_when=it no longer makes an empty v1 or a commenter sees it;
 *   no_claim=the template picker's recommendations (new-draft.spec.ts).
 * - "commenter brief, approver finds it" (criterion 10): protects=commenters write briefs and
 *   approvers start drafts; fails_when=Continue is refused for a commenter, Draft with Oracle is
 *   enabled for them, or the brief is missing from PRDs › Ideas; no_claim=archived briefs.
 * - "New run points here" (criterion 11): protects=D12's one rule for Baseline to PRD;
 *   fails_when=the New run dialog still offers it or the pointer is missing or goes elsewhere;
 *   no_claim=the other flows' pointers.
 * - "phone" (criterion 12): protects=the door on a 390 px screen; fails_when=the page scrolls
 *   sideways or the recommendation sits beside the form; no_claim=other phone layouts.
 */

const PROBLEM = "Returning buyers retype their address at every checkout. Saved addresses would make repeat checkout faster.";

function answer(page: Page, question: string, option: string) {
  return page.getByRole("group", { name: question }).getByText(option, { exact: true }).click();
}

async function openDoor(page: Page) {
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
}

async function writeBrief(page: Page, title: string) {
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
}

async function continueToIntake(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  return page.url().split("/intakes/")[1];
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Draft with Oracle" });
const estimate = (page: Page) => sheet(page).getByTestId("draft-estimate");

test("brief to draft: goals, out of scope and a template, then Draft with Oracle starts the run", async ({ page }) => {
  await login(page, "approver@example.com");
  await openDoor(page);
  await writeBrief(page, "Saved addresses at checkout");

  const goals = page.getByRole("group", { name: "Which goals does it serve?" });
  await expect(goals.getByRole("checkbox")).toHaveCount(2);
  await expect(goals).toContainText("to go");
  await goals.getByRole("checkbox", { name: /Raise activation/ }).check();

  await page.getByRole("textbox", { name: "Out of scope 1" }).fill("Address book sharing between accounts");
  await page.getByRole("button", { name: "Add another" }).click();
  await expect(page.getByRole("textbox", { name: "Out of scope 2" })).toBeVisible();

  await expect(page.getByTestId("recommended-template")).toHaveText("Goal-traced PRD");
  await answer(page, "What should this document decide?", "Whether to start at all");
  await expect(page.getByTestId("recommended-template")).toHaveText("One-pager");

  await continueToIntake(page);
  await expect(page.getByRole("heading", { level: 1, name: "Saved addresses at checkout" })).toBeVisible();
  // The brief named its goal and its out-of-scope line: Oracle does not ask those again.
  await expect(page.getByTestId("intake-thread")).toBeVisible();
  await expect(page.getByTestId("intake-thread")).not.toContainText("Which confirmed company goal does this serve");
  await expect(page.getByTestId("intake-thread")).not.toContainText("What is deliberately out of scope");

  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("draft-template")).toContainText("One-pager");
  await expect(sheet(page).getByRole("group", { name: "Depth" }).getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true");
  const stops = sheet(page).getByRole("switch");
  await expect(stops).toHaveCount(3);
  for (const name of ["Feature set and dependencies", "Priority order", "PRD review"]) {
    await expect(sheet(page).getByRole("switch", { name })).toBeChecked();
  }

  await sheet(page).getByRole("button", { name: "Estimate" }).click();
  await expect(estimate(page)).toHaveText("Estimated $19.50");
  await sheet(page).getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(page.getByText("template one-pager")).toBeVisible();
});

test("baseline choice: reuse is preselected; Rebuild costs the baseline segment and lists its stop", async ({ page }) => {
  await login(page, "approver@example.com");
  await openDoor(page);
  await writeBrief(page, "Faster repeat checkout");
  await continueToIntake(page);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();

  const reuse = sheet(page).getByRole("radio", { name: /^Use the current baseline \(approved .+\)$/ });
  const rebuild = sheet(page).getByRole("radio", { name: "Rebuild it ($7.00)" });
  await expect(reuse).toBeChecked();
  await expect(rebuild).not.toBeChecked();
  await expect(sheet(page).getByRole("switch", { name: "Confirm the baseline" })).toHaveCount(0);

  await sheet(page).getByRole("button", { name: "Estimate" }).click();
  await expect(estimate(page)).toHaveText("Estimated $19.50");
  await rebuild.check();
  await expect(estimate(page)).toHaveText("Estimated $26.50");
  await expect(sheet(page).getByRole("switch", { name: "Confirm the baseline" })).toBeChecked();

  // Deep and rebuilding goes over $50: an owner approves before it starts.
  await sheet(page).getByRole("group", { name: "Depth" }).getByRole("button", { name: "Deep" }).click();
  await expect(estimate(page)).toContainText("Estimated $53.00");
  await expect(estimate(page)).toContainText("Needs an owner's approval before it starts");
  await expect(sheet(page).getByRole("radio", { name: "Rebuild it ($14.00)" })).toBeChecked();
});

test("stale baseline: only 'Oracle rebuilds the baseline first', with the reason in its tooltip", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "baseline-stale"));
  await login(page, "approver@example.com");
  await openDoor(page);
  await writeBrief(page, "Faster repeat checkout");
  await continueToIntake(page);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();

  await expect(sheet(page).getByRole("radio")).toHaveCount(0);
  await expect(sheet(page)).toContainText("Oracle rebuilds the baseline first");
  await sheet(page).getByRole("button", { name: "About the baseline" }).click();
  await expect(sheet(page).getByRole("tooltip")).toContainText("The last baseline review was approved 41 days ago");
  await expect(sheet(page).getByRole("switch", { name: "Confirm the baseline" })).toBeChecked();
  await sheet(page).getByRole("button", { name: "Estimate" }).click();
  await expect(estimate(page)).toHaveText("Estimated $26.50");
});

test("empty skeleton: the quiet link still creates an empty v1, and a commenter does not see it", async ({ page }) => {
  await login(page, "approver@example.com");
  await openDoor(page);
  await page.getByRole("textbox", { name: "Title" }).fill("Skeleton first PRD");
  await page.getByTestId("template-option-prd-rfc").click();
  await page.getByRole("button", { name: "Start from an empty skeleton instead" }).click();
  await expect(page).toHaveURL(/\/documents\/skeleton-first-prd$/);
  await expect(page.getByText("template prd-rfc v1")).toBeVisible();
  await signOut(page);

  await login(page, "commenter@example.com");
  await page.goto("/documents/new?kind=prd");
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start from an empty skeleton instead" })).toHaveCount(0);
});

test("commenter brief, approver finds it: Continue works, the draft waits for an approver, PRDs › Ideas lists it", async ({ page }) => {
  await login(page, "commenter@example.com");
  await openDoor(page);
  await writeBrief(page, "Gift wrapping at checkout");
  const id = await continueToIntake(page);
  const draft = page.getByRole("button", { name: "Draft with Oracle" });
  await expect(draft).toBeDisabled();
  await expect(draft).toHaveAttribute("title", "An approver starts the draft");
  await signOut(page);

  await login(page, "approver@example.com");
  await page.goto("/documents");
  await page.getByRole("button", { name: /^Ideas\s*\d+$/ }).click();
  const row = page.getByTestId("idea-row").filter({ hasText: "Gift wrapping at checkout" });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/\d+ questions? open|Ready to draft/);
  await row.getByRole("link", { name: "Gift wrapping at checkout" }).click();
  await expect(page).toHaveURL(new RegExp(`/intakes/${id}$`));
  await expect(page.getByRole("button", { name: "Draft with Oracle" })).toBeEnabled();
});

test("New run no longer offers Baseline to PRD and points at New PRD", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.getByRole("button", { name: "New run" }).click();
  // With no flow left to offer, the dialog is "Start a run": only the pointer lines (D12).
  const dialog = page.getByRole("dialog", { name: "Start a run" });
  await expect(dialog.getByTestId("flow-pointers")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Baseline to PRD" })).toHaveCount(0);
  const pointer = dialog.getByRole("link", { name: "New PRD · PRDs" });
  await expect(pointer).toHaveAttribute("href", "/documents/new?kind=prd");
  await pointer.click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
});

test("phone: at 390 px the New PRD form does not scroll sideways and the recommendation follows it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "approver@example.com");
  await page.goto("/documents/new?kind=prd");
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("button", { name: "Add another" }).click();
  await expect(page.getByTestId("recommended-template")).toHaveText("Goal-traced PRD");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const problem = await page.getByRole("textbox", { name: "What problem does it solve?" }).boundingBox();
  const panel = await page.getByTestId("recommendation-panel").boundingBox();
  expect(problem && panel && panel.y > problem.y + problem.height).toBeTruthy();
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
});
