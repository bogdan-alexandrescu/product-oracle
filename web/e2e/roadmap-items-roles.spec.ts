import { expect, test, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, openSeeded, seedRoadmapReview, signOut } from "./helpers";

// D1 Roadmap items review, by role (c6 Who may stage): commenters suggest, approvers stage and
// decide, viewers read. The seeded roadmap review run on the mock.

const RUN = ROADMAP_REVIEW_RUN.run.id;
const CP = ROADMAP_REVIEW_RUN.run.checkpoints[0].id;
const SCREEN = `/runs/${RUN}/review/${CP}`;
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const bar = (page: Page) => page.getByTestId("decision-bar");

// Card commenter: protects = criterion 10, a commenter's fix is a suggestion ("Suggested by
// you"), with no Approve or Send back and "An approver decides"; the approver then sees it with
// Stage and Dismiss, and Stage makes it count; fails_when = a commenter stages or decides, or the
// approver cannot stage it; no_claim = polling latency.
test("a commenter suggests; the approver stages the suggestion", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto(SCREEN);
  const slack = row(page, "slack-alerts");
  const fix = slack.getByRole("button", { name: "Remove date", exact: true });
  await expect(fix).toHaveAttribute("title", "Suggest: an approver stages it");
  await fix.click();
  await expect(slack.getByTestId("suggested-by")).toHaveText(/Suggested by you/);
  await expect(bar(page).getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Send back to agents" })).toHaveCount(0);
  await expect(bar(page)).toContainText("An approver decides");
  await row(page, "usage-export").getByRole("button", { name: "More actions for Usage export" }).click();
  await expect(page.getByRole("menuitem", { name: "Waive…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(SCREEN);
  const suggested = row(page, "slack-alerts").getByTestId("suggested-by");
  await expect(suggested).toHaveText(/Suggested by Commenter: Remove date/);
  await expect(row(page, "slack-alerts").getByRole("button", { name: "Dismiss" })).toBeVisible();
  await row(page, "slack-alerts").getByRole("button", { name: "Stage" }).click();
  await expect(row(page, "slack-alerts").getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 of 10 handled");
});

// Card ask: protects = criterion 11, Ask a teammate picks a member and asks; the row reads
// "Asked {name}" and the tally waits on them; the asked member's Inbox has the question (C2's
// existing row) and answering it there turns the row to "Answered" with the answer in the
// inspector; fails_when = no question is staged, the row does not say who, the Inbox lacks it,
// or the answer does not come back; no_claim = notifications.
test("Ask a teammate: the row shows who was asked; the member answers from the Inbox", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await row(page, "cost-forecast").getByRole("button", { name: "More actions for Cost forecast" }).click();
  await page.getByRole("menuitem", { name: "Ask a teammate…" }).click();
  const form = page.getByTestId("form-ask");
  await form.getByLabel("Ask", { exact: true }).selectOption({ label: "Commenter" });
  await form.getByLabel("Question").fill("Can the forecast wait for Next?");
  await form.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(row(page, "cost-forecast").getByTestId("asked-chip")).toHaveText("Asked Commenter");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 waiting on Commenter");

  // The asked member's Inbox: the existing questions row, answered in place.
  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const asked = page.locator("tr[data-row]").filter({ hasText: "Can the forecast wait for Next?" }).filter({ visible: true });
  await expect(asked).toHaveCount(1);
  await expect(asked).toContainText("asks");
  await asked.getByRole("button", { name: "Answer" }).click();
  await page.getByRole("textbox", { name: "Your answer" }).fill("Yes, Next is fine");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByTestId("question-settled")).toBeVisible();

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(SCREEN);
  await expect(row(page, "cost-forecast").getByTestId("asked-chip")).toHaveText("Answered");
  await row(page, "cost-forecast").locator('[data-phone="title"]').click();
  const insp = page.getByTestId("roadmap-item-inspector");
  await insp.getByRole("group", { name: "Inspector tab" }).getByRole("button", { name: "History" }).click();
  await expect(insp).toContainText("Answer: Yes, Next is fine");
});

// Card viewer: protects = #370, a viewer reads the screen with no buttons that change it;
// fails_when = a fix, Approve or Send back is drawn; no_claim = the API's refusals.
test("a viewer reads the review with no buttons", async ({ page }) => {
  await login(page, "viewer@example.com");
  await openSeeded(page, seedRoadmapReview, SCREEN);
  await expect(row(page, "slack-alerts")).toContainText("Date unverified");
  await expect(row(page, "slack-alerts").getByRole("button", { name: "Remove date", exact: true })).toHaveCount(0);
  await expect(bar(page).getByTestId("decision-tally")).toContainText("0 of 10 handled");
  await expect(bar(page).getByRole("button", { name: /^Approve/ })).toHaveCount(0);
});
