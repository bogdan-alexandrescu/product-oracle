import { expect, test, type Page } from "./test";

import { login, openSection, outlineRow, section, showAll } from "./helpers";

// PT1 a "Calm document" (2026-10-2x): a PRD shows every section at once in one column, with a
// contents rail that picks the current one. The URL hash keeps it; a contents row's own
// aria-current is "location" (I3's old outline rows used "true").

const stripItem = (page: Page, key: string) => outlineRow(page, key);

test("sections: the contents and the hash pick the current section; back / forward walk it", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  // A PRD shows every section at once (PT1 a): the first one is current on arrival.
  await expect(stripItem(page, "title")).toHaveAttribute("aria-current", "location");

  await stripItem(page, "problem").click();
  await expect(page).toHaveURL(/\/v\/2#problem$/);
  await expect(section(page, "problem")).toBeVisible();
  await expect(stripItem(page, "problem")).toHaveAttribute("aria-current", "location");
  await expect(stripItem(page, "title")).not.toHaveAttribute("aria-current", "location");

  await stripItem(page, "users").click();
  await expect(page).toHaveURL(/#users$/);
  await expect(section(page, "users")).toBeVisible();

  // Back and forward walk the sections.
  await page.goBack();
  await expect(page).toHaveURL(/#problem$/);
  await expect(stripItem(page, "problem")).toHaveAttribute("aria-current", "location");
  await page.goForward();
  await expect(page).toHaveURL(/#users$/);
  await expect(stripItem(page, "users")).toHaveAttribute("aria-current", "location");

  // A link opens its section: #key, and the older #s-key.
  await page.goto("/documents/checkout-redesign/v/2#metrics");
  await expect(section(page, "metrics")).toBeVisible();
  await expect(stripItem(page, "metrics")).toHaveAttribute("aria-current", "location");
  await page.goto("about:blank");
  await page.goto("/documents/checkout-redesign/v/2#s-scope");
  await expect(section(page, "scope")).toBeVisible();
  // A key that itself starts with s- is matched first.
  await page.goto("about:blank");
  await page.goto("/documents/checkout-redesign/v/2#s-5-3");
  await expect(section(page, "s-5-3")).toBeVisible();
});

test("sections: one review bar on screen; evidence and refine sit in the ⋯ menu", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Add evidence link|^Ask Oracle to rewrite/ }).filter({ visible: true })).toHaveCount(0);
  const problem = await openSection(page, "problem");
  await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("group", { name: /^Verdict for/ }).filter({ visible: true })).toHaveCount(1);

  await problem.getByRole("button", { name: "Actions for 2. Problem" }).click();
  await expect(problem.getByRole("menuitem", { name: "Add evidence link to 2. Problem" })).toBeVisible();
  await problem.getByRole("menuitem", { name: "Ask Oracle to rewrite" }).click();
  await expect(problem.getByTestId("refine-panel")).toBeVisible();
  await problem.getByTestId("refine-panel").getByRole("button", { name: "Close" }).click();
  await expect(problem.getByTestId("refine-panel")).toHaveCount(0);

  // Sources are one tab away, not a list under the document.
  await page.getByRole("tab", { name: /^Sources/ }).filter({ visible: true }).click();
  await expect(page.getByTestId("sources-list").filter({ visible: true }).getByRole("listitem").first()).toBeVisible();
});

test("sections: reviewing the open section marks it in the outline and counts it", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  // The review panel's own count, not the old rail's "review-progress" (PT1 a: contents rows
  // carry a status dot, not a count).
  const count = page.getByTestId("review-panel").filter({ visible: true }).getByTestId("stat-reviewed");
  await expect(count).toHaveText(/\d+\/11/);
  const before = Number((await count.innerText()).match(/(\d+)\/11/)![1]);
  const users = await openSection(page, "users");
  await expect(stripItem(page, "users").getByRole("img")).toHaveAttribute("aria-label", "Not reviewed");

  const bar = users.getByTestId("review-bar");
  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByTestId("verdict-submit").click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
  await expect(stripItem(page, "users").getByRole("img")).toHaveAttribute("aria-label", "Approved");
  await expect(count).toHaveText(new RegExp(`${before + 1}/11`));
  // The reviewed section stays open.
  await expect(section(page, "users")).toBeVisible();
  await expect(stripItem(page, "users")).toHaveAttribute("aria-current", "location");
});

test("sections: the inspector shows the open section's comments first; All shows the rest; a quote opens its section", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2#problem");
  const comments = page.getByTestId("comment").filter({ visible: true });
  await expect(section(page, "problem")).toBeVisible();
  await expect(comments).toHaveCount(2);
  await expect(comments.filter({ hasText: "custom roles" })).toHaveCount(0);

  await openSection(page, "roles");
  await expect(comments).toHaveCount(1);
  await expect(comments).toContainText("custom roles");

  await openSection(page, "problem");
  await showAll(page);
  await expect(comments).toHaveCount(3);
  // A comment's quote opens its section, at the quote.
  await comments.filter({ hasText: "custom roles" }).getByRole("button", { name: /Show comment in/ }).click();
  await expect(section(page, "roles")).toBeVisible();
  await expect(page).toHaveURL(/#roles$/);
  await expect(section(page, "roles").locator("mark.hl-comment")).toBeInViewport();

  // Feedback narrows to the open section too.
  await page.getByRole("tab", { name: "Feedback" }).filter({ visible: true }).click();
  await page.getByTestId("inspector-scope").filter({ visible: true }).getByRole("button", { name: "This section" }).click();
  const feedback = page.getByTestId("feedback-item").filter({ visible: true });
  await expect(feedback.first()).toBeVisible();
  for (const item of await feedback.all()) await expect(item.getByTestId("feedback-goto")).toHaveAttribute("href", /#roles$/);
});

test("sections: on a phone, one section per screen, Review one tap away, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/documents/team-workspaces/v/2#problem");
  await expect(section(page, "problem")).toBeVisible();
  await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(1);
  await page.getByTestId("phone-review").click();
  const sheet = page.getByRole("dialog", { name: "Review" });
  await expect(sheet.getByRole("complementary", { name: "Review panel" })).toBeInViewport();
  await expect(sheet.getByTestId("comment")).toHaveCount(2);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
