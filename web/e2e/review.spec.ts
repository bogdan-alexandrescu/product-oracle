import { expect, test } from "@playwright/test";

import { ADMIN, login, section, selectText } from "./helpers";

test("login: rejects a wrong password, then signs in", async ({ page }) => {
  await page.goto("/documents");
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid" })).toHaveText("Invalid email or password.");

  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByTestId("signed-in-as")).toHaveText("admin@example.com");
});

test("open a version: sections in order with citation chips", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Checkout redesign PRD" }).click();
  await page.getByRole("link", { name: "Version 2" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2$/);

  const headings = page.locator("section[data-section-key] :is(h1,h2,h3)").filter({ visible: true });
  await expect(headings.first()).toHaveText("Checkout redesign PRD");
  await expect(headings).toHaveText([
    "Checkout redesign PRD",
    "1. Goal trace",
    "2. Problem",
    "3. Users and jobs",
    "4. Scope",
    "5. Proposed flow",
    "5.1 Cart review",
    "5.2 Shipping step",
    "5.3 Saved addresses",
    "6. Risks and open questions",
    "7. Success metrics",
  ]);

  // Hovering a chip previews source, title and excerpt.
  const chip = section(page, "problem").getByTestId("cite-c1");
  await expect(chip).toHaveText(/Slack/);
  await chip.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("#product thread on checkout drop-off");
  await expect(card).toContainText("Most users who abandon do it at the shipping step");
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveAttribute("href", /example\.slack\.com/);
});

test("add an anchored comment that survives reload", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const scope = section(page, "scope");
  await expect(scope).toBeVisible();

  await selectText(page, "scope", "the order review page");
  await page.getByRole("button", { name: /^Comment/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await expect(dialog).toContainText("the order review page");
  await dialog.getByLabel("Comment").fill("Is the order review page a separate step or a summary panel?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();

  const mark = scope.locator("mark.hl-comment");
  await expect(mark).toHaveText("the order review page");
  await expect(page.getByTestId("comment").filter({ hasText: "separate step or a summary panel" })).toBeVisible();

  await page.reload();
  const markAfter = section(page, "scope").locator("mark.hl-comment");
  await expect(markAfter).toHaveText("the order review page");
  const comment = page.getByTestId("comment").filter({ hasText: "separate step or a summary panel" });
  await expect(comment).toContainText("4. Scope");

  // The comment is also an open feedback item.
  await page.getByRole("tab", { name: "Feedback" }).click();
  await page.getByLabel("Filter by status").selectOption("open");
  await page.getByLabel("Filter by version").selectOption("2");
  await expect(page.getByTestId("feedback-item").filter({ hasText: "summary panel" })).toBeVisible();
});

test("set a section verdict; approval shows the section as locked", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const users = section(page, "users");
  const bar = users.getByTestId("review-bar");
  await expect(bar.getByTestId("verdict-state")).toHaveText("Not reviewed");

  await bar.getByRole("button", { name: "Request changes" }).click();
  await bar.getByLabel(/What should change/).fill("Add the support agent's main job in one line.");
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Changes requested");
  await expect(bar.getByTestId("verdict-state")).toContainText("support agent's main job");

  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
  await expect(bar.getByTestId("verdict-state")).toContainText("Locked");

  // The changes-requested item was superseded by the approval.
  await page.getByRole("tab", { name: "Feedback" }).click();
  await page.getByLabel("Filter by status").selectOption("superseded");
  await expect(page.getByTestId("feedback-item").filter({ hasText: "support agent's main job" })).toBeVisible();

  await page.reload();
  await expect(section(page, "users").getByTestId("verdict-state")).toContainText("Locked");
});

test("switch versions with the version switcher", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(section(page, "s-5-3")).toBeVisible();

  await page.getByLabel("Version", { exact: true }).selectOption("1");
  await expect(page).toHaveURL(/\/v\/1$/);
  await expect(section(page, "rollout")).toBeVisible();
  await expect(section(page, "s-5-3")).toHaveCount(0);
  await expect(page.getByText("You are viewing an earlier version.")).toBeVisible();
  // v1 carries the earlier review: the goal trace was approved.
  await expect(section(page, "goal-trace").getByTestId("verdict-state")).toContainText("Locked");

  await page.keyboard.press("]");
  await expect(page).toHaveURL(/\/v\/2$/);
});

test("open the diff: section badges and word-level changes", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("link", { name: "Compare with v1" }).click();
  await expect(page).toHaveURL(/\/diff\?from=1&to=2$/);
  await expect(page.getByRole("heading", { name: "Changes from v1 to v2" })).toBeVisible();

  const byKey = (k: string) => page.getByTestId("diff-section").filter({ hasText: `#${k}` });
  await expect(byKey("s-5-3")).toHaveAttribute("data-status", "added");
  await expect(byKey("rollout")).toHaveAttribute("data-status", "removed");
  await expect(byKey("problem")).toHaveAttribute("data-status", "changed");
  await expect(byKey("risks").getByText("Moved")).toBeVisible();

  const words = byKey("s-5-2").getByTestId("word-diff");
  await expect(words.locator("ins").first()).toContainText("and the cheapest option is preselected");
  await expect(byKey("metrics").locator("ins").first()).toContainText("Refund rate");

  // Unchanged sections are collapsed until asked for.
  await expect(byKey("goal-trace")).toHaveCount(0);
  await page.getByLabel("Show unchanged sections").check();
  await expect(byKey("goal-trace")).toHaveAttribute("data-status", "unchanged");
});

test("approve a version and export it", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  await expect(page.getByRole("status").filter({ hasText: "scope" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF" }).click();
  expect((await download).suggestedFilename()).toBe("team-workspaces-v2.pdf");

  await page.getByRole("button", { name: "Approve version" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/✓ Approved/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Approved");
  await expect(page.getByText(/review is closed/)).toBeVisible();
});
