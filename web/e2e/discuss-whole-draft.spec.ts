import { expect, test, type Page } from "./test";

import { login, openSection, signOut } from "./helpers";

/*
 * qa-docs-33 "Merge into Discuss" (owner, 2026-10-29): the review panel has no "Comment on
 * the whole draft"; whole-draft feedback goes through the header's Discuss (on a phone, More's
 * Discuss). During a review an open thread's first message is whole-draft review feedback:
 * listed under General, counted in Open feedback and the approver's Inbox, as the old
 * comment was. A private thread stays a discussion. The API's rule:
 * api/tests/test_discuss_whole_draft.py.
 */
const DOC = "/documents/checkout-redesign/v/2";
const REMARK = "The goals don't match the problem statement.";
const PHONE = { width: 390, height: 844 };

const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const items = (page: Page) => panel(page).getByTestId("feedback-item");
const general = (page: Page) => panel(page).getByTestId("inspector-scope").getByRole("button", { name: /^General/ });
const openFeedback = (page: Page) => panel(page).getByTestId("stat-open-feedback").locator("dd");
const form = (page: Page) => page.getByTestId("start-discussion").filter({ visible: true });
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });

async function startThread(page: Page, opts: { private?: string } = {}) {
  if (opts.private) {
    await form(page).getByRole("group", { name: "Visible to" }).getByRole("button", { name: "Only people I pick" }).click();
    await form(page).getByRole("searchbox", { name: "Find a person" }).fill(opts.private.toLowerCase());
    await form(page).getByRole("option", { name: new RegExp(opts.private) }).click();
    await expect(form(page)).not.toContainText("counts as feedback on the whole draft");
  } else {
    await expect(form(page)).toContainText("During the review, your first message also counts as feedback on the whole draft.");
  }
  await form(page).getByRole("textbox", { name: "First message" }).fill(REMARK);
  await form(page).getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page)).toBeVisible();
  await thread(page).getByRole("button", { name: "All feedback" }).click();
}

test("a reviewer leaves whole-draft feedback through Discuss and the approver sees it counted", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  // One entry point: the panel no longer has its own whole-draft comment.
  await expect(page.getByRole("button", { name: "Comment on the whole draft" })).toHaveCount(0);
  await expect(general(page)).toHaveText(/^General\s*0$/);
  const before = Number(await openFeedback(page).textContent());

  await page.getByTestId("doc-discuss").click();
  await startThread(page);

  // Listed and counted where the old comment was: back from the thread, on General.
  await expect(general(page)).toHaveAttribute("aria-pressed", "true");
  const mine = items(page).filter({ hasText: REMARK });
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveAttribute("data-state", "open");
  await expect(mine.getByTestId("feedback-general-chip")).toHaveText("General");
  await expect(mine.getByTestId("feedback-author")).toHaveText("You");
  await expect(general(page)).toHaveText(/^General\s*1$/);
  await expect(openFeedback(page)).toHaveText(String(before + 1));
  await signOut(page);

  // The approver: in the version's counts and in the Inbox.
  await login(page, "approver@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  await expect(openFeedback(page)).toHaveText(String(before + 1));
  await expect(general(page)).toHaveText(/^General\s*1$/);
  await general(page).click();
  await expect(items(page).filter({ hasText: REMARK }).getByTestId("feedback-author")).toHaveText("Reviewer");

  await page.goto("/inbox");
  const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: REMARK });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("inbox-general")).toHaveText("General");
});

test("a private discussion of the draft stays a discussion", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  const before = await openFeedback(page).textContent();
  await page.getByTestId("doc-discuss").click();
  await startThread(page, { private: "Approver" });
  // Back on the discussions; All feedback has no new item.
  await panel(page).getByTestId("feedback-discussions").click();
  await expect(general(page)).toHaveText(/^General\s*0$/);
  await expect(openFeedback(page)).toHaveText(before!);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("More's Discuss leaves whole-draft feedback on a phone", async ({ page }) => {
    await login(page, "commenter@example.com");
    await page.goto(DOC);
    await page.getByTestId("version-toolbar").getByTestId("version-more").click();
    await page.getByTestId("sheet-more").getByRole("button", { name: "Discuss", exact: true }).click();
    await expect(page.getByTestId("sheet-more")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Comment on the whole draft" })).toHaveCount(0);
    await startThread(page);
    await expect(general(page)).toHaveAttribute("aria-pressed", "true");
    await expect(items(page).filter({ hasText: REMARK })).toHaveCount(1);
    await expect(general(page)).toHaveText(/^General\s*1$/);
  });
});

// fix3-discuss review: the General item leads to its thread, and resolving it closes the thread.
test("the approver opens a General item's thread, and resolving the item closes it", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  await page.getByTestId("doc-discuss").click();
  await startThread(page);
  await signOut(page);

  await login(page, "approver@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  await general(page).click();
  const mine = items(page).filter({ hasText: REMARK });
  await mine.getByRole("button", { name: "Open the thread" }).click();
  await expect(thread(page)).toBeVisible();
  await expect(thread(page)).toContainText(REMARK);
  await thread(page).getByRole("button", { name: "All feedback" }).click();

  await general(page).click();
  // Oracle answered it; the approver's Accept closes the item, and with it the thread.
  await items(page).filter({ hasText: REMARK }).getByRole("button", { name: "Accept", exact: true }).click();
  await panel(page).getByRole("button", { name: /^Done/ }).click();
  await items(page).filter({ hasText: REMARK }).getByRole("button", { name: "Open the thread" }).click();
  await expect(thread(page)).toContainText("Closed");
});

// fix3-discuss review 2: an item someone acted on outlives its thread's first message. The
// approver accepted Oracle's suggestion (which resolved the item); the starter reopens the thread
// and deletes that message: the item stays, done, with its text, and no longer leads to the thread.
test("a General item resolved by accepting Oracle's suggestion stays when its first message is deleted", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  await page.getByTestId("doc-discuss").click();
  await startThread(page);
  await signOut(page);

  await login(page, "approver@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  await general(page).click();
  await items(page).filter({ hasText: REMARK }).getByRole("button", { name: "Accept", exact: true }).click();
  await panel(page).getByRole("button", { name: /^Done/ }).click();
  await expect(items(page).filter({ hasText: REMARK })).toHaveCount(1);
  await signOut(page);

  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  await general(page).click();
  await panel(page).getByRole("button", { name: /^Done/ }).click();
  await items(page).filter({ hasText: REMARK }).getByRole("button", { name: "Open the thread" }).click();
  await expect(thread(page)).toContainText("Closed");
  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
  await thread(page).getByRole("menuitem", { name: "Reopen" }).click();
  await expect(thread(page)).not.toContainText("Closed");
  await thread(page).getByRole("button", { name: "Delete message" }).first().click();
  await page.getByRole("alertdialog", { name: "Delete message" }).getByRole("button", { name: "Delete message" }).click();
  await expect(thread(page)).toContainText("Message deleted");
  await thread(page).getByRole("button", { name: "All feedback" }).click();

  await general(page).click();
  await panel(page).getByRole("button", { name: /^Done/ }).click();
  const kept = items(page).filter({ hasText: REMARK });
  await expect(kept).toHaveCount(1);
  await expect(kept.getByRole("button", { name: "Open the thread" })).toHaveCount(0);
});
