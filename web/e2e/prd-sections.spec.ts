import { expect, test, type Page } from "@playwright/test";

import { login, openSection, section, sectionStrip, showAll } from "./helpers";

// I3 (2026-10-19): the PRD page shows ONE SECTION AT A TIME. The strip picks the open
// section, the URL hash keeps it, arrows at the panel's foot and [ ] step through.

/** The section panels on screen (Next keeps recently visited routes mounted but hidden). */
const shown = (page: Page) => page.locator("section[data-section-key]").filter({ visible: true });
const stripItem = (page: Page, key: string) => sectionStrip(page).locator(`a[data-strip-key="${key}"]`);

test("sections: the strip, the hash, the arrows, back / forward and [ ] switch the one open section", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  // The first unreviewed section opens by default, alone.
  await expect(shown(page)).toHaveCount(1);
  await expect(stripItem(page, "title")).toHaveAttribute("aria-current", "true");

  await stripItem(page, "problem").click();
  await expect(page).toHaveURL(/\/v\/2#problem$/);
  await expect(shown(page)).toHaveCount(1);
  await expect(section(page, "problem")).toBeVisible();
  await expect(stripItem(page, "problem")).toHaveAttribute("aria-current", "true");
  await expect(stripItem(page, "title")).not.toHaveAttribute("aria-current", "true");

  // The arrows name the neighbours.
  const pager = page.getByRole("navigation", { name: "Previous and next section" }).filter({ visible: true });
  await expect(pager.getByRole("link", { name: "Previous section: 1. Goal trace" })).toBeVisible();
  await pager.getByRole("link", { name: "Next section: 3. Users and jobs" }).click();
  await expect(page).toHaveURL(/#users$/);
  await expect(section(page, "users")).toBeVisible();
  await expect(shown(page)).toHaveCount(1);

  // Back and forward walk the sections.
  await page.goBack();
  await expect(page).toHaveURL(/#problem$/);
  await expect(section(page, "problem")).toBeVisible();
  await page.goForward();
  await expect(section(page, "users")).toBeVisible();

  // Keyboard: ] next, [ previous, Shift + arrows too.
  await page.keyboard.press("]");
  await expect(section(page, "scope")).toBeVisible();
  await expect(page).toHaveURL(/#scope$/);
  await page.keyboard.press("[");
  await expect(section(page, "users")).toBeVisible();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(section(page, "scope")).toBeVisible();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(section(page, "users")).toBeVisible();
  // The shortcuts are in the (i) tip, not in prose.
  await expect(page.getByTestId("info-tip").filter({ visible: true }).first()).toBeAttached();

  // A link opens its section: #key, and the older #s-key.
  await page.goto("/documents/checkout-redesign/v/2#metrics");
  await expect(section(page, "metrics")).toBeVisible();
  await expect(shown(page)).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^Next section/ }).filter({ visible: true })).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: /^Add evidence link|^Refine section/ }).filter({ visible: true })).toHaveCount(0);
  const problem = await openSection(page, "problem");
  await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("group", { name: /^Verdict for/ }).filter({ visible: true })).toHaveCount(1);

  await problem.getByRole("button", { name: "Actions for 2. Problem" }).click();
  await expect(problem.getByRole("menuitem", { name: "Add evidence link to 2. Problem" })).toBeVisible();
  await problem.getByRole("menuitem", { name: "Refine section 2. Problem" }).click();
  await expect(problem.getByTestId("refine-panel")).toBeVisible();
  await problem.getByTestId("refine-panel").getByRole("button", { name: "Close" }).click();
  await expect(problem.getByTestId("refine-panel")).toHaveCount(0);

  // Sources are one tab away, not a list under the document.
  await page.getByRole("tab", { name: /^Sources/ }).filter({ visible: true }).click();
  await expect(page.getByTestId("sources-list").filter({ visible: true }).getByRole("listitem").first()).toBeVisible();
});

test("sections: reviewing the open section ticks it in the strip and counts it", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const count = page.getByTestId("sections-count").filter({ visible: true });
  await expect(count).toHaveText(/Sections \d+\/11/);
  const before = Number((await count.innerText()).match(/(\d+)\//)![1]);
  const users = await openSection(page, "users");
  await expect(stripItem(page, "users").getByTestId("strip-tick")).toHaveCount(0);

  const bar = users.getByTestId("review-bar");
  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
  await expect(stripItem(page, "users").getByTestId("strip-tick")).toBeVisible();
  await expect(stripItem(page, "users")).toHaveAttribute("data-reviewed", "true");
  await expect(count).toHaveText(`Sections ${before + 1}/11`);
  // The reviewed section stays open.
  await expect(section(page, "users")).toBeVisible();
  await expect(stripItem(page, "users")).toHaveAttribute("aria-current", "true");
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
  for (const item of await feedback.all()) await expect(item).toContainText("#roles");
});

test("sections: on a phone, one section per screen, Comments one tap away, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/documents/team-workspaces/v/2#problem");
  await expect(section(page, "problem")).toBeVisible();
  await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(1);
  const button = section(page, "problem").getByRole("button", { name: "Comments on this section: 2" });
  await button.click();
  await expect(page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
