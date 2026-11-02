import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The owner's picks for Priorities and Home (mock-up picks, Nov 1), built as the only behaviour:
 * - QP1 "Two headed parts": with a dated line, the ranked list is two parts, "Makes <line>" and
 *   "Misses <line>", each with its count and "in rank order"; no row carries a Misses pill, no
 *   divider and no "N of M miss" sentence; each row keeps its real rank, rising in each part.
 * - QP2 "Numbers, no bar": a row reads value · confidence · weeks · score, with no bar.
 * - QP3 "Labelled row, confirm": the suggestions drawer has one row at the top with
 *   "+ Suggest a feature", "✦ Get more from Oracle" and "Ask in the chat"; each look-alike has its
 *   own Duplicate button, which asks in place before it declines; the message has Undo.
 * - QP4 "Confirm, filtered list": Home's proposal rows stay short; Accept on one that moves dates
 *   opens a window listing each item with its old and new dates; a goal card opens Priorities
 *   showing only that goal, with "Show all", and says so when nothing is planned for it.
 * fails_when = any of the above is missing (the old pill, bar, links or one-press Accept is back).
 */

const PHONE = { width: 390, height: 844 };
const SIZES = [
  { name: "desktop", phone: false },
  { name: "phone", phone: true },
];

async function setUp(page: Page, opts: { scenario?: string | null; phone?: boolean } = {}) {
  const { scenario = null, phone = false } = opts;
  await page.setViewportSize(phone ? PHONE : { width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
}

async function openPriorities(page: Page, query = "") {
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

const lineSelect = (page: Page) => page.getByTestId("line-picker").getByLabel("Line", { exact: true });
const toast = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });

async function ranks(rows: Locator): Promise<number[]> {
  return (await rows.getByTestId("prio-rank").allTextContents()).map((t) => Number(t.trim()));
}

for (const v of SIZES) {
  test.describe(`build-plan picks (${v.name})`, () => {
    test(`QP1: a dated line splits the ranked list into Makes and Misses parts (${v.name})`, async ({ page }) => {
      await setUp(page, { phone: v.phone });
      await openPriorities(page, "?tab=ranked");
      const options = await page.locator("#prio-line option").allTextContents();
      for (const start of ["Customer conference", "Milestone: Beta"]) {
        const label = options.find((o) => o.startsWith(start));
        expect(label, options.join(" | ")).toBeTruthy();
        await lineSelect(page).selectOption({ label: label! });
        const heads = page.getByTestId("prio-part-head");
        await expect(heads).toHaveCount(2);
        await expect(heads.nth(0)).toContainText(/^Makes .+/);
        await expect(heads.nth(1)).toContainText(/^Misses .+/);
        await expect(heads.nth(0)).toContainText("in rank order");
        // The pill, the divider and the "N of M miss" sentence are gone: the headings say it once.
        await expect(page.getByLabel("Ranked list").getByTestId("prio-misses")).toHaveCount(0);
        await expect(page.getByTestId("line-divider")).toHaveCount(0);
        await expect(page.getByTestId("line-caption")).toHaveCount(0);
        // Each part's count is its rows, every row above the line in Makes, each part by rank.
        const items = page.getByLabel("Ranked list").locator(":scope > li");
        const kinds = await items.evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") === "prio-part-head" ? "head" : e.querySelector('[data-testid="prio-row"]') || e.getAttribute("data-testid") === "prio-row" ? "row" : "other")));
        const second = kinds.indexOf("head", 1);
        expect(kinds[0]).toBe("head");
        expect(second).toBeGreaterThan(0);
        const makes = kinds.slice(1, second).filter((k) => k === "row").length;
        const misses = kinds.slice(second + 1).filter((k) => k === "row").length;
        await expect(page.getByTestId("prio-part-count").nth(0)).toHaveText(`${makes} ${makes === 1 ? "feature" : "features"}, in rank order`);
        await expect(page.getByTestId("prio-part-count").nth(1)).toHaveText(`${misses} ${misses === 1 ? "feature" : "features"}, in rank order`);
        const all = await ranks(page.getByTestId("prio-row"));
        expect(all.length).toBe(makes + misses);
        for (const part of [all.slice(0, makes), all.slice(makes)]) expect(part).toEqual([...part].sort((a, b) => a - b));
        const marks = await page.getByTestId("prio-row").getByTestId("prio-line-mark").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
        expect(marks).toEqual([...Array(makes).fill("Above the line"), ...Array(misses).fill("Below the line")]);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test(`QP2: a row reads value · confidence · weeks · score, with no bar (${v.name})`, async ({ page }) => {
      await setUp(page, { phone: v.phone });
      await openPriorities(page, "?tab=ranked");
      const rows = page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-score") });
      await expect(rows.first()).toBeVisible();
      for (const r of await rows.all()) {
        const numbers = r.getByTestId("prio-numbers");
        const m = /^·value ([\d.]+)·confidence ([\d.]+)·([\d.]+) wk·score ([\d.]+)$/.exec((await numbers.textContent()) ?? "");
        expect(m, (await r.textContent()) ?? "").not.toBeNull();
        const [, value, conf, effort, score] = m!.map(Number);
        expect(Math.abs((value * conf) / effort - score)).toBeLessThan(0.011);
        // No bar: nothing in the numbers is drawn with a width.
        expect(await numbers.locator("[style*='width']").count()).toBe(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    test(`QP3: the drawer's labelled row, and a look-alike's Duplicate asks first, with Undo (${v.name})`, async ({ page }) => {
      await setUp(page, { scenario: "simple-plan", phone: v.phone });
      await openPriorities(page, "?tab=buckets");
      await page.getByTestId("goal-ask-oracle").first().click();
      const drawer = page.getByTestId("goal-panel");
      const actions = drawer.getByTestId("suggest-actions");
      await expect(actions.getByRole("button")).toHaveText(["+ Suggest a feature", "✦ Get more from Oracle", "Ask in the chat"]);
      // The three sit on one row.
      const tops = await actions.getByRole("button").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(12);
      await drawer.getByTestId("suggestions-tab-oracle").click();
      const looks = drawer.getByTestId("suggestion-looks-like");
      await expect(looks.first()).toBeVisible({ timeout: 15_000 });
      await expect(drawer.getByText("Same as this: decline the suggestion")).toHaveCount(0);
      const card = drawer.locator("li").filter({ has: looks.first() }).first();
      const title = ((await card.locator("p").first().textContent()) ?? "").trim();
      const count = await looks.count();
      await expect(drawer.getByTestId("looks-like-duplicate")).toHaveCount(count);
      const like = ((await looks.first().getByTestId("looks-like-link").textContent()) ?? "").trim();
      await looks.first().getByTestId("looks-like-duplicate").click();
      const confirm = looks.first().getByTestId("looks-like-confirm");
      await expect(confirm).toContainText(`Decline ${title} as a duplicate of ${like}?`);
      // Cancel leaves it; Duplicate again, then confirm.
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);
      await looks.first().getByTestId("looks-like-duplicate").click();
      await looks.first().getByRole("button", { name: "Decline as duplicate" }).click();
      const message = toast(page, `Declined ${title} as a duplicate of ${like}`);
      await expect(message).toBeVisible();
      await expect(drawer.getByText(title, { exact: true })).toHaveCount(0);
      await message.getByRole("button", { name: "Undo" }).click();
      await expect(drawer.getByText(title, { exact: true })).toBeVisible();
    });

    test(`QP4: Accept on a move confirms its dates first; a goal card opens Priorities for that goal (${v.name})`, async ({ page }) => {
      await setUp(page, { scenario: "simple-home", phone: v.phone });
      await page.goto("/simple");
      await expect(page.getByTestId("home-greeting")).toBeVisible();
      const row = page.getByTestId("home-proposal").filter({ hasText: "Weekly alert digest" }).filter({ hasText: "Both start before Alert rules engine ends" });
      await expect(row).toHaveCount(1);
      // The row stays short: no list of moves on Home.
      await expect(row.getByText("Mobile alert push")).toHaveCount(0);
      await row.getByRole("button", { name: "Accept" }).click();
      const dialog = page.getByRole("dialog", { name: /^Accept: / });
      await expect(dialog).toBeVisible();
      const moves = dialog.getByTestId("accept-moves-list").getByRole("listitem");
      await expect(moves).toHaveCount(2);
      await expect(moves.nth(0)).toContainText("Weekly alert digest");
      await expect(moves.nth(1)).toContainText("Mobile alert push");
      for (const m of await moves.all()) {
        await expect(m.locator("del")).toHaveText(/^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/);
        await expect(m.locator("ins")).toHaveText(/^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/);
      }
      const after = await moves.locator("ins").allTextContents();
      await dialog.getByRole("button", { name: "Accept and move 2 items" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(toast(page, `Accepted: Weekly alert digest now ${after[0]}; Mobile alert push now ${after[1]}`)).toBeVisible();
      await expect(row).toHaveCount(0);

      // A goal card opens Priorities showing only its goal.
      await page.getByTestId("home-goal-link").filter({ hasText: "Grow retention" }).click();
      await expect(page).toHaveURL(/\/simple\/priorities\?goal=Grow(\+|%20)retention/);
      const filter = page.getByTestId("prio-goal-filter");
      await expect(filter).toContainText(/^Showing Grow retention only: \d+ of \d+ features/);
      const goals = await page.getByTestId("prio-row").getByTestId("prio-goal").allTextContents();
      expect(goals.length).toBeGreaterThan(0);
      expect(new Set(goals)).toEqual(new Set(["Grow retention"]));
      await filter.getByRole("button", { name: "Show all" }).click();
      await expect(filter).toHaveCount(0);
      expect(new Set(await page.getByTestId("prio-row").getByTestId("prio-goal").allTextContents()).size).toBeGreaterThan(1);

      await page.goto("/simple");
      await page.getByTestId("home-goal-link").filter({ hasText: "Keep alerts quiet" }).click();
      await expect(page.getByTestId("prio-goal-filter")).toContainText("Showing Keep alerts quiet only: nothing for this goal is planned yet");
      await expect(page.getByTestId("prio-row")).toHaveCount(0);
    });
  });
}
