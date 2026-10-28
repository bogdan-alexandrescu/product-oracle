import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_SLOW_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Review minors on Plan (qa-plan-25, qa-plan-32, qa-plan-17, outcomes' Add learning and its
 * Escape key, the milestone-vs-rename Escape mismatch, and Alignment report/latest's capsReady
 * race), driven through the UI on the mock layer as a person would.
 */

const track = (page: Page) => page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });

async function openPlan(page: Page) {
  await login(page);
  await page.goto("/plan");
  await expect(rows(page).first()).toBeVisible();
}

// qa-plan-25: every Plan tab's page is titled "Plan", the strip's own word for the section,
// not "Alignment report(s)" (the Reports tab's own name for itself, kept for the tab label
// and the list's panel title, not the page's H1).
test("qa-plan-25: the Reports list and 'no report yet' page are titled Plan, like every other Plan tab", async ({ page }) => {
  await login(page);
  await page.goto("/plan/reports");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan");
  await expect(page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-reports")).toHaveAttribute("aria-current", "page");

  await page.goto("/plan/reports/latest");
  await expect(page.getByTestId("no-report-yet").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan");
});

// qa-plan-32: a PRD card's Journey bar, on the Plan, names its own last step in Plan's words
// ("Approved": the roadmap's stage_label for the same card) instead of the PRD journey's own
// last step ("Publish"), which belongs to the PRD's review header and Inspector, not here.
test("qa-plan-32: a Plan PRD card's journey ends at Approved, not Publish", async ({ page }) => {
  await openPlan(page);
  const card = page.getByTestId("plan-prd-card").filter({ hasText: "Usage alerts" });
  await expect(card).toHaveAttribute("data-stage", "approved");
  const labels = card.getByTestId("journey-labels");
  await expect(labels).toContainText("Approved");
  await expect(labels).not.toContainText("Publish");
  await expect(labels.locator("b")).toHaveText("Approved");
});

// qa-plan-17: an item's own history and the Documents tab must agree on whether the roadmap
// behind it is approved. Before the fix, every item's History said "approved Oct 18" for a
// roadmap the Documents tab, in the same company, says was never approved ("In review").
test("qa-plan-17: an item's history agrees with the Documents tab about the roadmap's approval", async ({ page }) => {
  await openPlan(page);
  await rows(page).filter({ hasText: "Threshold alerts on spend" }).getByTestId("plan-title").click();
  const history = inspector(page).getByTestId("plan-history").getByTestId("plan-history-version");
  await expect(history).toHaveText(["PRD v1 Now · in a draft"]);
  await expect(history).not.toContainText("approved");

  await page.goto("/plan/documents");
  const row = page.getByTestId("roadmap-row").first();
  await expect(row).toContainText("In review");
  await expect(row.getByTestId("roadmap-approved-version")).toHaveCount(0);
});

// qa-plan-30 (the rename/milestone mismatch): the rename form must stop its Escape from
// bubbling, as the milestone form already does (web/app/plan/_tracks.tsx), so cancelling a
// rename never also reaches a page-wide Escape listener (InfoTip's and the Ask Oracle panel's
// among them) meant for something else entirely.
test("qa-plan-30: Escape on Rename track cancels the rename without reaching the rest of the page", async ({ page }) => {
  await openPlan(page);
  const t = track(page);
  await t.getByRole("button", { name: "Rename" }).click();
  await t.getByLabel("Track title").fill("Something else");

  // Nothing above the form sees this key: document never gets the event (the milestone
  // editor's own Escape handler already stops it the same way).
  await page.evaluate(() => {
    (window as unknown as { __escapeSeenAtDocument?: boolean }).__escapeSeenAtDocument = false;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") (window as unknown as { __escapeSeenAtDocument?: boolean }).__escapeSeenAtDocument = true;
      },
      { once: true },
    );
  });
  await t.getByLabel("Track title").press("Escape");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __escapeSeenAtDocument?: boolean }).__escapeSeenAtDocument)).toBe(false);

  await expect(t.getByLabel("Track title")).toHaveCount(0);
  await expect(t).toContainText("Usage alerts PRD");
});

// web/app/plan/reports/latest/page.tsx: `can` reads false until the viewer's capabilities
// load, so the page must wait on that too before choosing which branch (and which words) to
// show - an owner must never flash the viewer's "An owner can generate one now." with no button.
test("latest report: waits for capabilities before saying who can generate one", async ({ page }) => {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SLOW_KEY, "/v1/me/capabilities"] as const);
  await login(page);
  await page.goto("/plan/reports/latest");
  const none = page.getByTestId("no-report-yet").filter({ visible: true });
  // Still waiting on capabilities: neither branch has shown yet (an owner reading the
  // viewer's words, with no button, is exactly the bug).
  await expect(none).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate now" })).toHaveCount(0);
  // Once capabilities land, the owner's own words and button show.
  await expect(none).toContainText("You can generate one now for the week so far.", { timeout: 10000 });
  await expect(none.getByRole("button", { name: "Generate now" })).toBeVisible();
});

// Outcomes' Add learning: Escape only asks before dropping typed text when it is not an open
// select or listbox closing itself (which must not cost the person their draft).
test("Add learning: Escape on an open select just closes it; elsewhere it asks before discarding", async ({ page }) => {
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByRole("button", { name: "Add learning" }).click();
  const form = page.getByTestId("learning-form");
  await form.getByLabel("Learning").fill("Onboarding confuses new admins");

  // Escape while the "Applies to" select has focus: no question, nothing lost.
  await form.getByLabel("Applies to").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Learning")).toHaveValue("Onboarding confuses new admins");

  // Escape on the text itself asks first, and Back keeps the draft.
  await form.getByLabel("Learning").press("Escape");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Discard this learning?");
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Learning")).toHaveValue("Onboarding confuses new admins");

  // Confirming the question does drop it.
  await form.getByLabel("Learning").press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard learning" }).click();
  await expect(form).toHaveCount(0);
});

// Outcomes' Add learning: when the quality checks list fails to load, that kind of learning
// is not simply unavailable - the key can be typed by hand, with a short note why.
test("Add learning: a failed quality-checks list still lets you type the key, with a note", async ({ page }) => {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_FAIL_KEY, "/v1/quality/criteria"] as const);
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByRole("button", { name: "Add learning" }).click();
  const form = page.getByTestId("learning-form");

  await form.getByLabel("Applies to").selectOption({ label: "Quality check" });
  await expect(form.getByText("The list did not load; type its key.")).toBeVisible();
  const key = form.getByTestId("learning-target-key");
  await expect(key).toBeVisible();
  await key.fill("clarity");
  await expect(key).toHaveValue("clarity");

  // A kind whose list did load still offers the pick list, not the fallback.
  await form.getByLabel("Applies to").selectOption({ label: "Question topic" });
  await expect(form.getByTestId("learning-target-key")).toHaveCount(0);
});
