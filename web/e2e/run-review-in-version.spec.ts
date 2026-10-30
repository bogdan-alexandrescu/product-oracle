import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { RUN_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, openSection, signOut } from "./helpers";

/**
 * D10 One review place: a run's PRD review is decided in the version its draft made. Decide
 * (Inbox, runs list) opens the version with the run review bar; the run page only links to
 * it. On the mock layer ("run-review" scenario: a Baseline to PRD run waiting at its PRD
 * review of usage-alerts v2, three sections), driven as a person would. Each test states its
 * card: protects / fails_when / no_claim.
 */

const VERSION = "/documents/usage-alerts/v/2";
const KEYS = ["title", "behaviour", "metrics"];
const bar = (page: Page) => page.getByTestId("run-review-bar").filter({ visible: true });
const barText = (page: Page) => bar(page).getByTestId("run-review-text");

async function start(page: Page, email?: string) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"]);
  await login(page, email);
}

async function approveSection(page: Page, key: string) {
  const review = (await openSection(page, key)).getByTestId("review-bar");
  await review.getByRole("button", { name: "Approve" }).click();
  await review.getByTestId("verdict-submit").click();
  await expect(review.getByTestId("verdict-state")).toContainText("Approved");
}

test("Decide in the Inbox and the runs list opens the version with the run review bar", async ({ page }) => {
  // protects=AC2, Decide lands in the version; fails_when=Decide opens the run page or the bar
  // misreads the review; no_claim=the API's matching rule (api/tests/test_run_review_link.py).
  await start(page);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Usage alerts" });
  await row.getByRole("link", { name: "Decide" }).click();
  await expect(page).toHaveURL(new RegExp(`${VERSION}\\?run_review=`));
  await expect(barText(page)).toHaveText("Run review · Baseline to PRD · draft v2 · 0 of 3 sections reviewed");

  await page.goto("/runs");
  const listed = page.getByTestId("run-row").filter({ hasText: "Usage alerts" }).filter({ has: page.getByRole("button", { name: "Decide" }) });
  await listed.getByRole("button", { name: "Decide" }).click();
  await expect(page).toHaveURL(new RegExp(`${VERSION}\\?run_review=`));
  await expect(bar(page)).toBeVisible();
});

test("approving the last section approves the run review", async ({ page }) => {
  // protects=AC3, the review decides it on its own; fails_when=the run still waits once every
  // section is approved; no_claim=the audit's via (API test).
  await start(page);
  await page.goto(VERSION);
  for (const key of KEYS.slice(0, -1)) await approveSection(page, key);
  await expect(barText(page)).toContainText("2 of 3 sections reviewed");
  await expect(bar(page).getByRole("button", { name: "Approve draft" })).toBeVisible();
  await approveSection(page, KEYS[KEYS.length - 1]);
  await expect(barText(page)).toContainText("3 of 3 sections reviewed · Approved");
  await expect(bar(page).getByRole("button", { name: "Approve draft" })).toHaveCount(0);
  await page.goto(`/runs/${RUN_REVIEW_RUN}`);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Succeeded");
});

test("Approve draft with unreviewed sections asks once, naming how many; Cancel decides nothing", async ({ page }) => {
  // protects=AC5, the "Unreviewed" decision (allowed, with a confirmation); fails_when=no
  // confirmation, a wrong count, Cancel decides, or the sections lose their state;
  // no_claim=F4's Engineering dates continuation.
  await start(page);
  await page.goto(VERSION);
  await approveSection(page, "title");
  await bar(page).getByRole("button", { name: "Approve draft" }).click();
  const confirm = bar(page).getByRole("group", { name: "Confirm Approve draft" });
  await expect(confirm).toContainText("2 sections aren't reviewed yet. The run's review ends; they stay open for review and the next draft.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(barText(page)).not.toContainText("Approved");

  await bar(page).getByRole("button", { name: "Approve draft" }).click();
  await bar(page).getByRole("group", { name: "Confirm Approve draft" }).getByRole("button", { name: "Approve draft" }).click();
  await expect(barText(page)).toContainText("1 of 3 sections reviewed · Approved");
  // The unreviewed sections keep their state.
  await expect((await openSection(page, "metrics")).getByTestId("verdict-state")).toHaveText("Not reviewed");
});

test("Send back lists what goes, refuses an empty send-back and sends a note", async ({ page }) => {
  // protects=AC6/AC7 (UI part), the document's feedback is the change request; fails_when=the
  // counts are wrong, nothing open is sent, or a note alone is refused; no_claim=the review
  // file's content and workflow findings (API tests).
  await start(page);
  await page.goto(VERSION);
  await bar(page).getByRole("button", { name: "Send back to agents" }).click();
  const sheet = page.getByTestId("send-back-sheet");
  await expect(sheet.getByTestId("send-back-counts")).toHaveText(
    "0 open feedback items · 0 staged changes · 0 sections with Request changes or Reject",
  );
  await sheet.getByRole("button", { name: "Send back", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("Nothing to send back");
  await sheet.getByLabel("Note to the agents (optional)").fill("Name who receives the alerts.");
  await sheet.getByRole("button", { name: "Send back", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(barText(page)).toContainText("Sent back to agents");
});

test("a send-back is the structured review of the document's feedback, shown on the run page", async ({ page }) => {
  // protects=#168 fixes 1, the send-back is D4's structured review file; fails_when=the run
  // page shows no sent review, or review.yaml is not the document's feedback with the note;
  // no_claim=the workflow findings (api/tests/test_run_review_link.py).
  await start(page);
  await page.goto(VERSION);
  await openSection(page, "behaviour");
  const panel = page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
  // qa-docs-33: whole-draft feedback goes through the header's Discuss.
  await page.getByTestId("doc-discuss").click();
  const startForm = page.getByTestId("start-discussion").filter({ visible: true });
  await startForm.getByRole("textbox", { name: "First message" }).fill("Say who gets the first alert.");
  await startForm.getByRole("button", { name: "Start discussion" }).click();
  await page.getByTestId("discussion-thread").filter({ visible: true }).getByRole("button", { name: "All feedback" }).click();
  await expect(panel.getByTestId("feedback-item").filter({ hasText: "Say who gets the first alert." })).toHaveCount(1);
  await page.reload();
  await bar(page).getByRole("button", { name: "Send back to agents" }).click();
  const sheet = page.getByTestId("send-back-sheet");
  await expect(sheet.getByTestId("send-back-counts")).toContainText("1 open feedback item");
  await sheet.getByLabel("Note to the agents (optional)").fill("Keep it short.");
  await sheet.getByRole("button", { name: "Send back", exact: true }).click();
  await expect(barText(page)).toContainText("Sent back to agents");

  await page.goto(`/runs/${RUN_REVIEW_RUN}`);
  const sent = page.getByTestId("sent-review").filter({ visible: true });
  await expect(sent).toContainText("Sent back · 1 entry · View review");
  await sent.getByRole("button", { name: "View review" }).click();
  const file = sent.getByTestId("sent-review-yaml");
  await expect(file).toContainText("# Review of prd.md");
  await expect(file).toContainText("checkpoint: prd_review");
  await expect(file).toContainText("section: general");
  await expect(file).toContainText("Say who gets the first alert.");
  await expect(file).toContainText("general_note: Keep it short.");
  await expect(file).toContainText("locked_sections:");
});

test("the run page waits for the review in the version, with no note box", async ({ page }) => {
  // protects=AC8, one review place; fails_when=the run page still decides the PRD review;
  // no_claim=a draft refused at import (web/e2e/runs-sent-back.spec.ts keeps that).
  await start(page);
  await page.goto(`/runs/${RUN_REVIEW_RUN}`);
  const panel = page.getByTestId("checkpoint-prd_review").filter({ visible: true });
  await expect(panel.getByTestId("run-review-summary")).toHaveText("Waiting for review of v2 · 0/3 sections reviewed");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await panel.getByRole("link", { name: "Open review" }).click();
  await expect(page).toHaveURL(new RegExp(`${VERSION}\\?run_review=`));
  await expect(bar(page)).toBeVisible();
});

test("a commenter reads the run review without deciding it", async ({ page }) => {
  // protects=AC11, approvers decide; fails_when=a commenter sees Approve draft or Send back;
  // no_claim=the API's 403 on decide.
  await start(page, "commenter@example.com");
  await page.goto(VERSION);
  await expect(barText(page)).toHaveText("Run review · Baseline to PRD · draft v2 · 0 of 3 sections reviewed");
  await expect(bar(page)).toContainText("An approver decides");
  await expect(bar(page).getByRole("button")).toHaveCount(0);
});

test("only the designated decider approves or sends back the run review; others see who decides", async ({ page }) => {
  // protects=the review policy's designated decider (as document review: one decider per
  // decision); fails_when=another approver or an owner sees Approve draft or Send back, or the
  // bar does not name the decider; no_claim=the API's 403 (api/tests/test_run_review_link.py).
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review-decider"]);
  await login(page);
  await page.goto(VERSION);
  await expect(barText(page)).toHaveText("Run review · Baseline to PRD · draft v2 · 0 of 3 sections reviewed");
  await expect(bar(page)).toContainText("Approver decides (designated decider)");
  await expect(bar(page).getByRole("button")).toHaveCount(0);

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(VERSION);
  await expect(bar(page).getByRole("button", { name: "Send back to agents" })).toBeVisible();
  await bar(page).getByRole("button", { name: "Approve draft" }).click();
  await bar(page).getByRole("group", { name: "Confirm Approve draft" }).getByRole("button", { name: "Approve draft" }).click();
  await expect(barText(page)).toContainText("0 of 3 sections reviewed · Approved");
});

test("with a designated decider, someone else's last section approval leaves the run review waiting for the decider", async ({ page }) => {
  // protects=owner decision 2026-10-22: the last section's approval approves the run review only
  // when the designated decider gave it; fails_when=an owner approving every section approves the
  // run review, or the bar does not say it waits for the decider; no_claim=the API's rule
  // (api/tests/test_run_review_link.py).
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review-decider"]);
  await login(page);
  await page.goto(VERSION);
  for (const key of KEYS) await approveSection(page, key);
  await expect(barText(page)).toHaveText("Run review · Baseline to PRD · draft v2 · 3 of 3 sections reviewed");
  await expect(bar(page)).toContainText("Every section is approved · waits for Approver, the designated decider");
  await expect(bar(page).getByRole("button")).toHaveCount(0);

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto(VERSION);
  await expect(barText(page)).toHaveText("Run review · Baseline to PRD · draft v2 · 3 of 3 sections reviewed");
  await bar(page).getByRole("button", { name: "Approve draft" }).click();
  await expect(barText(page)).toContainText("3 of 3 sections reviewed · Approved");
});
