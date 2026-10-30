import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix4, the Roadmap page's toolbar, filters, goal cards and "Needs a decision" tray
 * (qa-simple-roadmap-8, 11, 12, 13, 17, 19, 21, 22, 23, 33, 37, 38, 44, 49). Driven as a person
 * does against the mock's default scenario (web/lib/api/mock/simple-roadmap.ts: Team invite
 * nudges is a draft with no owner; Weekly alert digest depends on Alert rules engine and is
 * named by the alerts track's Beta milestone).
 */

const URL = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const toastWith = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });

async function open(page: Page, email?: string, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(([key, theme]) => localStorage.setItem(key, theme), [THEME_KEY, scheme] as const);
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("filters")).toBeVisible();
}

/** Moves a bar one week later with the keyboard, then waits for the change to be sent. */
async function nudge(page: Page, key: string) {
  const b = bar(page, key);
  await b.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
}

/** A filter's select, by its label's word (its accessible name also carries the chosen option). */
const filter = (page: Page, label: string): Locator => page.getByTestId("filters").locator("label", { hasText: new RegExp(`^${label}`) }).locator("select");

const count = async (l: Locator) => Number((await l.textContent())!.match(/(\d+)/)![1]);

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("qa-8: a draft with no owner is not a broken link; button, tiles and goal card agree", async ({ page }) => {
    await open(page);
    const activation = page.getByTestId("goal-counter").filter({ hasText: "Faster activation" });
    await expect(activation).toContainText("items");
    await expect(activation).not.toContainText("broken");
    const btn = page.getByTestId("needs-decision");
    const n = await count(btn);
    await btn.click();
    const tray = page.getByTestId("decision-tray");
    const tiles = tray.getByTestId("tray-counter");
    await expect(tiles).toHaveCount(4);
    const sum = (await tiles.locator("b").allTextContents()).reduce((s, t) => s + Number(t), 0);
    expect(sum).toBe(n);
    await expect(tray.getByTestId("tray-scope")).toContainText(`${n} on this roadmap view`);
    await expect(tray.getByTestId("tray-broken").filter({ hasText: "Team invite nudges" })).toHaveCount(0);
    await expect(tray.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" })).toHaveCount(1);
    await expect(tray.getByTestId("tray-flag").filter({ hasText: "Team invite nudges" })).toBeVisible();
  });

  test("qa-11: Group by Milestone puts the digest under the track's Beta milestone", async ({ page }) => {
    await open(page);
    await page.getByTestId("group-milestone").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", "milestone");
    await expect(bar(page, "alert-digest")).toHaveAttribute("data-lane", /^track-milestone:/);
    const beta = page.getByTestId("chart-group").filter({ has: page.locator("b", { hasText: /^Beta \(/ }) });
    await expect(beta).toHaveCount(1);
    expect(await beta.getAttribute("data-lane")).toBe(await bar(page, "alert-digest").getAttribute("data-lane"));
  });

  test("qa-12: an inverted range swaps; an empty result says so and clears", async ({ page }) => {
    await open(page);
    const from = page.getByTestId("filter-from");
    const to = page.getByTestId("filter-to");
    const last = (await from.locator("option").count()) - 1;
    await to.selectOption({ index: 1 });
    await from.selectOption({ index: last });
    await expect(toastWith(page, /swapped/)).toBeVisible();
    const [f, t] = [await from.inputValue(), await to.inputValue()];
    expect(f).not.toBe("");
    expect(f < t).toBe(true);
    // Nothing on the alerts track that late: a message and a way back, not a bare axis.
    await filter(page, "Track").selectOption({ label: "Usage alerts track" });
    await from.selectOption({ index: last });
    await to.selectOption({ index: last });
    const empty = page.getByTestId("filters-empty");
    await expect(empty).toContainText("Nothing matches these filters");
    await expect(page.getByTestId("simple-chart")).toHaveCount(0);
    await empty.getByRole("button", { name: "Clear filters" }).click();
    await expect(empty).toHaveCount(0);
    await expect(bar(page, "alert-rules")).toBeVisible();
    await expect(filter(page, "Track")).toHaveValue("");
  });

  test("qa-13: the goal cards follow the Goal filter", async ({ page }) => {
    await open(page);
    await filter(page, "Goal").selectOption({ label: "Faster activation" });
    const cards = page.getByTestId("goal-counters");
    await expect(cards).toContainText("Faster activation");
    await expect(cards).not.toContainText("Keep alerts quiet");
    await expect(cards).not.toContainText("Grow retention");
    const last = (await page.getByTestId("filter-from").locator("option").count()) - 1;
    await page.getByTestId("filter-from").selectOption({ index: last });
    await page.getByTestId("filter-to").selectOption({ index: last });
    await expect(cards).toContainText("Faster activation");
    await expect(cards).not.toContainText("Keep alerts quiet");
  });

  test("qa-17: a goal card's suggestion count opens the tab that holds them", async ({ page }) => {
    await open(page);
    const link = page.getByTestId("goal-counter-suggestions").filter({ hasText: /\d+ suggested feature/ }).first();
    await expect(link).toBeVisible();
    const n = await count(link);
    await link.click();
    const panel = page.getByTestId("goal-panel");
    const selected = panel.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveText(/· [1-9]\d*$/);
    expect(n).toBeGreaterThan(0);
    await expect(panel.getByTestId("goal-suggestion").first()).toBeVisible();
  });

  test("qa-21: a proposal names its decider and where it shows", async ({ page }) => {
    await open(page, "commenter@example.com");
    await nudge(page, "alert-export");
    const t = toastWith(page, /Moved 'Alert history export'.*proposed/);
    await expect(t).toBeVisible();
    await expect(t).toContainText("in Needs a decision");
    await expect(t).not.toContainText("the decider");
  });

  test("qa-21: a stale move says what changed and offers Reload", async ({ page }) => {
    await open(page);
    // Someone else (the same person in another tab) moves the bar first.
    const other = await page.context().newPage();
    await other.goto(URL);
    await expect(bar(other, "alert-export")).toBeVisible();
    await nudge(other, "alert-export");
    await expect(other.getByTestId("draft-count")).toHaveText("1");
    await other.close();
    await nudge(page, "alert-export");
    const t = toastWith(page, /Changed since you saw it/);
    await expect(t).toBeVisible();
    await expect(t).toContainText("dates");
    await t.getByRole("button", { name: "Reload" }).click();
  });

  test("qa-22: a commenter sees no Start review", async ({ page }) => {
    await open(page, "commenter@example.com");
    await expect(page.getByTestId("key-dates-open")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
    await expect(page.getByTestId("start-review-reason")).toHaveCount(0);
  });

  test("qa-23: Start review names the working draft and explains its choices", async ({ page }) => {
    await open(page);
    await nudge(page, "alert-export");
    await expect(page.getByTestId("draft-count")).toHaveText("1");
    await page.getByRole("button", { name: "Start review" }).click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await expect(sheet.getByTestId("start-from")).toContainText("working draft · 1 change");
    // The draft's item is on the alerts roadmap: its PRD is picked first.
    await expect(sheet.getByTestId("start-from")).toContainText("Usage alerts");
    await expect(sheet.getByTestId("start-change-mode-help")).toBeVisible();
  });

  test("qa-33: the goal cards keep one order whatever the grouping", async ({ page }) => {
    await open(page);
    const titles = () => page.getByTestId("goal-counter").locator("p:first-child").allTextContents();
    await expect(page.getByTestId("goal-counter").first()).toBeVisible();
    const byGoal = await titles();
    for (const g of ["track", "prd", "milestone"]) {
      await page.getByTestId(`group-${g}`).click();
      await expect(page.getByTestId(`group-${g}`)).toHaveAttribute("aria-pressed", "true");
      await expect.poll(titles).toEqual(byGoal);
    }
  });

  test("qa-37: Key dates and Needs a decision open below their buttons", async ({ page }) => {
    await open(page);
    const kd = page.getByTestId("key-dates-open");
    await kd.click();
    const pop = page.getByRole("dialog", { name: "Key dates" });
    await expect(pop).toBeVisible();
    const kb = (await kd.boundingBox())!;
    expect((await pop.boundingBox())!.y).toBeGreaterThanOrEqual(kb.y + kb.height);
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    const nd = page.getByTestId("needs-decision");
    await nd.click();
    const nb = (await nd.boundingBox())!;
    expect((await page.getByTestId("decision-tray").boundingBox())!.y).toBeGreaterThanOrEqual(nb.y + nb.height);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-38: the tray's tiles are even; a tile at 0 is muted (${scheme})`, async ({ page }) => {
      await open(page, undefined, scheme);
      await page.getByTestId("needs-decision").click();
      const tiles = page.getByTestId("decision-tray").getByTestId("tray-counter");
      await expect(tiles).toHaveCount(4);
      const boxes = await tiles.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })));
      for (const b of boxes) {
        expect(Math.abs(b.w - boxes[0].w)).toBeLessThanOrEqual(1);
        expect(Math.abs(b.h - boxes[0].h)).toBeLessThanOrEqual(1);
      }
      const zero = tiles.filter({ has: page.locator("b", { hasText: /^0$/ }) });
      const live = tiles.filter({ has: page.locator("b", { hasText: /^[1-9]\d*$/ }) });
      expect(await zero.count()).toBeGreaterThan(0);
      for (const z of await zero.all()) await expect(z).toHaveAttribute("data-zero", "true");
      const ink = (l: Locator) => l.locator("b").evaluate((el) => getComputedStyle(el).color);
      expect(await ink(zero.first())).not.toBe(await ink(live.first()));
      const border = (l: Locator) => l.evaluate((el) => getComputedStyle(el).borderTopWidth);
      expect(await border(zero.first())).toBe("0px");
    });
  }

  test("qa-49: the quick-add placeholder fits; the chip still says New item; the metric is not cut", async ({ page }) => {
    await open(page);
    const input = page.getByLabel("Add an item");
    await expect(input).toHaveAttribute("placeholder", "Type a title, then drag it into place");
    await input.fill("Rule import from a file");
    await expect(page.getByTestId("quick-add-chip")).toHaveText("New item");
    const metric = page.getByTestId("goal-counter").filter({ hasText: "Grow retention" }).getByTestId("goal-counter-metric");
    await expect(metric).toHaveText("Teams active after 90 days");
    expect(await metric.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("qa-19: the draft banner's words take their own line, the buttons a row under them", async ({ page }) => {
    // The change is made on a desktop width (a phone's Timeline draws lanes, not bars), then read on the phone.
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await nudge(page, "alert-export");
    await expect(page.getByTestId("draft-count")).toHaveText("1");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("simple-roadmap")).toHaveAttribute("data-phone", "true");
    const banner = page.getByTestId("draft-banner");
    const words = (await banner.getByTestId("draft-words").boundingBox())!;
    const b = (await banner.boundingBox())!;
    expect(words.width).toBeGreaterThan(b.width - 40);
    const buttons = await Promise.all(["Undo", "See changes", "Send for review"].map(async (n) => (await banner.getByRole("button", { name: n }).boundingBox())!));
    for (const x of buttons) {
      expect(x.y).toBeGreaterThanOrEqual(words.y + words.height - 1);
      expect(Math.abs(x.y - buttons[0].y)).toBeLessThanOrEqual(2);
    }
    expect(b.height).toBeLessThan(200);
  });

  test("qa-44: a phone's page actions sit above the filters and the chart", async ({ page }) => {
    await open(page);
    const actions = (await page.getByTestId("roadmap-actions").boundingBox())!;
    const filters = (await page.getByTestId("filters").boundingBox())!;
    expect(actions.y + actions.height).toBeLessThanOrEqual(filters.y);
    await expect(page.getByTestId("needs-decision")).toBeInViewport();
  });
});
