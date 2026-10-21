import { expect, test, type Page } from "@playwright/test";

import { login, openSection, section, sectionStrip, selectText, showAll } from "./helpers";

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

/** Wait until the mock (which runs in the page) has saved this member's view choice. */
const savedView = (page: Page, view: "brief" | "full") =>
  expect
    .poll(() => page.evaluate((v) => localStorage.getItem("po-mock-db-v2")?.includes(`"document_view":"${v}"`), view))
    .toBe(true);

const sections = (page: Page) => page.getByTestId("document-sections").filter({ visible: true });
/** The outline's names: the sections of the current mode (Brief or Full), in order. */
const stripItems = (page: Page) => sectionStrip(page).getByTestId("outline-name");
/** An outline name is its heading. */
const headingsAre = (names: string[]) => names.map((h) => new RegExp(`${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

test("brief: a document opens on its brief; Show full document switches, and the choice is remembered", async ({
  page,
}) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await expect(stripItems(page)).toHaveText(headingsAre(BRIEF));
  await expect(page.getByTestId("view-note")).toContainText("Brief: 8 of 20 sections");
  await openSection(page, "summary");
  await expect(section(page, "summary").getByTestId("layer-badge").first()).toHaveText("Brief");
  // Presenter notes belong to Present mode: the document does not show the notes block.
  await expect(section(page, "summary").first()).toContainText("approve the beta scope");
  await expect(section(page, "summary").first()).not.toContainText("Open with how many carts");
  await expect(section(page, "summary").first().locator("pre")).toHaveCount(0);
  // The detail is not shown.
  await expect(section(page, "feature-detail")).toHaveCount(0);

  await expect(stripItems(page).filter({ hasText: "Feature detail" })).toHaveCount(0);

  await page.getByRole("button", { name: "Show full document" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await expect(sectionStrip(page).getByTestId("chip-all")).toHaveText(/All\s*20/);
  await expect(stripItems(page).first()).toHaveText(/Saved carts PRD$/);
  await openSection(page, "feature-detail");
  await expect(section(page, "feature-detail").getByTestId("layer-badge").first()).toHaveText("Detail");

  // Remembered for this user: after a reload and on another version. The mock saves the
  // choice inside the page, so wait for it before reloading.
  await savedView(page, "full");
  await page.reload();
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await page.goto("/documents/saved-carts/v/1");
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Brief" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await savedView(page, "brief");
  await page.reload();
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await page.keyboard.press("v");
  await expect(sections(page)).toHaveAttribute("data-view", "full");

  // A version without a brief shows every section, with no view switch or Present.
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "s-5-3");
  await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Present" })).toHaveCount(0);
  await expect(page.getByTestId("layer-badge")).toHaveCount(0);
});

test("a link to a detail section opens the full document at it, once; the brief stays one click away", async ({
  page,
}) => {
  // Its own member: the mock keeps one saved view per member, and this test saves one.
  await login(page, "viewer@example.com");
  // A roadmap item's link to its PRD feature: the feature is detail, not in the brief.
  await page.goto("/documents/saved-carts/v/2#s-feature-detail");
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await expect(section(page, "feature-detail")).toBeInViewport();
  // Not saved as the user's choice, and not forced again on the way back to the brief.
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Brief" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "brief");
  await expect(section(page, "feature-detail")).toHaveCount(0);
  // The same from inside the app: a client-side navigation, as a roadmap's PRD link makes
  // (Next writes the URL only after the new page renders).
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await expect(page.getByTestId("document-sections").filter({ visible: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push(
      "/documents/saved-carts/v/2#s-feature-detail",
    ),
  );
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2#s-feature-detail$/);
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await expect(section(page, "feature-detail")).toBeInViewport();

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
  const items = await openSection(page, "brief-items");

  await items.getByRole("button", { name: "Expand Save cart" }).click();
  const detail = section(page, "feature-save-cart");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("layer-badge")).toHaveText("Detail");
  await expect(detail).toContainText("I want my cart kept when I leave");
  await expect(items.getByRole("button", { name: "Collapse Save cart" })).toHaveAttribute("aria-expanded", "true");
  // The milestone in the same table expands too, and so does the outcome-level roadmap's.
  await items.getByRole("button", { name: "Expand Beta" }).click();
  await expect(section(page, "milestone-beta")).toContainText("Exit: two weeks without a lost cart");
  // Expanded detail is content only: the open section keeps the one review bar.
  await expect(page.getByTestId("review-bar").filter({ visible: true })).toHaveCount(1);

  // Comment on the expanded detail: anchored there, labelled Detail in the panel.
  await selectText(page, "feature-save-cart", "my cart kept when I leave");
  await page.getByRole("button", { name: /^Comment(\s+c)?$/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Kept for how long?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();
  await expect(detail.locator("mark.hl-comment")).toHaveText("my cart kept when I leave");
  const detailComment = page.getByTestId("comment").filter({ hasText: "Kept for how long?" });
  await expect(detailComment.getByTestId("layer-badge")).toHaveText("Detail");

  // And on a brief section: labelled Brief.
  await openSection(page, "problem");
  await selectText(page, "problem", "lose it when they move to a laptop");
  await page.getByRole("button", { name: /^Comment(\s+c)?$/ }).click();
  await dialog.getByLabel("Comment").fill("How often?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(page.getByTestId("comment").filter({ hasText: "How often?" }).getByTestId("layer-badge")).toHaveText("Brief");

  // Verdicts work on the brief, and on detail from its expansion (in the full document).
  const summary = await openSection(page, "summary");
  const bar = summary.getByTestId("review-bar");
  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
  const roadmap = await openSection(page, "brief-roadmap");
  await roadmap.getByRole("button", { name: "Expand General release" }).click();
  await expect(section(page, "milestone-ga")).toContainText("opt-outs below 2%");
  await section(page, "milestone-ga").getByRole("button", { name: "Review General release in the full document" }).click();
  await expect(sections(page)).toHaveAttribute("data-view", "full");
  await expect(page).toHaveURL(/#milestone-ga$/);
  const detailBar = section(page, "milestone-ga").getByTestId("review-bar");
  await detailBar.getByRole("button", { name: "Request changes" }).click();
  await detailBar.getByLabel(/What should change/).fill("Name the opt-out source.");
  await detailBar.getByRole("button", { name: /^Save/ }).click();
  await expect(detailBar.getByTestId("verdict-state")).toContainText("Changes requested");

  // Back on the brief, Collapse hides the detail again; a comment on it opens it from the panel.
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Brief" }).click();
  await openSection(page, "brief-items");
  await items.getByRole("button", { name: "Collapse Save cart" }).click();
  await expect(section(page, "feature-save-cart")).toHaveCount(0);
  await showAll(page);
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

test("present: a slide without a notes block says so in the presenter view", async ({ page }) => {
  await login(page);
  // Slide 2 (Summary) has a notes block; Problem (slide 4) and the title slide do not.
  await page.goto("/documents/saved-carts/v/2/present?view=presenter&slide=2");
  const notes = page.getByTestId("presenter-notes");
  await expect(notes).toHaveText("Open with how many carts are lost when a session ends.");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("slide-counter")).toHaveText("4 / 10");
  await expect(page.getByTestId("presenter-view").getByRole("region", { name: "Slide 4 of 10: Problem" })).toBeVisible();
  await expect(notes).toHaveText("No notes for this slide.");
  await page.keyboard.press("Home");
  await expect(notes).toHaveText("No notes for this slide.");
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
  await page.getByRole("button", { name: "Export", exact: true }).click();
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
  await page.getByRole("button", { name: "Export", exact: true }).click();
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

test("templates: the editor shows the brief sections and refuses a template without any", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/new");
  await page.getByLabel("Key").fill("no-brief");
  await page.getByLabel("Name").fill("No brief");
  const body = page.getByLabel("Body");
  const create = page.getByRole("button", { name: "Create template" });
  await expect(page.getByTestId("brief-sections")).toHaveText("problem, solution");
  await expect(create).toBeEnabled();
  await body.fill((await body.inputValue()).replace("brief: [problem, solution]\n", ""));
  // O1g: a template without brief sections is refused, and the editor says how to fix it.
  await expect(page.getByTestId("problems")).toContainText("marks no brief sections");
  await expect(page.getByTestId("validation-ok")).toHaveCount(0);
  const fix = page.getByTestId("brief-fix");
  await expect(fix).toContainText("brief: [summary, problem, decisions]");
  await expect(fix).toContainText("# Full version {#full}");
  await expect(create).toBeDisabled();
  // Either fix works: a heading after the brief sections...
  await body.fill((await body.inputValue()).replace("## Solution {#solution}", "# Full version {#full}\n\n## Solution {#solution}"));
  await expect(page.getByTestId("brief-sections")).toHaveText("problem");
  await expect(page.getByTestId("brief-fix")).toHaveCount(0);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page).toHaveURL(/\/settings\/templates\/no-brief$/);
  await expect(page.getByTestId("version-brief")).toHaveText("problem");
});
