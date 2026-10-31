import { expect, test, type Page } from "./test";

import { MOCK_GUIDE, MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { login } from "./helpers";

// QA pass 4, docs-share lane, the "public-interview" group: the roadmap's Public version page
// (Usage alerts roadmap: its items serve no confirmed goal, so its public page is empty), and
// the customer's interview page and the owner's interview page.

const PUBLIC = "/documents/usage-alerts-roadmap/public";
const LINK = `/i/${MOCK_INTERVIEW_TOKEN}`;

async function openPublic(page: Page, email?: string) {
  await login(page, email);
  await page.goto(PUBLIC);
}

const behaviour = (page: Page) => page.getByTestId("public-row").filter({ hasText: "Behaviour" });

test("qa4-docs-share-9: the guide names the real blocker, items with no confirmed goal, and links to where to set it", async ({ page }) => {
  await openPublic(page);
  const next = page.getByTestId("public-next");
  await expect(next).toContainText("Next, step 1 of 3:");
  await expect(next).toContainText(/No item serves a confirmed goal|serves? no confirmed goal/);
  await expect(next).not.toContainText("Approve at least one item's public text");
  const link = next.getByRole("link", { name: "Link items to goals" });
  await expect(link).toHaveAttribute("href", "/baseline?tab=flagged");
  // Each left-out item says how to fix it too.
  await expect(behaviour(page).getByRole("link", { name: "Link it to a goal" })).toHaveAttribute("href", "/baseline?tab=flagged");

  // Draft public texts says why nothing was drafted, not that every item already has a text.
  await page.getByRole("button", { name: "Draft public texts" }).click();
  const status = page.getByTestId("public-draft");
  await expect(status).toHaveText("No item serves a confirmed goal, so there was nothing to draft. Link items to a goal in Baseline first.");
  await expect(status).not.toContainText("already has a public text");

  await link.click();
  await expect(page).toHaveURL(/\/baseline\?tab=flagged$/);
});

test("qa4-docs-share-47: the To approve count matches the rows with an Approve button", async ({ page }) => {
  await openPublic(page);
  const rows = page.getByTestId("public-row");
  await expect(rows.first()).toBeVisible();
  const toApprove = page.getByRole("radiogroup", { name: "Filter" }).getByRole("radio", { name: /To approve/ });
  await expect(toApprove).toHaveText(/To approve\s*0/);
  // No row offers an Approve the count leaves out.
  await expect(rows.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("qa4-docs-share-48: an item with no text has one control to write it, and its stage starts from its horizon", async ({ page }) => {
  await openPublic(page);
  const row = behaviour(page);
  await expect(row.getByText("No public text yet.")).toBeVisible();
  await expect(row.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await row.getByRole("button", { name: "Write text" }).click();
  // Behaviour is a Now item: its stage starts at In progress, not Exploring.
  await expect(row.getByLabel("Stage")).toHaveValue("in_progress");
});

test("qa4-docs-share-49: the preview's footer is one plain sentence", async ({ page }) => {
  await openPublic(page);
  const preview = page.frameLocator('iframe[title="Public page preview"]');
  await expect(preview.getByText("On a shared link, this shows when it was shared and when it ends.")).toBeVisible();
  await expect(preview.getByText(/ends here/)).toHaveCount(0);
});

test("qa4-docs-share-50: a viewer's locked page has one way back to the roadmap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPublic(page, "viewer@example.com");
  const locked = page.getByTestId("public-check-locked");
  await expect(locked).toContainText("Only an approver or owner can check the Public version");
  await expect(page.getByRole("link", { name: "Back to the roadmap" })).toHaveCount(1);
  await locked.getByRole("link", { name: "Back to the roadmap" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap$/);
});

async function startInterview(page: Page) {
  await page.goto(LINK);
  await expect(page.getByTestId("interview-company")).toHaveText("Example Co");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("msg-oracle").last()).toContainText(MOCK_GUIDE[0].prompt);
}

test("qa4-docs-share-59: a skipped question is marked Skipped in the conversation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startInterview(page);
  await expect(page.getByTestId("msg-skipped")).toHaveCount(0);
  await page.getByRole("button", { name: "Skip this question" }).click();
  await expect(page.getByTestId("msg-oracle").last()).toContainText(MOCK_GUIDE[1].prompt);
  const skipped = page.getByTestId("msg-skipped");
  await expect(skipped).toHaveCount(1);
  await expect(skipped).toHaveText("Skipped");
});

test("qa4-docs-share-60: a hint under the answer box says which keys send", async ({ page }) => {
  await startInterview(page);
  const box = page.getByTestId("interview-input");
  const hint = page.getByTestId("interview-hint");
  await expect(hint).toHaveText(/^(Ctrl|Cmd)\+Enter to send$/);
  await expect(box).toHaveAccessibleDescription(/\+Enter to send/);
});

test("qa4-docs-share-61: the person who finished sees a thank-you under the company's name on reload", async ({ page }) => {
  await startInterview(page);
  await page.getByTestId("interview-footer").getByRole("button", { name: "Finish interview" }).click();
  await page.getByRole("alertdialog", { name: "Finish interview" }).getByRole("button", { name: "Finish interview" }).click();
  await expect(page.getByTestId("interview-thanks")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("interview-company")).toHaveText("Example Co");
  await expect(page.getByTestId("interview-refused")).toHaveText("You've finished this interview, thank you.");
  await expect(page.getByText("This link has already been used")).toHaveCount(0);
});

test("qa4-docs-share-63: an unopened interview tells the owner to make a new link, not to send the old one", async ({ page }) => {
  await login(page);
  await page.goto("/requests/interviews");
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  const empty = page.getByTestId("interview-transcript-empty");
  await expect(empty).toHaveText("Ana Lima hasn't opened the link yet. If you didn't send it, make a new link.");
  await expect(empty).not.toContainText("Send it to them");
});
