import { expect, test, type Page } from "@playwright/test";

import { login, section, selectText } from "./helpers";

// O1f: every document has a brief layer and a full layer. The saved-carts fixture has a
// brief (summary, goals, problem, features by milestone, roadmap, non-goals, top risks,
// decisions); checkout-redesign has none.
const BRIEF = [
  "Summary",
  "Goal trace",
  "Problem",
  "Features by milestone",
  "Roadmap",
  "Non-goals",
  "Top risks",
  "Decisions needed",
];

const sections = (page: Page) => page.getByTestId("document-sections").filter({ visible: true });
const topHeadings = (page: Page) =>
  sections(page).locator(":scope > section[data-section-key] > div > :is(h1,h2,h3)");

test("brief: a document opens on its brief; Show full document switches, and the choice is remembered", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await expect(topHeadings(page)).toHaveText(BRIEF);
  await expect(page.getByTestId("view-note")).toContainText("Brief: 8 of 20 sections");
  await expect(section(page, "summary").getByTestId("layer-badge").first()).toHaveText("Brief");
  // Presenter notes stay in the document as a code block; the detail is not shown.
  await expect(section(page, "feature-detail")).toHaveCount(0);

  await page.getByRole("button", { name: "Show full document" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await expect(section(page, "feature-detail")).toBeVisible();
  await expect(section(page, "feature-detail").getByTestId("layer-badge").first()).toHaveText("Detail");
  await expect(topHeadings(page).first()).toHaveText("Saved carts PRD");

  // Remembered for this user: after a reload and on another version.
  await page.reload();
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await page.goto("/documents/saved-carts/v/1");
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Brief" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await page.reload();
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await page.keyboard.press("v");
  await expect(sections(page)).toHaveAttribute("data-view", "full");

  // A version without a brief shows every section, with no view switch or Present.
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(section(page, "s-5-3")).toBeVisible();
  await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Present" })).toHaveCount(0);
  await expect(page.getByTestId("layer-badge")).toHaveCount(0);
});

test("a link to a detail section opens the full document at it, once; the brief stays one click away", async ({
  page,
}) => {
  await login(page);
  // A roadmap item's link to its PRD feature: the feature is detail, not in the brief.
  await page.goto("/documents/saved-carts/v/2#s-feature-detail");
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await expect(section(page, "feature-detail")).toBeInViewport();
  // Not saved as the user's choice, and not forced again on the way back to the brief.
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Brief" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await expect(section(page, "feature-detail")).toHaveCount(0);
  // A brief section's link keeps the brief (a fresh load, not a same-page hash change).
  await page.goto("about:blank");
  await page.goto("/documents/saved-carts/v/2#s-problem");
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await expect(section(page, "problem")).toBeInViewport();
});

test("expand: a feature row and a milestone show their detail in place; comments and verdicts say the layer", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  const items = section(page, "brief-items").first();

  await items.getByRole("button", { name: "Expand Save cart" }).click();
  const detail = section(page, "feature-save-cart");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("layer-badge")).toHaveText("Detail");
  await expect(detail).toContainText("I want my cart kept when I leave");
  await expect(items.getByRole("button", { name: "Collapse Save cart" })).toHaveAttribute("aria-expanded", "true");
  // The milestone in the same table expands too, and so does the outcome-level roadmap's.
  await items.getByRole("button", { name: "Expand Beta" }).click();
  await expect(section(page, "milestone-beta")).toContainText("Exit: two weeks without a lost cart");
  await section(page, "brief-roadmap").first().getByRole("button", { name: "Expand General release" }).click();
  await expect(section(page, "milestone-ga")).toContainText("opt-outs below 2%");

  // Comment on the expanded detail: anchored there, labelled Detail in the panel.
  await selectText(page, "feature-save-cart", "my cart kept when I leave");
  await page.getByRole("button", { name: /^Comment/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Kept for how long?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();
  await expect(detail.locator("mark.hl-comment")).toHaveText("my cart kept when I leave");
  const detailComment = page.getByTestId("comment").filter({ hasText: "Kept for how long?" });
  await expect(detailComment.getByTestId("layer-badge")).toHaveText("Detail");

  // And on a brief section: labelled Brief.
  await selectText(page, "problem", "lose it when they move to a laptop");
  await page.getByRole("button", { name: /^Comment/ }).click();
  await dialog.getByLabel("Comment").fill("How often?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(page.getByTestId("comment").filter({ hasText: "How often?" }).getByTestId("layer-badge")).toHaveText("Brief");

  // Verdicts work on the brief and on expanded detail.
  const bar = section(page, "summary").getByTestId("review-bar");
  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
  const detailBar = section(page, "milestone-ga").getByTestId("review-bar");
  await detailBar.getByRole("button", { name: "Request changes" }).click();
  await detailBar.getByLabel(/What should change/).fill("Name the opt-out source.");
  await detailBar.getByRole("button", { name: /^Save/ }).click();
  await expect(detailBar.getByTestId("verdict-state")).toContainText("Changes requested");

  // Collapse hides the detail again; a comment on it opens it from the panel.
  await items.getByRole("button", { name: "Collapse Save cart" }).click();
  await expect(section(page, "feature-save-cart")).toHaveCount(0);
  await detailComment.getByRole("button", { name: /Show comment in Save cart/ }).click();
  await expect(section(page, "feature-save-cart")).toBeVisible();
});

test("present: one brief section per slide, keyboard and click navigation, Expand overlay, presenter view", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await page.getByRole("link", { name: "Present" }).click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/present$/);
  const present = page.getByTestId("present-mode");
  const counter = page.getByTestId("slide-counter");
  // Title slide, one slide per brief section, then Sources and data points.
  await expect(counter).toHaveText("1 / 10");
  await expect(present.getByRole("region", { name: "Slide 1 of 10: Saved carts PRD" })).toBeVisible();
  // The document's theme, as its slide variant.
  expect(
    await present.locator(".current-slide").evaluate((el) => !!el.shadowRoot?.querySelector(".deck.theme-clean-document")),
  ).toBe(true);

  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 10");
  await expect(present.getByRole("heading", { name: "Summary" })).toBeVisible();
  await expect(present.getByText("Open with how many carts")).toHaveCount(0); // notes never on the slide
  await page.getByTestId("audience-view").click();
  await expect(counter).toHaveText("3 / 10");
  await page.keyboard.press("ArrowLeft");
  await expect(counter).toHaveText("2 / 10");
  await page.keyboard.press("End");
  await expect(present.getByRole("heading", { name: "Sources and data points" })).toBeVisible();
  await expect(counter).toHaveText("10 / 10");
  await page.keyboard.press("Home");
  await expect(counter).toHaveText("1 / 10");
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Next slide" }).click();
  await expect(present.getByRole("region", { name: "Slide 5 of 10: Features by milestone" })).toBeVisible();

  // Expand a feature on the slide: its detail opens in an overlay for questions.
  await present.getByRole("button", { name: "Expand Save cart" }).click();
  const overlay = page.getByRole("dialog", { name: "Detail: Save cart" });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("I want my cart kept when I leave");
  await page.keyboard.press("ArrowRight"); // ignored while the overlay is open
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await expect(counter).toHaveText("5 / 10");
  await present.getByRole("button", { name: "Expand Beta" }).click();
  await expect(page.getByRole("dialog", { name: "Detail: Beta" })).toContainText("two weeks without a lost cart");
  await page.getByRole("button", { name: "Close" }).click();

  // Presenter view: the current slide, the next one and the notes.
  await page.keyboard.press("s");
  const presenter = page.getByTestId("presenter-view");
  await expect(presenter).toBeVisible();
  await expect(presenter.getByRole("region", { name: "Slide 6 of 10: Roadmap" })).toBeVisible();
  await expect(page.getByTestId("presenter-notes")).toHaveText("No notes for this slide.");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("presenter-notes")).toHaveText("Open with how many carts are lost when a session ends.");
  await expect(presenter.getByRole("region", { name: "Slide 3 of 10: Goal trace" })).toBeVisible();
  await page.getByRole("button", { name: "Audience view" }).click();
  await expect(page.getByTestId("audience-view")).toBeVisible();

  await page.getByRole("link", { name: "Exit" }).click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2$/);
});

test("present: viewers present too; a version without a brief has nothing to present", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/documents/saved-carts/v/2/present?view=presenter&slide=4");
  await expect(page.getByTestId("presenter-view")).toBeVisible();
  await expect(page.getByTestId("slide-counter")).toHaveText("4 / 10");
  await page.goto("/documents/saved-carts/v/2");
  await expect(page.getByRole("link", { name: "Present" })).toBeVisible();
  await expect(section(page, "summary").getByRole("group", { name: /Verdict for/ })).toHaveCount(0);

  await page.goto("/documents/checkout-redesign/v/2/present");
  await expect(page.getByTestId("present-mode")).toContainText("has no brief sections");
});

test("exports: Brief, Full and Deck downloads", async ({ page }) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  const cases: [string, string][] = [
    ["Export brief PDF", "saved-carts-v2-brief.pdf"],
    ["Export brief HTML", "saved-carts-v2-brief.html"],
    ["Export deck PDF", "saved-carts-v2-deck.pdf"],
    ["Export deck PPTX", "saved-carts-v2-deck.pptx"],
    ["Export MD", "saved-carts-v2.md"],
  ];
  for (const [name, file] of cases) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name }).click();
    expect((await download).suggestedFilename()).toBe(file);
  }
  // Without a brief only the full exports are offered.
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByRole("button", { name: "Export PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export brief PDF" })).toHaveCount(0);
});

test("diff: each section says its layer, and the brief can be compared alone", async ({ page }) => {
  await login(page);
  await page.goto("/documents/saved-carts/diff?from=1&to=2");
  const changed = page.getByTestId("diff-section").filter({ hasText: "Problem" });
  await expect(changed.getByTestId("layer-badge")).toHaveText("Brief");
  await page.getByLabel("Show unchanged sections").check();
  await expect(page.getByTestId("diff-section").filter({ hasText: "Feature detail" }).getByTestId("layer-badge")).toHaveText(
    "Detail",
  );
  await page.getByLabel("Brief sections only").check();
  await expect(page.getByTestId("diff-section")).toHaveCount(8);
});

test("templates: the editor shows the brief sections and reports a template without any", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/new");
  const body = page.getByLabel("Body");
  await expect(page.getByTestId("brief-sections")).toHaveText("problem, solution");
  await expect(page.getByTestId("template-warnings")).toHaveCount(0);
  await body.fill((await body.inputValue()).replace("brief: [problem, solution]\n", ""));
  await expect(page.getByTestId("template-warnings")).toContainText("marks no brief sections");
  // Valid all the same: a template without a brief can be saved; its documents open full.
  await expect(page.getByTestId("validation-ok")).toBeVisible();
  await body.fill((await body.inputValue()).replace("## Solution {#solution}", "# Full version {#full}\n\n## Solution {#solution}"));
  await expect(page.getByTestId("brief-sections")).toHaveText("problem");
  await expect(page.getByTestId("template-warnings")).toHaveCount(0);
});
