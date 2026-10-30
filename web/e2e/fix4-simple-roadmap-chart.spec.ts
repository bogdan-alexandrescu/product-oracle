import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix4-simple-roadmap-chart: the roadmap chart's QA findings, driven through the UI on the mock.
 * Timeline (goal lanes, _lanes.tsx): broken-link callouts sit under their pill with their words
 * whole, in every Group by and with the Ask panel open (qa-1); every bar is named, inside or
 * beside it, a new item as "Draft · <title>", with no ids (qa-2, 15, 3); a track milestone's
 * diamond and a suggestion's outline and "?" never sit on a name (qa-4, 31); months read "Sep",
 * the first with its year (qa-30); a chat preview ghosts where it lands (qa-10); lanes keep
 * their height for every role (qa-52); the phone's lines stand clear of the edge and its list
 * counts what it draws (qa-45). Gantt and Waterfall (_timeline.tsx): the Gantt spans every
 * slice, a row whose bar is out of view says where it is and jumps there (qa-5); a phone's
 * Gantt reads by month and wraps names (qa-6); Today's words are 11 px, clear of the header (qa-54).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const MONTH = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{4})?$/;

async function open(page: Page, scheme: "light" | "dark" = "light", scenario = "default", email: string = ADMIN.email) {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const boxes = async (l: Locator): Promise<Box[]> => (await Promise.all((await l.all()).map((x) => x.boundingBox()))).filter((b): b is Box => !!b);

/** Every callout: under its pill, over no pill, its reason whole (not cut with an ellipsis). */
async function calloutsClear(page: Page) {
  const callouts = page.getByTestId("broken-callout");
  await expect(callouts.first()).toBeVisible();
  const pills = await boxes(page.locator('g[data-testid="bar"] rect[data-body], g[data-testid="slice-bar"] rect[data-slice-body]'));
  for (const c of await callouts.all()) {
    const key = await c.getAttribute("data-item");
    const cb = (await c.boundingBox())!;
    for (const p of pills) expect(overlaps(cb, p), `${key}'s callout covers a pill`).toBe(false);
    const own = (await page.locator(`g[data-testid="bar"][data-item="${key}"] rect[data-body]`).first().boundingBox())!;
    expect(cb.y, `${key}'s callout sits under its pill`).toBeGreaterThanOrEqual(own.y + own.height - 1);
    const cut = await c.locator("span[title]").first().evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    expect(cut, `${key}'s callout words are whole`).toBe(false);
  }
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-1: callouts sit under their pill, words whole, in every Group by and with the Ask panel open (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      const svg = page.getByTestId("chart-svg");
      const wide = (await svg.boundingBox())!.width;
      await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
      await expect(page.getByTestId("ask-chat").filter({ visible: true })).toBeVisible();
      await expect.poll(async () => (await svg.boundingBox())!.width).toBeLessThan(wide - 100);
      for (const group of ["goal", "track", "prd", "milestone"] as const) {
        await page.getByTestId(`group-${group}`).click();
        await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", group);
        await expect(async () => calloutsClear(page)).toPass({ timeout: 10_000 });
      }
    });
  }

  test("qa-2, 3, 15: every Timeline bar is named (inside or beside it), never by an id; a new item reads 'Draft · <title>'", async ({ page }) => {
    await open(page);
    for (const g of await page.locator('g[data-testid="bar"]').all()) {
      const key = await g.getAttribute("data-item");
      const words = (await g.locator('[data-testid="bar-label"], [data-testid="slice-label"]').allTextContents()).join(" ").trim();
      expect(words.length, `${key} carries its name`).toBeGreaterThan(2);
      expect(words, `${key}'s label has no id`).not.toMatch(/\b[A-Z]-\d{2}[a-z]?\b|#\d/);
    }

    const title = "Push notifications for alerts";
    await page.getByLabel("Add an item").fill(title);
    const roadmap = page.getByTestId("quick-add-roadmap");
    if (await roadmap.count()) await roadmap.selectOption({ label: "Alerts roadmap" });
    await page.getByLabel("Add an item").press("Enter");
    const added = page.locator('g[data-testid="bar"]').filter({ has: page.locator("title", { hasText: `Draft · ${title}` }) });
    await expect(added).toHaveCount(1);
    await expect(added.getByTestId("bar-label")).toHaveText(/^Draft · Push/);
  });

  test("qa-4, 31: a track milestone's diamond, a suggestion's outline and its '?' never sit on a bar's name", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("item-milestone").first()).toBeAttached();
    const labels = page.locator('[data-testid="bar-label"], [data-testid="slice-label"]');
    const named = await boxes(labels);
    expect(named.length).toBeGreaterThan(3);
    for (const d of await boxes(page.getByTestId("item-milestone"))) for (const n of named) expect(overlaps(d, n), "a diamond sits on a name").toBe(false);
    for (const q of await boxes(page.locator('[data-testid="suggestion-open"] circle'))) for (const n of named) expect(overlaps(q, n), "a '?' sits on a name").toBe(false);
    // The outline is drawn under its own pill (the pill hides it there) and touches no other bar's name.
    for (const o of await page.getByTestId("suggestion-outline").all()) {
      const key = await o.getAttribute("data-item");
      const ob = (await o.boundingBox())!;
      const others = await boxes(page.locator(`g[data-testid="bar"]:not([data-item="${key}"])`).locator('[data-testid="bar-label"], [data-testid="slice-label"]'));
      for (const n of others) expect(overlaps(ob, n), `${key}'s outline runs over another name`).toBe(false);
      const under = await o.evaluate((el, k) => {
        const bar = document.querySelector(`g[data-testid="bar"][data-item="${k}"]`)!;
        return !!(el.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, key);
      expect(under, `${key}'s outline is drawn under its pill`).toBe(true);
    }
  });

  test("qa-30: the month axis reads three-letter months, the first with its year", async ({ page }) => {
    await open(page);
    const ticks = (await page.getByTestId("axis-tick").allTextContents()).map((t) => t.trim());
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect(t).toMatch(MONTH);
    expect(ticks[0]).toMatch(/ \d{4}$/);
    const xs = (await boxes(page.getByTestId("axis-tick"))).map((b) => b.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1], "ticks keep a month's room apart").toBeGreaterThan(60);
  });

  // fix4 review: a move years past the scenario's last date (Q4 2031; its span already ran to
  // late 2028), so only the preview's own days bring it in: without them the ghost was drawn
  // off the chart's right edge (x 1753 past a chart ending at 1015).
  test("qa-10: the Ask panel's Preview ghosts the bar where it lands (Q4 2031), inside the Timeline", async ({ page }) => {
    await open(page, "light", "simple-chat");
    await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
    const ask = page.getByTestId("ask-chat").filter({ visible: true });
    await ask.getByLabel("Message Oracle").fill("move Weekly alert digest to Q4 2031");
    await ask.getByRole("button", { name: "Send" }).click();
    const card = ask.getByTestId("chat-card").filter({ hasText: /Move Weekly alert digest to Oct 1/ });
    await card.getByRole("button", { name: "Preview" }).click();
    const ghost = page.getByTestId("preview-ghost");
    await expect(ghost).toHaveAttribute("data-start", "2031-10-01");
    const gb = (await ghost.boundingBox())!;
    const svg = (await page.getByTestId("chart-svg").boundingBox())!;
    expect(gb.width).toBeGreaterThan(10);
    expect(gb.x).toBeGreaterThanOrEqual(svg.x - 1);
    expect(gb.x + gb.width, "the ghost is drawn inside the chart").toBeLessThanOrEqual(svg.x + svg.width + 1);
    // Its row: the digest's own pill's row.
    const pill = (await page.locator('g[data-testid="bar"][data-item="alert-digest"] rect[data-body]').boundingBox())!;
    expect(Math.abs(gb.y - pill.y)).toBeLessThan(3);
  });

  test("qa-5: the Gantt spans every slice; a row out of view says where its bar is and jumps to it", async ({ page }) => {
    await open(page, "light", "simple-plan");
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    // The day scale (26 px a day) always scrolls sideways.
    await page.getByTestId("unit-day").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-unit", "day");
    const scroll = page.getByTestId("chart-scroll");
    const svgW = await page.getByTestId("chart-svg").evaluate((el) => el.getBoundingClientRect().width);
    // Every slice lies inside the chart's own span (none cut off past its right edge).
    const rights = await page.locator("rect[data-slice-body], rect[data-body]").evaluateAll((els, left) => els.map((e) => e.getBoundingClientRect().right - left), await page.getByTestId("chart-svg").evaluate((el) => el.getBoundingClientRect().left));
    for (const r of rights) expect(r).toBeLessThanOrEqual(svgW + 1);
    // The chart scrolls: at its left end, a row whose work is later says when, and its button scrolls there.
    await scroll.evaluate((el) => el.scrollTo({ left: 0 }));
    const cue = page.getByTestId("row-offscreen").first();
    await expect(cue).toBeVisible();
    await expect(cue).toHaveText(/^(← )?[A-Z][a-z]{2} \d{1,2}.* – .*\d/);
    const key = (await cue.getAttribute("data-item"))!;
    await cue.click();
    await expect(page.locator(`[data-testid="row-offscreen"][data-item="${key}"]`)).toHaveCount(0);
  });

  test("qa-54: Today's words on the Waterfall are 11 px or more and clear of the quarter header", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-waterfall").click();
    const today = page.getByTestId("today-mark").locator("text");
    await expect(today).toHaveText("Today");
    expect(Number(await today.getAttribute("font-size"))).toBeGreaterThanOrEqual(11);
    for (const k of await page.getByTestId("key-date-label").all()) expect(Number(await k.getAttribute("font-size"))).toBeGreaterThanOrEqual(11);
    const pill = (await page.getByTestId("today-mark").locator("rect").boundingBox())!;
    const header = Math.max(...(await boxes(page.getByTestId("axis-tick"))).map((b) => b.y + b.height));
    expect(pill.y, "Today's pill sits below the quarter header").toBeGreaterThanOrEqual(header + 2);
  });
});

for (const who of ["commenter", "viewer"] as const) {
  test.describe(`desktop, ${who}`, () => {
    test.use(DESKTOP);

    test(`qa-52: the No goal and Below the line lanes keep room for their name and count (${who})`, async ({ page }) => {
      await open(page, "light", "default", `${who}@example.com`);
      const lanes = page.locator('[data-testid="chart-group"], [data-testid="below-the-line"]');
      await expect(lanes.first()).toBeVisible();
      for (const l of await lanes.all()) {
        const lb = (await l.boundingBox())!;
        expect(lb.height).toBeGreaterThanOrEqual(43.5);
        const name = (await l.locator("b").boundingBox())!;
        const count = (await l.getByTestId("lane-count").boundingBox())!;
        expect(name.y, "the name has room above it").toBeGreaterThanOrEqual(lb.y + 3);
        expect(count.y + count.height, "the count has room below it").toBeLessThanOrEqual(lb.y + lb.height - 3);
      }
    });
  });
}

test.describe("phone", () => {
  test.use(PHONE);

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-6: a phone's Gantt reads by month with whole names; the Waterfall keeps its quarters (${scheme})`, async ({ page }) => {
      await open(page, scheme, "simple-plan");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-weeks", "true");
      const ticks = (await page.getByTestId("axis-tick").allTextContents()).map((t) => t.trim());
      for (const t of ticks) expect(t).toMatch(MONTH);
      expect(ticks[0]).toMatch(/ \d{4}$/);
      // A month is about 100 px: the screen shows two months, not two weeks.
      const xs = await page.getByTestId("axis-tick").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
      expect(xs[1] - xs[0]).toBeGreaterThan(85);
      // Names wrap, never cut.
      for (const n of await page.getByTestId("label-title").all()) {
        const cut = await n.evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
        expect(cut, `${await n.textContent()} is whole`).toBe(false);
      }
      await page.getByTestId("format-waterfall").click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "waterfall");
      const svg = (await page.getByTestId("chart-svg").boundingBox())!;
      for (const q of await boxes(page.getByTestId("axis-tick"))) expect(q.x + q.width).toBeLessThanOrEqual(svg.x + svg.width + 1);
    });
  }

  test("qa-45: the phone Timeline's Today line stands clear of the left edge; the lane list counts the bars drawn", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "lanes-phone");
    const svg = (await page.getByTestId("chart-svg").boundingBox())!;
    const line = (await page.getByTestId("today-line").boundingBox())!;
    // Ten days before the first date: about 12 px on a phone (it sat 5 px from the edge before).
    expect(line.x - svg.x, "Today's line is off the edge").toBeGreaterThan(10);
    const lane = page.locator('[data-testid="phone-lane"][data-open="true"]');
    const rows = new Set(await lane.getByTestId("lane-run").evaluateAll((els) => els.map((e) => e.getAttribute("y"))));
    await expect(page.getByTestId("lane-list-count")).toHaveText(new RegExp(`up to ${rows.size} at once$`));
  });
});
