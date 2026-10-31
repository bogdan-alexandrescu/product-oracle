import { expect, test, type Page } from "./test";

import { login, openTab, showAll } from "./helpers";

// QA pass 4, docs lane: the review panel on a PRD version page (suggestions, feedback, sources)
// and the Build draft action, driven as a person. Team workspaces v2 has Oracle's suggestions
// (one a duplicate, one pushed back) and a paused agents' run; Checkout redesign v2 has
// scored sources and comments by the owner.

const WORKSPACES = "/documents/team-workspaces/v/2";
const CHECKOUT = "/documents/checkout-redesign/v/2";
const DESKTOP = { width: 1440, height: 900 };

const feedbackItem = (page: Page, text: string) => page.getByTestId("feedback-item").filter({ visible: true, hasText: text });

async function openFeedback(page: Page, url: string, email?: string) {
  await login(page, email);
  await page.goto(url);
  await openTab(page, "Feedback");
  await showAll(page);
}

/** Every source title in the Sources tab shows whole: none is cut short on its line. */
async function expectTitlesNotCut(page: Page) {
  const titles = page.getByTestId("sources-list").filter({ visible: true }).getByTestId("source-title");
  await expect(titles.first()).toBeVisible();
  const cut = await titles.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(cut).toEqual([]);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-2: with nothing to build while a run is under way, Build draft says why instead of opening an empty dialog", async ({ page }) => {
    await login(page);
    await page.goto(WORKSPACES);
    const build = page.getByTestId("build-draft").filter({ visible: true });
    await expect(build).toHaveText("Build draft 3");
    await expect(build).toBeDisabled();
    await expect(build).toHaveAccessibleName("Build draft 3: A run is under way; build once it ends.");
    await expect(page.getByTestId("next-draft-sheet")).toHaveCount(0);
  });

  test("qa4-docs-11: a suggestion's proposed text reads as plain text, without markdown stars", async ({ page }) => {
    await openFeedback(page, WORKSPACES);
    const text = feedbackItem(page, "Add custom roles").getByTestId("suggestion-text");
    await expect(text).toContainText("Three fixed roles: owner, editor and viewer.");
    await expect(text).not.toContainText("**");
  });

  test("qa4-docs-12: an open duplicate says it is resolved when the earlier item is, not that it already is", async ({ page }) => {
    await openFeedback(page, WORKSPACES);
    const item = feedbackItem(page, "quantify the demand");
    await expect(item.getByTestId("feedback-state-chip")).toHaveText("Open");
    await expect(item.getByTestId("duplicate-note")).toHaveText("Duplicate of an earlier item; resolved when that one is.");
    await expect(item).not.toContainText("resolved with it");
  });

  test("qa4-docs-20: Oracle's push-back names how strong its evidence is, not a bare score", async ({ page }) => {
    await openFeedback(page, WORKSPACES);
    const pushback = feedbackItem(page, "Add custom roles").getByTestId("pushback");
    await expect(pushback).toContainText("Evidence: Roles research notes · strong evidence");
    await expect(pushback).not.toContainText("0.82");
    await expect(pushback).not.toContainText("confidence");
  });

  test("qa4-docs-52: the decision buttons on a pushed-back suggestion name their outcome", async ({ page }) => {
    await openFeedback(page, WORKSPACES);
    const item = feedbackItem(page, "Add custom roles");
    await expect(item.getByRole("button", { name: "Keep my call" })).toHaveCount(0);
    await item.getByRole("button", { name: "Accept anyway" }).click();
    await expect(item.getByLabel(/Why accept against the advice/)).toBeVisible();
    await expect(item.getByRole("button", { name: "Accept against the advice" })).toBeDisabled();
    await item.getByRole("button", { name: "Cancel" }).click();

    await item.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(item.getByRole("button", { name: "Dismiss, keep feedback open" })).toBeVisible();
    await expect(item.getByRole("button", { name: "Dismiss and decline feedback" })).toBeVisible();
    await item.getByRole("button", { name: "Dismiss, keep feedback open" }).click();
    await expect(item.getByTestId("suggestion")).toContainText("Dismissed");
    await expect(item.getByTestId("feedback-state-chip")).toHaveText("Open");
  });

  test("qa4-docs-19: Sources show a confidence word, not a raw score, and whole titles", async ({ page }) => {
    await login(page);
    await page.goto(CHECKOUT);
    await openTab(page, "Sources");
    const list = page.getByTestId("sources-list").filter({ visible: true });
    await expect(list.getByRole("listitem").filter({ hasText: "#product thread on checkout drop-off" }).getByTestId("source-label")).toHaveText(
      "Slack · High confidence",
    );
    await expect(list).not.toContainText("0.82");
    await expect(list).not.toContainText("0.35");
    await expectTitlesNotCut(page);
  });

  test("qa4-docs-39: someone else's feedback shows its author's name beside the avatar", async ({ page }) => {
    await openFeedback(page, CHECKOUT, "commenter@example.com");
    const item = feedbackItem(page, "most recently used address");
    await expect(item.getByTestId("feedback-author")).toHaveText("Admin");
    await expect(item.getByRole("img", { name: "Admin" })).toHaveText("AD");
  });
});
