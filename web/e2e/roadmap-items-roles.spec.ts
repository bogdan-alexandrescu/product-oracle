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
  await expect(suggested).toHaveText(/Suggested by Theo Brandt: Remove date/);
  await expect(row(page, "slack-alerts").getByRole("button", { name: "Dismiss" })).toBeVisible();
  await row(page, "slack-alerts").getByRole("button", { name: "Stage" }).click();
  await expect(row(page, "slack-alerts").getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 of 10 handled");
});

// Card two-reviewers: protects = criterion 10 with both people at once: the approver's review
// screen stays open while a commenter, signed in on a second tab of their own, suggests a fix;
// the approver's page shows it within one poll (10 s) with Stage and Dismiss, without a reload,
// and Stage makes it count; fails_when = the suggestion needs a reload or a sign-in to show,
// shows as staged, or Stage does not count it; no_claim = polling latency against the real API.
// The mock's data is one browser context's localStorage, so the second person is a second
// tab of it with its own sign-in (lib/api/mock/server.ts tab sessions).
test("an approver's open review shows a commenter's suggestion within one poll", async ({ page, context }) => {
  await login(page, "approver@example.com");
  await openSeeded(page, seedRoadmapReview, SCREEN);
  const mine = row(page, "slack-alerts");
  await expect(mine.getByRole("button", { name: "Remove date", exact: true })).toBeVisible();
  await expect(mine.getByTestId("suggested-by")).toHaveCount(0);

  // The commenter, on a second tab that opens signed in as the approver.
  const other = await context.newPage();
  await other.goto("/home");
  await signOut(other);
  await login(other, "commenter@example.com");
  await other.goto(SCREEN);
  const theirs = row(other, "slack-alerts");
  await theirs.getByRole("button", { name: "Remove date", exact: true }).click();
  await expect(theirs.getByTestId("suggested-by")).toHaveText(/Suggested by you/);

  // The approver's page was never reloaded: the next poll brings the suggestion.
  await expect(mine.getByTestId("suggested-by")).toHaveText(/Suggested by Theo Brandt: Remove date/, { timeout: 12_000 });
  await expect(mine.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await mine.getByRole("button", { name: "Stage" }).click();
  await expect(mine.getByTestId("row-done")).toHaveText(/✓ Date removed/);
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 of 10 handled");
  // The commenter's tab is still the commenter's.
  await other.reload();
  await expect(bar(other)).toContainText("An approver decides");
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
  await form.getByLabel("Ask", { exact: true }).selectOption({ label: "Theo Brandt" });
  await form.getByLabel("Question").fill("Can the forecast wait for Next?");
  await form.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(row(page, "cost-forecast").getByTestId("asked-chip")).toHaveText("Asked Theo Brandt");
  await expect(bar(page).getByTestId("decision-tally")).toContainText("1 waiting on Theo Brandt");

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
