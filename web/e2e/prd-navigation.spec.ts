import { expect, test, type Locator, type Page } from "./test";

import { feedbackState, login, openTab, outlineRow, section, showAll } from "./helpers";

// I3 PRD navigation (owner, 2026-10-20): an outline rail left of the section (>= 1280 px),
// a section switcher below 1280 px, Sections / Review sheets on a phone, and a review panel
// of three tabs (Feedback, Sources, History). No sideways-scrolling strips.
// The big-prd mock scenario adds platform-handbook: 104 sections in nested chapters, mixed
// review states, comments and Oracle suggestions (lib/api/mock/big-prd.ts).

const BIG = "/documents/platform-handbook/v/1";

async function bigPrd(page: Page, size?: { width: number; height: number }) {
  if (size) await page.setViewportSize(size);
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "big-prd"));
  await login(page);
}

const rail = (page: Page) => page.getByTestId("outline-rail").filter({ visible: true });
const railRows = (page: Page) => rail(page).locator("a[data-outline-key]");
const switcher = (page: Page) => page.getByTestId("section-switcher").filter({ visible: true });
const popover = (page: Page) => page.getByTestId("switcher-popover");
const trigger = (page: Page) => page.getByTestId("switcher-trigger").filter({ visible: true });

/** Fails when any element makes the page scroll sideways. */
async function noSidewaysScroll(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
  expect(sw, "page scroll width").toBe(iw);
}

/** No visible text under 13 px inside `el`. */
async function noSmallText(el: Locator) {
  const small = await el.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")]
      .filter((e) => e.checkVisibility() && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()))
      .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 13)
      .map((e) => e.textContent),
  );
  expect(small).toEqual([]);
}

/** The element's box lies inside the viewport. */
async function insideViewport(page: Page, el: Locator) {
  const box = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
}

test("outline rail: every section, grouped by chapter and folded; the current chapter open; status marks by shape", async ({ page }) => {
  await bigPrd(page, { width: 1440, height: 900 });
  await page.goto(BIG);
  await expect(rail(page)).toBeVisible();
  await expect(rail(page)).toHaveCSS("width", "280px");
  await expect(rail(page).getByTestId("review-progress")).toHaveText(/13 of 104 sections reviewed/);
  await expect(rail(page).getByTestId("chip-all")).toHaveText(/All\s*104/);

  // The first unreviewed section opens: 2.2, inside chapter 2, which is open; the others fold.
  await expect(section(page, "2-2-evidence-from-support")).toBeVisible();
  const current = outlineRow(page, "2-2-evidence-from-support");
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(current).toBeInViewport();
  await expect(outlineRow(page, "ch-2")).not.toHaveAttribute("data-folded", "true");
  const billing = outlineRow(page, "ch-7");
  await expect(billing).toHaveAttribute("data-folded", "true");
  await expect(billing.getByTestId("outline-folded-count")).toHaveText("1/9");
  await expect(outlineRow(page, "7-1-plans")).toHaveCount(0);
  // 1 title + 12 chapters + the appendix, plus chapter 2's five parts.
  await expect(railRows(page)).toHaveCount(14 + 5);

  // A chevron unfolds a chapter; its parts are indented under it.
  await rail(page).getByRole("button", { name: "Unfold 7. Billing" }).click();
  await expect(outlineRow(page, "7-1-plans")).toBeVisible();
  await expect(outlineRow(page, "7-3-invoices")).toHaveAttribute("data-folded", "true");
  await rail(page).getByRole("button", { name: "Fold 7. Billing" }).click();
  await expect(outlineRow(page, "7-1-plans")).toHaveCount(0);

  // Status marks differ in shape, and only an approved section shows a check.
  const mark = (key: string) => outlineRow(page, key).getByTestId("status-mark");
  await rail(page).getByRole("button", { name: "Unfold 1. Goals and outcomes" }).click();
  await expect(mark("1-2-north-star-metric")).toHaveAttribute("data-state", "approved");
  await expect(mark("1-3-guardrail-metrics")).toHaveAttribute("data-state", "changes_requested");
  await expect(mark("1-5-assumptions")).toHaveAttribute("data-state", "rejected");
  await expect(mark("2-3-evidence-from-sales-calls")).toHaveAttribute("data-state", "none");
  const CHECK = 'path[d^="M4.8 8.2"]';
  await expect(mark("1-2-north-star-metric").locator(CHECK)).toHaveCount(1);
  await expect(mark("1-3-guardrail-metrics").locator(CHECK)).toHaveCount(0);
  await expect(mark("1-5-assumptions").locator(CHECK)).toHaveCount(0);
  await expect(mark("1-3-guardrail-metrics").locator("path").first()).toHaveAttribute("d", /^M8 0\.9/);
  await expect(mark("1-5-assumptions").locator("rect")).toHaveCount(1);
  // Each row: its name (a tooltip when cut off) and its open-feedback count.
  await expect(outlineRow(page, "1-3-guardrail-metrics").getByTestId("outline-count")).toHaveText("2");
  await expect(outlineRow(page, "1-3-guardrail-metrics")).toHaveAttribute("title", "1.3 Guardrail metrics");

  // A deep link opens its chapters and keeps the row in view inside the rail's own scroll.
  await page.goto(`${BIG}#11-3-retention-2`);
  await expect(section(page, "11-3-retention-2")).toBeVisible();
  await expect(outlineRow(page, "11-3-retention-2")).toHaveAttribute("aria-current", "true");
  await expect(outlineRow(page, "11-3-retention-2")).toBeInViewport();
  await noSmallText(rail(page));
  await noSmallText(page.getByTestId("review-panel"));
  await noSidewaysScroll(page);
});

test("outline rail: '/' filters by name, the chips narrow, arrows and Enter pick, j/k step anywhere", async ({ page }) => {
  await bigPrd(page, { width: 1440, height: 900 });
  await page.goto(BIG);
  await expect(section(page, "2-2-evidence-from-support")).toBeVisible();

  await page.keyboard.press("/");
  const box = rail(page).getByTestId("outline-filter");
  await expect(box).toBeFocused();
  await page.keyboard.type("invoice");
  // The matches, with their chapters for context.
  await expect(railRows(page).getByTestId("outline-name")).toHaveText(["7. Billing", "7.3 Invoices", "7.3.1 Invoice numbering"]);
  await page.keyboard.press("ArrowDown");
  await expect(railRows(page).first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(outlineRow(page, "7-3-invoices")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(outlineRow(page, "7-3-invoices")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#7-3-invoices$/);
  await expect(section(page, "7-3-invoices")).toBeVisible();
  await box.fill("");

  // Chips: To review (no verdict) and With feedback (sections with open feedback).
  const chips = rail(page).getByTestId("outline-chips");
  await expect(chips.getByRole("button", { name: /^To review/ })).toHaveText(/To review\s*91/);
  await expect(chips.getByRole("button", { name: /^With feedback/ })).toHaveText(/With feedback\s*9/);
  await chips.getByRole("button", { name: /^With feedback/ }).click();
  const withCount = railRows(page).filter({ has: page.getByTestId("outline-count") });
  await expect(withCount).toHaveCount(9);
  await expect(outlineRow(page, "5-4-import-from-a-spreadsheet").getByTestId("outline-count")).toHaveText("2");
  await chips.getByRole("button", { name: /^To review/ }).click();
  await expect(rail(page).locator('a[data-state="approved"]').filter({ has: page.getByTestId("outline-count") })).toHaveCount(0);
  await expect(outlineRow(page, "1-2-north-star-metric")).toHaveCount(0);
  await chips.getByRole("button", { name: /^All/ }).click();

  // j / k: next and previous section from anywhere on the page.
  await page.locator("body").click({ position: { x: 700, y: 30 } });
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/#7-3-invoices-1$/);
  await expect(outlineRow(page, "7-3-invoices-1")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j");
  await expect(section(page, "7-3-invoices-2")).toBeVisible();
  await page.keyboard.press("k");
  await expect(section(page, "7-3-invoices-1")).toBeVisible();
  await expect(outlineRow(page, "7-3-invoices-1")).toBeInViewport();
});

test("outline rail: the collapse button hides it, remembered per user; the switcher stands in", async ({ page }) => {
  await bigPrd(page, { width: 1440, height: 900 });
  await page.goto(BIG);
  await expect(rail(page)).toBeVisible();
  await expect(switcher(page)).toHaveCount(0);
  await page.getByTestId("outline-collapse").click();
  await expect(rail(page)).toHaveCount(0);
  await expect(switcher(page)).toBeVisible();
  await page.reload();
  await expect(section(page, "2-2-evidence-from-support")).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await page.getByTestId("outline-expand").filter({ visible: true }).click();
  await expect(rail(page)).toBeVisible();
  await page.reload();
  await expect(rail(page)).toBeVisible();
});

test("switcher at 1200 px: arrows, i of M, Next to review, and a popover that closes every way and stays on screen", async ({ page }) => {
  await bigPrd(page, { width: 1200, height: 800 });
  await page.goto(BIG);
  await expect(rail(page)).toHaveCount(0);
  await expect(switcher(page)).toBeVisible();
  await expect(trigger(page)).toContainText("2.2 Evidence from support");
  await expect(page.getByTestId("switcher-index").filter({ visible: true })).toHaveText("10 of 104");
  await expect(trigger(page).getByTestId("status-mark")).toHaveAttribute("data-state", "none");

  await switcher(page).getByRole("link", { name: "Next section: 2.3 Evidence from sales calls" }).click();
  await expect(page).toHaveURL(/#2-3-evidence-from-sales-calls$/);
  await switcher(page).getByRole("link", { name: /^Previous section/ }).click();
  await expect(page).toHaveURL(/#2-2-evidence-from-support$/);
  await page.getByTestId("next-to-review").filter({ visible: true }).click();
  await expect(page).toHaveURL(/#2-3-evidence-from-sales-calls$/);

  // A changes-requested section never shows a check in the switcher either.
  await page.goto(`${BIG}#1-3-guardrail-metrics`);
  await expect(trigger(page).getByTestId("status-mark")).toHaveAttribute("data-state", "changes_requested");
  await expect(trigger(page).locator('path[d^="M4.8 8.2"]')).toHaveCount(0);

  // Escape closes and returns focus to the trigger.
  await trigger(page).click();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).getByTestId("outline-filter")).toBeFocused();
  await expect(popover(page).getByTestId("switcher-hints")).toHaveText(/↑↓ move · ↵ open · j k next\/previous/);
  await insideViewport(page, popover(page));
  await noSmallText(switcher(page));
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();

  // The trigger toggles it.
  await trigger(page).click();
  await expect(popover(page)).toBeVisible();
  await trigger(page).click();
  await expect(popover(page)).toHaveCount(0);

  // A click outside closes it.
  await trigger(page).click();
  await page.mouse.click(700, 760);
  await expect(popover(page)).toHaveCount(0);

  // Chapters are bold rows with their parts indented under them, nothing folds; filter and pick.
  await trigger(page).click();
  await expect(popover(page).locator('a[data-outline-key="ch-7"]')).toHaveClass(/font-bold/);
  await expect(popover(page).locator('a[data-outline-key="7-3-invoices-2"]')).toBeAttached();
  await expect(popover(page).getByTestId("outline-fold")).toHaveCount(0);
  await page.keyboard.type("quiet");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).locator('a[data-outline-key="8-4-quiet-hours"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#8-4-quiet-hours$/);
  await expect(section(page, "8-4-quiet-hours")).toBeVisible();
  await expect(trigger(page)).toBeFocused();

  // Near the foot of the page it opens upward, still fully on screen.
  await page.setViewportSize({ width: 1200, height: 420 });
  await trigger(page).click();
  await insideViewport(page, popover(page));
  await page.keyboard.press("Escape");
  await noSidewaysScroll(page);
});

test("phone: a Sections / Review bar opens sheets that close on Escape, the scrim and a swipe, with focus kept inside", async ({ page }) => {
  await bigPrd(page, { width: 390, height: 844 });
  await page.goto(BIG);
  await expect(section(page, "2-2-evidence-from-support")).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect(switcher(page)).toHaveCount(0);
  const sectionsBtn = page.getByTestId("phone-sections");
  const reviewBtn = page.getByTestId("phone-review");
  await expect(sectionsBtn).toHaveText("Section 10 of 104");
  await expect(reviewBtn).toHaveText(/Review\s*·\s*12/);
  for (const b of [sectionsBtn, reviewBtn]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await insideViewport(page, page.getByTestId("phone-bar"));

  // Sections: the outline with 44 px rows; picking one opens it and closes the sheet.
  await sectionsBtn.click();
  const sheet = page.getByRole("dialog", { name: "Sections" });
  await expect(sheet).toBeVisible();
  const row = sheet.locator('a[data-outline-key="2-3-evidence-from-sales-calls"]');
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const chip of await sheet.getByTestId("outline-chips").getByRole("button").all()) {
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  // Focus stays inside while it is open: Tab from the last control wraps to the first.
  const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  await page.keyboard.press("Shift+Tab");
  expect(await inDialog()).toBe(true);
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "Close Sections" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await inDialog()).toBe(true);
  await row.click();
  await expect(sheet).toHaveCount(0);
  await expect(section(page, "2-3-evidence-from-sales-calls")).toBeVisible();
  await expect(sectionsBtn).toHaveText("Section 11 of 104");

  // Escape, the scrim and a swipe down on the handle close it.
  await sectionsBtn.click();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await sectionsBtn.click();
  await page.getByTestId("sheet-scrim").click({ position: { x: 195, y: 40 } });
  await expect(sheet).toHaveCount(0);
  await sectionsBtn.click();
  const handle = (await page.getByTestId("sheet-handle").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect(sheet).toHaveCount(0);

  // Review: the panel, its three tabs and their counts.
  await reviewBtn.click();
  const review = page.getByRole("dialog", { name: "Review" });
  await expect(review.getByRole("tab")).toHaveText([/Feedback\s*12/, /Sources\s*0/, "History"]);
  for (const tab of await review.getByRole("tab").all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Every control in the sheet is a 44 px touch target, and no text is under 13 px.
  for (const control of await review.locator("button, select, [data-testid=feedback-goto]").filter({ visible: true }).all()) {
    expect((await control.boundingBox())!.height, await control.innerText()).toBeGreaterThanOrEqual(44);
  }
  await noSmallText(review);
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await noSidewaysScroll(page);
});

test("review panel: three tabs; Feedback is one list by state, scope and kind, with its actions at the top of each item", async ({ page }) => {
  await bigPrd(page, { width: 1440, height: 900 });
  await page.goto(`${BIG}#5-4-import-from-a-spreadsheet`);
  const panel = page.getByTestId("review-panel");
  await expect(panel.getByRole("tab")).toHaveText([/Feedback\s*12/, /Sources\s*0/, "History"]);
  // One definition of open feedback: the head, the tab and the outline agree.
  await expect(panel.getByTestId("stat-open-feedback")).toHaveText(/12/);
  await expect(panel.getByTestId("stat-reviewed")).toHaveText(/13\/104/);

  const items = panel.getByTestId("feedback-item");
  // This section: its two open items, a comment and a suggestion.
  await expect(panel.getByTestId("inspector-scope").getByRole("button", { name: /^This section/ })).toHaveAttribute("aria-pressed", "true");
  await expect(items).toHaveCount(2);
  const suggestion = items.filter({ has: page.getByTestId("suggestion") });
  const comment = items.filter({ hasNot: page.getByTestId("suggestion") });
  // Actions come right after the kind and state, before the text.
  const order = async (card: Locator) =>
    card.evaluate((el) => {
      const a = el.querySelector('[data-testid="feedback-actions"]')!;
      const t = el.querySelector('[data-testid="comment"]')!;
      return !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  await expect(suggestion.getByTestId("feedback-actions").getByRole("button")).toHaveText(["Accept", "Edit and accept", "Dismiss"]);
  expect(await order(suggestion)).toBe(true);
  // D12: an open item with no section text to accept can go to the agents.
  await expect(comment.getByTestId("feedback-actions").getByRole("button")).toHaveText(["Resolve", "Stage for agents", "Reply"]);
  expect(await order(comment)).toBe(true);
  // Go to <section> uses the one section link.
  await expect(comment.getByTestId("feedback-goto")).toHaveText("Go to 5.4 Import from a spreadsheet");
  await expect(comment.getByTestId("feedback-goto")).toHaveAttribute("href", `${BIG}#5-4-import-from-a-spreadsheet`);

  // All sections, by state: Open / Staged / Declined / Done.
  await showAll(page);
  const states = panel.getByTestId("feedback-state");
  await expect(states.getByRole("button")).toHaveText([/Open\s*12/, /Staged\s*1/, /Declined\s*1/, /Done\s*1/]);
  await expect(items).toHaveCount(12);
  await feedbackState(page, "Staged");
  await expect(items).toHaveCount(1);
  await expect(items).toContainText("Who is notified when a role changes?");
  await feedbackState(page, "Declined");
  await expect(items).toContainText("Quiet hours should follow");
  await feedbackState(page, "Done");
  await expect(items).toContainText("List the shortcuts");
  await feedbackState(page, "Open");
  // Kind: comments, suggestions, reviews.
  await panel.getByTestId("feedback-kind").selectOption("review");
  await expect(items).toHaveCount(5);
  await panel.getByTestId("feedback-kind").selectOption("suggestion");
  await expect(items).toHaveCount(2);
  await panel.getByTestId("feedback-kind").selectOption("comment");
  await expect(items).toHaveCount(5);
  await panel.getByTestId("feedback-kind").selectOption("all");

  // Go to another section from an item.
  await items.filter({ hasText: "Big customers will ask for SSO" }).getByTestId("feedback-goto").click();
  await expect(page).toHaveURL(/#4-3-explicitly-not-doing$/);
  await expect(section(page, "4-3-explicitly-not-doing")).toBeVisible();

  // Accepting stages the suggestion: it stays in view, now Staged, and the counts move.
  await page.goto(`${BIG}#5-4-import-from-a-spreadsheet`);
  await page.reload();
  const staged = panel.getByTestId("feedback-item").filter({ has: page.getByTestId("suggestion") });
  await staged.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(staged.getByTestId("feedback-state-chip")).toHaveText("Staged");
  await expect(panel.getByRole("tab", { name: /^Feedback/ })).toHaveText(/Feedback\s*11/);
  await expect(outlineRow(page, "5-4-import-from-a-spreadsheet").getByTestId("outline-count")).toHaveText("1");

  // Sources and History.
  await openTab(page, "History");
  for (const h of ["Resolutions", "Reports", "Oracle's work"]) await expect(panel.getByRole("button", { name: h, exact: true })).toHaveAttribute("aria-expanded", "true");
  await panel.getByRole("button", { name: "Oracle's work", exact: true }).click();
  await expect(panel.getByTestId("jobs-panel")).toBeHidden();
  await expect(panel.getByTestId("reports-panel")).toBeVisible();
  await openTab(page, "Sources");
  await expect(panel.getByTestId("version-info")).toContainText("Imported");
});

test("review panel: Sources counts the version's sources; no tab bar scrolls sideways", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const panel = page.getByTestId("review-panel");
  await expect(panel.getByRole("tab", { name: /^Sources/ })).toHaveText(/Sources\s*5/);
  await openTab(page, "Sources");
  await expect(panel.getByTestId("sources-list").getByRole("listitem")).toHaveCount(5);
  // Nothing in the panel scrolls sideways.
  const wide = await panel.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("*")].filter(
      (e) => e.scrollWidth > e.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(e).overflowX),
    ).length,
  );
  expect(wide).toBe(0);
});

test("tall content: the rail and the panel scroll inside themselves; each one's bottom is on screen", async ({ page }) => {
  await bigPrd(page, { width: 1440, height: 900 });
  await page.goto(`${BIG}#5-4-import-from-a-spreadsheet`);
  await expect(section(page, "5-4-import-from-a-spreadsheet")).toBeVisible();
  await showAll(page);
  const vh = 900;

  // Unfold every chapter so the rail is far taller than the screen.
  const unfold = rail(page).getByRole("button", { name: /^Unfold/ });
  for (let i = 0; i < 40 && (await unfold.count()) > 0; i++) await unfold.first().click();
  await expect(unfold).toHaveCount(0);
  const railScroll = rail(page).getByTestId("outline-scroll");
  const panelScroll = page.getByTestId("review-tabpanel").filter({ visible: true });
  for (const box of [railScroll, panelScroll]) {
    const { sh, ch } = await box.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(sh).toBeGreaterThan(ch);
  }
  const bottomOnScreen = async () => {
    for (const el of [rail(page), page.getByTestId("review-panel")]) {
      await expect.poll(async () => {
        const b = (await el.boundingBox())!;
        return b.y + b.height;
      }).toBeLessThanOrEqual(vh);
    }
  };
  // Without scrolling the page, and with the page scrolled to the card's foot.
  await bottomOnScreen();
  await panelScroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByTestId("review-panel").getByTestId("feedback-item").last()).toBeInViewport();
  await railScroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(outlineRow(page, "glossary-guest")).toBeInViewport();
  await page.getByRole("navigation", { name: "Previous and next section" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("navigation", { name: "Previous and next section" })).toBeInViewport();
  await bottomOnScreen();
  await expect(rail(page)).toBeInViewport();
  await expect(page.getByTestId("review-panel")).toBeInViewport();
});

for (const width of [390, 768, 1200, 1440]) {
  test(`no element wider than the viewport on the PRD page at ${width} px`, async ({ page }) => {
    await bigPrd(page, { width, height: 900 });
    await page.goto(BIG);
    await expect(section(page, "2-2-evidence-from-support")).toBeVisible();
    await expect(page.getByTestId("stat-open-feedback").first()).toHaveText(/12/);
    await noSidewaysScroll(page);
    await page.goto(`${BIG}#5-4-import-from-a-spreadsheet`);
    await expect(section(page, "5-4-import-from-a-spreadsheet")).toBeVisible();
    await noSidewaysScroll(page);
  });
}

test("legacy #s-key links open their section, and in-page section links use #key", async ({ page }) => {
  await bigPrd(page, { width: 1440, height: 900 });
  await page.goto(`${BIG}#s-6-5-changing-a-role`);
  await expect(section(page, "6-5-changing-a-role")).toBeVisible();
  await expect(outlineRow(page, "6-5-changing-a-role")).toHaveAttribute("aria-current", "true");
  await expect(outlineRow(page, "6-5-changing-a-role")).toHaveAttribute("href", `${BIG}#6-5-changing-a-role`);
  // A legacy link clicked inside the page opens its section too.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "#s-9-1-global-search";
    a.textContent = "legacy";
    a.id = "legacy-link";
    document.querySelector('[data-testid="document-sections"]')!.append(a);
  });
  await page.locator("#legacy-link").click();
  await expect(section(page, "9-1-global-search")).toBeVisible();
});

test("scroll strip: the chevrons scroll it and it stays where they leave it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  // qa-settings-41: Settings on a phone is a page picker now; qa-company-44: Company's tabs
  // wrap on a phone. Requests' tabs are still a strip there.
  await page.goto("/requests");
  const strip = page.getByRole("navigation", { name: "Requests" }).filter({ visible: true });
  const more = strip.getByTestId("strip-more-right");
  await expect(more).toBeVisible();
  const scroller = strip.locator(".scroll-fade");
  await expect(scroller).toHaveCSS("position", "relative");
  const before = await scroller.evaluate((el) => el.scrollLeft);
  await more.click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 40);
  const after = await scroller.evaluate((el) => el.scrollLeft);
  // Re-renders (a hover, the chevron appearing) must not snap it back to the current item.
  await page.mouse.move(10, 10);
  await page.waitForTimeout(600);
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThanOrEqual(after - 1);
  await expect(strip.getByTestId("strip-more-left")).toBeVisible();
  await strip.getByTestId("strip-more-left").click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeLessThan(after);
  await noSidewaysScroll(page);
});
