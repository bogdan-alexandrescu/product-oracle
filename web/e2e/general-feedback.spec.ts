import { expect, test, type Page } from "./test";

import { login, openSection } from "./helpers";

/*
 * D13 General feedback: a remark on the whole draft ("too long", "add a rollout section")
 * is its own feedback item, not a comment on whichever section was selected. qa-docs-33
 * (owner, 2026-10-29): it is left through the header's Discuss (the panel's "Comment on the
 * whole draft" is gone); during a review the thread's first message is the item. The scope
 * chips are This section / All sections / General, and the Inbox shows the item with
 * "General" in place of a section.
 */
const DOC = "/documents/checkout-redesign/v/2";
const REMARK = "The goals don't match the problem statement.";

const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const items = (page: Page) => panel(page).getByTestId("feedback-item");
const scope = (page: Page, name: RegExp) => panel(page).getByTestId("inspector-scope").getByRole("button", { name });
const form = (page: Page) => page.getByTestId("start-discussion").filter({ visible: true });

/** The header's Discuss on the whole draft, its first message `body`, back to All feedback. */
async function discussDraft(page: Page, body: string) {
  await page.getByTestId("doc-discuss").click();
  await form(page).getByRole("textbox", { name: "First message" }).fill(body);
  await form(page).getByRole("button", { name: "Start discussion" }).click();
  const thread = page.getByTestId("discussion-thread").filter({ visible: true });
  await thread.getByRole("button", { name: "All feedback" }).click();
}

test("whole-draft feedback through Discuss: the item shows under General and All sections, not This section", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  const review = panel(page);
  await expect(scope(page, /^General\s*0$/)).toBeVisible();

  // Cancel closes the form and adds nothing.
  await page.getByTestId("doc-discuss").click();
  await form(page).getByRole("textbox", { name: "First message" }).fill("Not this one.");
  await form(page).getByRole("button", { name: "Cancel" }).click();
  await expect(form(page)).toHaveCount(0);
  await expect(review.getByTestId("feedback-discussions")).toHaveText(/^Discussion\s*0$/);

  await discussDraft(page, REMARK);

  // Shown under General: its chip, its author, open.
  await expect(scope(page, /^General\s*1$/)).toHaveAttribute("aria-pressed", "true");
  const mine = items(page).filter({ hasText: REMARK });
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveAttribute("data-state", "open");
  await expect(mine.getByTestId("feedback-general-chip")).toHaveText("General");
  await expect(mine.getByTestId("feedback-author")).toHaveText("You");
  await expect(mine.locator("[data-section-link]")).toHaveCount(0);
  await expect(items(page)).toHaveCount(1);

  // All sections lists it with the rest; This section does not.
  await scope(page, /^All sections/).click();
  await expect(items(page).filter({ hasText: REMARK })).toHaveCount(1);
  expect(await items(page).count()).toBeGreaterThan(1);
  await scope(page, /^This section/).click();
  await expect(items(page).filter({ hasText: REMARK })).toHaveCount(0);

  // Still there after a reload: the API kept it.
  await page.reload();
  await openSection(page, "problem");
  await scope(page, /^General/).click();
  await expect(items(page).filter({ hasText: REMARK })).toHaveCount(1);

  // qa-docs-33: Discuss is the one entry point; the panel has no whole-draft comment of its own.
  await expect(review.getByRole("button", { name: "Comment on the whole draft" })).toHaveCount(0);
  await expect(page.getByTestId("doc-general-feedback")).toHaveCount(0);
});

test("a viewer has no whole-draft entry; the new item reaches the approver's Inbox as General", async ({ page: viewer, browser }) => {
  await login(viewer, "viewer@example.com");
  await viewer.goto(DOC);
  await expect(panel(viewer).getByTestId("inspector-scope")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Comment on the whole draft" })).toHaveCount(0);
  await expect(viewer.getByTestId("doc-discuss")).toHaveCount(0);

  // The owner, in a browser of their own.
  const page = await (await browser.newContext()).newPage();
  await login(page);
  await page.goto(DOC);
  await discussDraft(page, REMARK);
  await expect(items(page).filter({ hasText: REMARK })).toHaveCount(1);

  await page.goto("/inbox");
  const tabs = page.getByTestId("inbox-state-tabs");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: REMARK });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-state", "new");
  await expect(row).toContainText("Feedback");
  await expect(row.getByTestId("inbox-general")).toHaveText("General");
  await expect(row).not.toContainText("#");

  // Oracle's review job answered it (an answer, not one section's new text): D14 sends it from the row.
  await expect(row.getByRole("button", { name: "Send answer" })).toBeVisible();

  // Its link opens the version's Feedback, where the answer waits on the item.
  await row.getByRole("link", { name: REMARK, exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\?feedback=open/);
  const mine = items(page).filter({ hasText: REMARK });
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveAttribute("data-kind", "suggestion");
  await expect(mine.getByTestId("feedback-general-chip")).toHaveText("General");
  await expect(mine).toContainText("This is about the whole draft");
});
