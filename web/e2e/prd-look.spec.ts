import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login, section, selectText } from "./helpers";

// PT1 a "Calm document" (owner's pick, 2026-11-06): a PRD reads as one numbered document in a
// 720 px column, with a contents rail that stays in view, lights the section being read and
// shows each section's review state; the review bar shows on the section being read only.

const CARTS = "/documents/saved-carts/v/2";
const BIG = "/documents/platform-handbook/v/1";

const DESKTOP = [
  { width: 1440, height: 900 },
  { width: 1512, height: 900 },
];
const THEMES = ["light", "dark"] as const;

async function open(page: Page, url: string, size: { width: number; height: number }, theme: "light" | "dark", scenario?: string) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: theme });
  if (scenario) await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), scenario);
  await login(page);
  await page.goto(url);
}

/** Saved carts in Full: its brief, then the full version. */
async function fullCarts(page: Page) {
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
  await expect(section(page, "sources-list")).toBeVisible();
}

const contents = (page: Page) => page.getByRole("navigation", { name: "Contents" }).filter({ visible: true });
const lit = (page: Page) => contents(page).locator("[aria-current]");
/** The review bars a reader can see. */
const bars = (page: Page) => page.getByTestId("review-bar").filter({ visible: true });

/** Scrolls with the mouse wheel until the section's top passes the reading line. */
async function scrollTo(page: Page, key: string) {
  const el = page.locator(`[data-prd-sec="${key}"]`);
  await page.mouse.move(Math.min(700, page.viewportSize()!.width / 2), 500);
  for (let i = 0; i < 80; i++) {
    const top = (await el.boundingBox())!.y;
    if (top < 120) break;
    await page.mouse.wheel(0, Math.min(400, top - 60));
    await page.waitForTimeout(60);
  }
}

for (const size of DESKTOP)
  for (const theme of THEMES) {
    const at = `${size.width}, ${theme}`;

    test(`section numbers follow the heading levels on a white sheet (${at})`, async ({ page }) => {
      await open(page, CARTS, size, theme);
      await fullCarts(page);
      const doc = page.getByRole("article", { name: "Document" });
      // Every section shows at once, numbered by its level; level-1 parts carry none.
      for (const [key, name] of [
        ["summary", "1 Summary"],
        ["decisions", "8 Decisions needed"],
        ["feature-detail", "9 Feature detail"],
        ["feature-sync", "9.2 Cart on every device"],
        ["milestones", "10 Milestones"],
        ["milestone-ga", "10.2 General release"],
        ["sources-list", "12.1 Sources"],
      ])
        await expect(section(page, key).getByRole("heading").first()).toHaveText(name);
      await expect(section(page, "title").getByRole("heading").first()).toHaveText("Introduction");
      await expect(doc.locator(".prd-divider")).toHaveText("Full version");
      // One readable column, about 720 px of text, a size up.
      const box = (await doc.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(760);
      expect(box.width).toBeGreaterThan(600);
      await expect(section(page, "summary").locator(".doc-body").first()).toHaveCSS("font-size", "16.5px");
      await expect(section(page, "summary").getByRole("heading").first()).toHaveCSS("font-size", "24px");
      // The sheet follows the theme.
      const bg = await doc.evaluate((el) => getComputedStyle(el).backgroundColor);
      const [r] = bg.match(/\d+/g)!.map(Number);
      if (theme === "dark") expect(r).toBeLessThan(80);
      else expect(r).toBeGreaterThan(200);
      // The contents number the same way and show each section's review state.
      await expect(contents(page).getByRole("link", { name: /^10\s*Milestones/ })).toBeVisible();
      await expect(contents(page).getByRole("img", { name: "Not reviewed" }).first()).toBeVisible();
    });

    test(`a heading's own number is kept, never doubled (${at})`, async ({ page }) => {
      await open(page, BIG, size, theme, "big-prd");
      await expect(section(page, "2-3-evidence-from-sales-calls").getByRole("heading").first()).toHaveText("2.3 Evidence from sales calls");
      await expect(section(page, "2-4-funnel-numbers-1").getByRole("heading").first()).toHaveText("2.4.1 Sign-up");
      await expect(section(page, "glossary-seat").getByRole("heading").first()).toHaveText("A.2 Seat");
    });

    test(`the rail lights the section scrolled to and jumps on a pick; the review bar moves with it (${at})`, async ({ page }) => {
      await open(page, BIG, size, theme, "big-prd");
      const rail = contents(page);
      await expect(rail).toBeVisible();
      // At arrival the first section is the one being read, with the only review bar.
      await expect(lit(page)).toContainText("Introduction");
      await expect(bars(page)).toHaveCount(1);
      await expect(section(page, "title").getByTestId("review-bar")).toBeVisible();

      await scrollTo(page, "ch-3");
      await expect(lit(page)).toHaveText(/^3\s*Users and jobs/);
      await expect(bars(page)).toHaveCount(1);
      await expect(section(page, "ch-3").getByTestId("review-bar")).toBeVisible();
      await expect(section(page, "ch-2").getByTestId("review-bar")).toBeHidden();
      // Every other section keeps its menu.
      await expect(section(page, "ch-2").getByRole("button", { name: "Actions for 2. Problem" })).toBeVisible();
      // The rail stays in view while the page scrolls.
      await expect(rail).toBeInViewport();

      await rail.getByRole("link", { name: /^7\s*Billing/ }).click();
      await expect(lit(page)).toHaveText(/^7\s*Billing/);
      await expect(section(page, "ch-7").getByRole("heading").first()).toBeInViewport();
      const top = (await section(page, "ch-7").boundingBox())!.y;
      expect(top).toBeLessThan(80);
      await expect(section(page, "ch-7").getByTestId("review-bar")).toBeVisible();
      await expect(bars(page)).toHaveCount(1);
      // The picked chapter opens its parts in the rail; Find a section reaches any of them.
      await expect(rail.getByRole("link", { name: /^7\.3\s*Invoices/ })).toBeVisible();
      await rail.getByRole("button", { name: "Contents: find a section" }).click();
      await rail.getByLabel("Find a section").fill("Quiet hours");
      await rail.getByRole("link", { name: /^8\.4\s*Quiet hours/ }).click();
      await expect(lit(page)).toHaveText(/^8\.4\s*Quiet hours/);
      await expect(section(page, "8-4-quiet-hours").getByTestId("review-bar")).toBeVisible();
    });

    test(`every section action still works: Edit, comment, approve (${at})`, async ({ page }) => {
      await open(page, CARTS, size, theme);
      await fullCarts(page);
      const rail = contents(page);
      // Approve from the review bar of the section being read; its dot turns Approved.
      await rail.getByRole("link", { name: /^9\s*Feature detail/ }).click();
      await rail.getByRole("link", { name: /^9\.2\s*Cart on every device/ }).click();
      const sync = section(page, "feature-sync");
      const bar = sync.getByTestId("review-bar");
      await bar.getByRole("button", { name: "Approve" }).click();
      await bar.getByTestId("verdict-submit").click();
      await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
      await expect(rail.getByRole("link", { name: /^9\.2\s*Cart on every device/ }).getByRole("img", { name: "Approved" })).toBeVisible();

      // Comment on a selection in another section.
      await rail.getByRole("link", { name: /^6\s*Non-goals/ }).click();
      const commentButton = page.getByRole("button", { name: /^Comment(\s+c)?$/ });
      await expect(async () => {
        await selectText(page, "non-goals", "Sharing a cart with someone else");
        await expect(commentButton).toBeVisible({ timeout: 1000 });
      }).toPass();
      await commentButton.click();
      const dialog = page.getByRole("dialog", { name: "New comment" });
      await dialog.getByLabel("Comment").fill("Should a shared cart wait for the next release?");
      await dialog.getByLabel("Comment").press("Control+Enter");
      await expect(dialog).toBeHidden();
      await expect(section(page, "non-goals").locator("[data-comment-ids]").first()).toBeVisible();

      // Edit from a section's menu, even one not being read.
      const reminder = section(page, "feature-reminder");
      await reminder.getByRole("button", { name: "Actions for Reminder email" }).click();
      await reminder.getByRole("menuitem", { name: "Edit the text yourself" }).click();
      const editor = reminder.getByTestId("section-editor");
      await expect(editor).toBeVisible();
      await editor.getByLabel("Section text").fill("One reminder email per cart, a day after it was left.");
      await editor.getByRole("button", { name: "Save" }).click();
      await expect(page).toHaveURL(/\/v\/3#feature-reminder$/);
      await expect(section(page, "feature-reminder")).toContainText("One reminder email per cart, a day after it was left.");
      await expect(section(page, "feature-reminder").getByRole("heading").first()).toHaveText("9.3 Reminder email");
    });

    test(`a viewer sees no Approve or Edit (${at})`, async ({ page }) => {
      await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "viewer"] as const);
      await open(page, CARTS, size, theme);
      await fullCarts(page);
      await contents(page).getByRole("link", { name: /^3\s*Problem/ }).click();
      const problem = section(page, "problem");
      await expect(problem.getByTestId("review-bar")).toBeVisible();
      await expect(problem.getByTestId("review-bar")).toContainText("Approvers review sections.");
      await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
      // Nothing to change: no Edit, and no menu to hold it.
      await expect(problem.getByRole("button", { name: "Actions for Problem" })).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "Edit the text yourself" })).toHaveCount(0);
    });
  }

for (const theme of THEMES)
  test(`phone 390: nothing wider than the screen, a wide table scrolls in its own box (${theme})`, async ({ page }) => {
    await open(page, CARTS, { width: 390, height: 844 }, theme);
    await expect(section(page, "summary").getByRole("heading").first()).toHaveText("1 Summary");
    const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
    expect(sw, "page scroll width").toBe(iw);
    // No rail and no side panel: Sections and Review sit in the bar at the foot.
    await expect(contents(page)).toHaveCount(0);
    const table = section(page, "brief-items").locator(".table-wrap");
    await table.scrollIntoViewIfNeeded();
    const box = (await table.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const { inner, outer, overflow } = await table.evaluate((el) => ({
      inner: el.scrollWidth,
      outer: el.clientWidth,
      overflow: getComputedStyle(el).overflowX,
    }));
    if (inner > outer) expect(overflow).toMatch(/auto|scroll/);
    // The Sections button names the section being read, by its number.
    await scrollTo(page, "brief-roadmap");
    await expect(page.getByTestId("phone-sections")).toHaveText(/Section 5\s*of 8/);
    await page.getByTestId("phone-sections").click();
    await page.getByTestId("sheet-sections").locator('a[data-outline-key="problem"]').click();
    await expect(page.getByTestId("phone-sections")).toHaveText(/Section 3\s*of 8/);
    await expect(section(page, "problem").getByTestId("review-bar")).toBeInViewport();
  });
