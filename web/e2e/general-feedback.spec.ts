import { expect, test, type Page } from "@playwright/test";

import { login, openSection } from "./helpers";

/*
 * D13 General feedback: a remark on the whole draft ("too long", "add a rollout section")
 * is its own feedback item, not a comment on whichever section was selected. The Feedback
 * tab has "Comment on the whole draft", the scope chips are This section / All sections /
 * General, and the Inbox shows the item with "General" in place of a section.
 */
const DOC = "/documents/checkout-redesign/v/2";
const REMARK = "The goals don't match the problem statement.";

const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const items = (page: Page) => panel(page).getByTestId("feedback-item");
const scope = (page: Page, name: RegExp) => panel(page).getByTestId("inspector-scope").getByRole("button", { name });

test("comment on the whole draft: the item shows under General and All sections, not This section", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto(DOC);
  await openSection(page, "problem");
  const review = panel(page);
  await expect(scope(page, /^General\s*0$/)).toBeVisible();

  // Cancel closes the form and adds nothing.
  await review.getByRole("button", { name: "Comment on the whole draft" }).click();
  await review.getByRole("textbox", { name: "Comment on the whole draft" }).fill("Not this one.");
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review.getByRole("textbox", { name: "Comment on the whole draft" })).toHaveCount(0);

  await review.getByRole("button", { name: "Comment on the whole draft" }).click();
  const box = review.getByRole("textbox", { name: "Comment on the whole draft" });
  await expect(review.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await box.fill(REMARK);
  await review.getByRole("button", { name: "Add", exact: true }).click();
  await expect(box).toHaveCount(0);

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

  // The same action from the version's header row opens the form in the Feedback tab.
  await scope(page, /^This section/).click();
  await page.getByTestId("doc-general-feedback").click();
  await expect(review.getByRole("textbox", { name: "Comment on the whole draft" })).toBeFocused();
});

test("a viewer has no whole-draft entry; the new item reaches the approver's Inbox as General", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto(DOC);
  await expect(panel(page).getByTestId("inspector-scope")).toBeVisible();
  await expect(page.getByRole("button", { name: "Comment on the whole draft" })).toHaveCount(0);
  await expect(page.getByTestId("doc-general-feedback")).toHaveCount(0);

  await page.context().clearCookies();
  await login(page);
  await page.goto(DOC);
  await panel(page).getByRole("button", { name: "Comment on the whole draft" }).click();
  await panel(page).getByRole("textbox", { name: "Comment on the whole draft" }).fill(REMARK);
  await panel(page).getByRole("button", { name: "Add", exact: true }).click();
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

  // Its link opens the version's Feedback on the General items.
  await row.getByRole("link", { name: REMARK }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2\?feedback=open/);
  await expect(items(page).filter({ hasText: REMARK })).toHaveCount(1);
});
