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
const switcher = (page: Page) => page.getByTestId("section-switcher").filter({ visible: true });

/** Fails when any element makes the page scroll sideways. */
async function noSidewaysScroll(page: Page) {
  // The page itself scrolls now (PT1 a): its scrollbar takes its width off the page, not more.
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
  expect(sw, "page scroll width").toBeLessThanOrEqual(iw);
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

// The outline rail (folded chapters, status-mark shapes) and the switcher below 1280 px are gone
// on a PRD (PT1 a): the contents rail and its review dots are covered by prd-look.spec.ts.

// '/' filter + arrow-key list focus + global j/k stepping were the outline rail's own keys
// (PT1 a): the PRD contents rail has no keyboard shortcuts of its own, so that test is gone.

// The rail's collapse/expand and the switcher standing in for it are gone on a PRD (PT1 a):
// the contents rail has no collapse button and there is no switcher to stand in for it.

test("phone: a Sections / Review bar opens sheets that close on Escape, the scrim and a swipe, with focus kept inside", async ({ page }) => {
  await bigPrd(page, { width: 390, height: 844 });
  await page.goto(`${BIG}#2-2-evidence-from-support`);
  await expect(section(page, "2-2-evidence-from-support")).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect(switcher(page)).toHaveCount(0);
  const sectionsBtn = page.getByTestId("phone-sections");
  const reviewBtn = page.getByTestId("phone-review");
  // PT1 a: "Section <num> of <chapters>", the num from the heading level, not a position count.
  await expect(sectionsBtn).toHaveText("Section 2.2 of 13");
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
  await expect(sectionsBtn).toHaveText("Section 2.3 of 13");

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
  // PT1 a: the contents rail shows a status dot, not a feedback count badge (gone).

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

  // Open the contents to every section, far taller than the screen (PT1 a: no folding/Unfold).
  await page.getByRole("button", { name: "Contents: find a section" }).click();
  const contentsRail = page.locator(".prd-rail");
  const panelScroll = page.getByTestId("review-tabpanel").filter({ visible: true });
  for (const box of [contentsRail, panelScroll]) {
    const { sh, ch } = await box.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(sh).toBeGreaterThan(ch);
  }
  const bottomOnScreen = async () => {
    for (const el of [contentsRail, page.getByTestId("review-panel")]) {
      await expect.poll(async () => {
        const b = (await el.boundingBox())!;
        return b.y + b.height;
      }).toBeLessThanOrEqual(vh);
    }
  };
  // Without scrolling the page, and with the page scrolled to the document's foot.
  await bottomOnScreen();
  await panelScroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByTestId("review-panel").getByTestId("feedback-item").last()).toBeInViewport();
  await contentsRail.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(outlineRow(page, "glossary-guest")).toBeInViewport();
  await section(page, "glossary-guest").scrollIntoViewIfNeeded();
  await bottomOnScreen();
  await expect(contentsRail).toBeInViewport();
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
  // The contents rail's own row marks the current section with aria-current="location".
  await expect(outlineRow(page, "6-5-changing-a-role")).toHaveAttribute("aria-current", "location");
  await expect(outlineRow(page, "6-5-changing-a-role")).toHaveAttribute("href", `${BIG}#6-5-changing-a-role`);
  // A legacy link clicked inside the page opens its section too, and makes it current.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "#s-9-1-global-search";
    a.textContent = "legacy";
    a.id = "legacy-link";
    document.querySelector('[data-testid="document-sections"]')!.append(a);
  });
  await page.locator("#legacy-link").click();
  await expect(section(page, "9-1-global-search")).toBeVisible();
  await expect(outlineRow(page, "9-1-global-search")).toHaveAttribute("aria-current", "location");
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
