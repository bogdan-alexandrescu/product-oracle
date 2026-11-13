import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner's picks for the Simple roadmap (mk-qa4-roadmap, Nov 1), driven as a person does
 * against the mock's invented data: the Timeline zooms around today (QR1 A), each state has
 * its own look with the key on top (QR2 A), broken links sit in a panel above the chart
 * (QR3 A), and an item opens in a side panel, a sheet on a phone (QR4 A).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const WIDE = { viewport: { width: 1512, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page) {
  await page.context().addInitScript(
    ([key, themeKey]) => {
      localStorage.setItem(key, "");
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, THEME_KEY] as const,
  );
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("zoom-timeline")).toBeVisible();
}

const box = async (page: Page, testId: string) => (await page.getByTestId(testId).first().boundingBox())!;
const row = (page: Page, key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);

for (const [name, use] of [
  ["desktop", DESKTOP],
  ["1512", WIDE],
] as const) {
  test.describe(name, () => {
    test.use(use);

    test("QR1 A: the Timeline opens on 3 months around today, then 6 months, one row per item, names fixed on the left", async ({ page }) => {
      await open(page);
      const scroll = page.getByTestId("timeline-scroll");
      // Today is in sight when the page opens, on 3 months (the owner, Nov 9).
      await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
      const view = (await scroll.boundingBox())!;
      const today = await box(page, "today-line");
      expect(today.x).toBeGreaterThan(view.x);
      expect(today.x).toBeLessThan(view.x + view.width);
      // A person picks 6 months: Today stays in sight.
      await page.getByTestId("zoom-6m").click();
      await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
      const at6 = await box(page, "today-line");
      expect(at6.x).toBeGreaterThan(view.x);
      expect(at6.x).toBeLessThan(view.x + view.width);
      // One row per item, under its goal.
      await expect(page.getByTestId("timeline-lane").filter({ hasText: "Below the line" })).toBeVisible();
      // docs/ground-truth.md: a feature shows its code with its name; one in no Ground Truth feature
      // reads its name with its Not in the Ground Truth flag.
      const name = row(page, "alert-rules").getByRole("button", { name: "Alert rules engine Not in the Ground Truth", exact: true });
      await expect(name).toBeVisible();
      const before = (await name.boundingBox())!.x;
      // Scrolled sideways into next year: the names stay on the left.
      await scroll.evaluate((el) => (el.scrollLeft += 900));
      await expect.poll(async () => (await name.boundingBox())!.x).toBe(before);
      await expect(page.getByRole("button", { name: "Back to today" })).toBeVisible();
      await expect(page.getByText("Scroll sideways for earlier and later")).toBeVisible();
      // All 3 years fits the whole plan; no sideways scroll, no Back to today.
      await page.getByTestId("zoom-all").click();
      await expect(page.getByTestId("zoom-all")).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => scroll.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await expect(page.getByRole("button", { name: "Back to today" })).toHaveCount(0);
      await expect(name).toBeVisible();
      await page.getByTestId("zoom-1y").click();
      await expect(page.getByTestId("zoom-1y")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: "Back to today" })).toBeVisible();
    });

    test("QR2 A: each state has its own look and the key sits above the chart", async ({ page }) => {
      await open(page);
      const key = page.getByTestId("timeline-key");
      await expect(key).toBeVisible();
      expect((await key.boundingBox())!.y).toBeLessThan((await box(page, "timeline-scroll")).y);
      for (const [k, words] of [
        ["dated", "Dated"],
        ["draft", "Draft"],
        ["broken", "⚠ Broken link"],
        ["cut", "Cut, below the line"],
        ["today", "Today Oct 22"],
      ])
        await expect(key.locator(`li[data-key="${k}"]`)).toContainText(words);
      // Today is purple, never red.
      await expect(page.getByTestId("today-line")).toHaveCSS("background-color", "rgb(124, 58, 237)");
      // A draft is grey and dashed, with its word.
      const draft = row(page, "setup-ideas");
      await expect(draft.getByTestId("timeline-bar")).toHaveCSS("border-top-style", "dashed");
      await expect(draft.getByText("Draft", { exact: true })).toBeVisible();
      // A cut item is struck through below the line, in no red.
      const cut = row(page, "setup-tour");
      await cut.scrollIntoViewIfNeeded();
      await expect(cut.getByText("In-app tour")).toHaveCSS("text-decoration-line", "line-through");
      await expect(cut.getByTestId("timeline-bar")).not.toHaveCSS("border-top-color", "rgb(180, 35, 24)");
      // Red only for a broken link: its bar's outline and a ⚠ by its name.
      const hurt = row(page, "alert-digest");
      await expect(hurt.getByTestId("timeline-bar")).toHaveCSS("border-top-color", "rgb(180, 35, 24)");
      await expect(hurt.getByLabel("Broken link")).toBeVisible();
      await expect(row(page, "alert-rules").getByTestId("timeline-bar")).not.toHaveCSS("border-top-color", "rgb(180, 35, 24)");
    });

    test("QR3 A: broken links sit in a panel above the chart, words in full with their three fixes; Hide folds it", async ({ page }) => {
      await open(page);
      const panel = page.getByTestId("conflicts");
      await expect(panel).toBeVisible();
      expect((await panel.boundingBox())!.y).toBeLessThan((await box(page, "timeline-scroll")).y);
      const links = panel.getByTestId("conflict");
      const n = await links.count();
      expect(n).toBeGreaterThan(0);
      await expect(panel.getByRole("button", { name: `⚠ ${n} broken ${n === 1 ? "link" : "links"}` })).toBeVisible();
      const first = links.first();
      for (const fix of ["Move the dependents", "Move the dependency", "Accept as risk"]) await expect(first.getByRole("button", { name: fix })).toBeVisible();
      // The words in full: nothing cut off with an ellipsis.
      const words = first.getByRole("button").first();
      expect(await words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await words.textContent()).not.toContain("…");
      // No notice drawn over the chart.
      await expect(page.getByTestId("broken-callout")).toHaveCount(0);
      // Clicking a link's words opens its item beside the chart, its row marked.
      const item = (await first.getAttribute("data-item"))!;
      await words.click();
      await expect(page.getByTestId("item-panel")).toBeVisible();
      await expect(row(page, item)).toHaveAttribute("data-open", "true");
      await page.getByTestId("item-panel").getByRole("button", { name: /Close/ }).first().click();
      await expect(page.getByTestId("item-panel")).toHaveCount(0);
      // Accept as risk asks for one line in the panel; the link then leaves it.
      await first.getByRole("button", { name: "Accept as risk" }).click();
      await first.getByRole("textbox").fill("Last week's rules are enough");
      await first.getByRole("button", { name: "Save the risk" }).click();
      if (n === 1) await expect(page.getByTestId("conflicts")).toHaveText("No broken links");
      else await expect(panel.getByRole("button", { name: `⚠ ${n - 1} broken ${n - 1 === 1 ? "link" : "links"}` })).toBeVisible();
    });

    test("QR3 A: Hide folds the panel to one line, and the Waterfall gets the same panel with no banner over a bar", async ({ page }) => {
      await open(page);
      const panel = page.getByTestId("conflicts");
      const head = panel.getByRole("button", { name: /broken link/ });
      const y0 = (await box(page, "timeline-scroll")).y;
      await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "false");
      await expect(head).toContainText("Show");
      await expect(panel.getByTestId("conflict")).toHaveCount(0);
      expect((await box(page, "timeline-scroll")).y).toBeLessThan(y0);
      await page.getByTestId("format-waterfall").click();
      await expect(page.getByTestId("conflicts").getByTestId("conflict").first()).toBeVisible();
      await expect(page.getByTestId("broken-callout")).toHaveCount(0);
    });

    test("QR4 A: an item opens in a panel at the right; the page stays put, the row is marked, another swaps it", async ({ page }) => {
      await open(page);
      await page.getByTestId("timeline-scroll").scrollIntoViewIfNeeded();
      const y = await page.evaluate(() => window.scrollY);
      await row(page, "alert-rules").getByTestId("timeline-bar").click();
      const side = page.getByTestId("item-panel");
      await expect(side).toBeVisible();
      await expect(side.getByTestId("floating-card")).toContainText("Alert rules engine");
      await expect(row(page, "alert-rules")).toHaveAttribute("data-open", "true");
      expect(await page.evaluate(() => window.scrollY)).toBe(y);
      await expect(page.getByTestId("floating-card-backdrop")).toHaveCount(0);
      // The panel sits at the chart's right; the chart narrows but still scrolls.
      expect((await side.boundingBox())!.x).toBeGreaterThan((await box(page, "timeline-scroll")).x + 400);
      const scroll = page.getByTestId("timeline-scroll");
      await scroll.evaluate((el) => (el.scrollLeft += 500));
      await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      // Clicking another item's name swaps the panel, no closing first.
      // docs/ground-truth.md: an item in no Ground Truth feature reads its name with its flag.
      await row(page, "setup-checklist").getByRole("button", { name: "Setup checklist Not in the Ground Truth", exact: true }).click();
      await expect(side.getByTestId("floating-card")).toContainText("Setup checklist");
      await expect(row(page, "setup-checklist")).toHaveAttribute("data-open", "true");
      await expect(row(page, "alert-rules")).not.toHaveAttribute("data-open", "true");
      await page.keyboard.press("Escape");
      await expect(side).toHaveCount(0);
    });
  });
}

test.describe("desktop Group by", () => {
  test.use(DESKTOP);

  // The Timeline always puts its rows under their goal, so it offers no Group by that would do nothing;
  // the Gantt still groups by Goal, Track, PRD or Milestone.
  test("Group by shows on the Gantt, not on the Timeline that always groups by goal", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("radiogroup", { name: "Group by" }).or(page.getByTestId("group-track"))).toHaveCount(0);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    await page.getByTestId("group-track").click();
    await expect(page.getByTestId("group-track")).toBeVisible();
    await page.getByTestId("format-timeline").click();
    await expect(page.getByTestId("zoom-timeline")).toBeVisible();
    await expect(page.getByTestId("group-track")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("QR1 A, QR2 A: a phone gets a list by quarter under the key, Today marking this quarter", async ({ page }) => {
    await open(page);
    const list = page.getByTestId("timeline-list");
    await expect(list).toBeVisible();
    await expect(page.getByTestId("timeline-scroll")).toHaveCount(0);
    const key = page.getByTestId("timeline-key");
    await expect(key).toBeVisible();
    expect((await key.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
    const now = page.getByTestId("timeline-quarter").filter({ hasText: "Today Oct 22" });
    await expect(now).toHaveCount(1);
    await expect(now.getByRole("heading")).toContainText("Q4 2026");
    // Each item with its name and dates under its track band's header (tb-mk: the rows read
    // dates only; the band header names the track, and its company goal when it has one).
    await expect(row(page, "alert-rules")).toContainText("Alert rules engine");
    await expect(row(page, "alert-rules")).toContainText("Oct 1 – Nov 10");
    const band = row(page, "alert-rules").locator('xpath=preceding-sibling::li[@data-testid="timeline-band"][1]');
    await expect(band).toHaveCount(1);
    await expect(band.getByTestId("track-head")).toContainText("Usage alerts track");
    await expect(row(page, "alert-rules")).not.toContainText("Grow retention");
    // Its own goal (a roadmap goal, not a track's company goal) reads in its sheet.
    await row(page, "alert-rules").getByTestId("timeline-bar").click();
    const sheet = page.getByTestId("floating-card");
    await expect(sheet).toContainText("Alert rules engine");
    await expect(sheet).toContainText("Grow retention");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    // A cut item is struck through in its quarter.
    const cut = row(page, "setup-tour");
    await cut.scrollIntoViewIfNeeded();
    await expect(cut.getByText("In-app tour")).toHaveCSS("text-decoration-line", "line-through");
    // No page-wide sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("QR3 A: the broken links panel sits above the list with its three fixes", async ({ page }) => {
    await open(page);
    const panel = page.getByTestId("conflicts");
    expect((await panel.boundingBox())!.y).toBeLessThan((await box(page, "timeline-list")).y);
    const first = panel.getByTestId("conflict").first();
    for (const fix of ["Move the dependents", "Move the dependency", "Accept as risk"]) await expect(first.getByRole("button", { name: fix })).toBeVisible();
    await panel.getByRole("button", { name: /broken link/ }).click();
    await expect(panel.getByTestId("conflict")).toHaveCount(0);
  });

  test("QR4 A: a phone opens the item as a sheet over the lower half, its row marked in sight above it", async ({ page }) => {
    await open(page);
    const item = row(page, "alert-mobile");
    await item.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 140));
    await item.getByTestId("timeline-bar").click();
    const sheet = page.getByTestId("floating-card");
    await expect(sheet).toContainText("Mobile alert push");
    await expect(item).toHaveAttribute("data-open", "true");
    const r = (await item.boundingBox())!;
    const s = (await sheet.boundingBox())!;
    expect(s.y).toBeGreaterThan(844 / 3);
    expect(r.y + r.height).toBeLessThanOrEqual(s.y);
    expect(r.y).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("item-panel")).toHaveCount(0);
  });
});
