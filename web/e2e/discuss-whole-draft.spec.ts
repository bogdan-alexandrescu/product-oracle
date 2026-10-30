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
