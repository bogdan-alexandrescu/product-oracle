import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix4-simple-roadmap-chart: the roadmap chart's QA findings, driven through the UI on the mock.
 * Timeline (_zoom.tsx, mk-qa4-roadmap): broken links sit in the panel above the chart with
 * their words whole, with the Ask panel open (qa-1); every row is named, a new item with its
 * Draft tag, with no ids (qa-2, 15, 3); months read "Sep", the first in sight with its year
 * (qa-30); lanes keep room for their name and count for every role (qa-52); the phone's list
 * counts what it lists (qa-45). A chat preview ghosts where it lands on the Gantt (qa-10). Gantt and Waterfall (_timeline.tsx): the Gantt spans every
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

/** The broken links' panel (mk-qa4-roadmap QR3 A): above the chart, over no bar, each reason whole. */
async function conflictsClear(page: Page) {
  const panel = page.getByTestId("conflicts");
  const rows = panel.getByTestId("conflict");
  await expect(rows.first()).toBeVisible();
  const pb = (await panel.boundingBox())!;
  const chart = (await page.getByTestId("timeline-scroll").boundingBox())!;
  expect(pb.y + pb.height, "the panel sits above the chart").toBeLessThanOrEqual(chart.y + 1);
  for (const b of await boxes(page.getByTestId("timeline-bar"))) expect(overlaps(pb, b), "the panel covers a bar").toBe(false);
  for (const c of await rows.all()) {
    const key = await c.getAttribute("data-item");
    const words = c.getByRole("button").first();
    await expect(words).toHaveText(/\w{3}/);
    const cut = await words.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    expect(cut, `${key}'s reason is whole`).toBe(false);
  }
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-1: the broken links sit in the panel above the Timeline, words whole, with the Ask panel open (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(async () => conflictsClear(page)).toPass({ timeout: 10_000 });
      const scroll = page.getByTestId("timeline-scroll");
      const wide = (await scroll.boundingBox())!.width;
      await page.getByTestId("simple-ask").filter({ visible: true }).first().click();
      await expect(page.getByTestId("ask-chat").filter({ visible: true })).toBeVisible();
      await expect.poll(async () => (await scroll.boundingBox())!.width).toBeLessThan(wide - 100);
      await expect(async () => conflictsClear(page)).toPass({ timeout: 10_000 });
    });
  }

  test("qa-2, 3, 15: every Timeline row is named, never by an id; a new item reads its title with a Draft tag", async ({ page }) => {
    await open(page);
    const rows = page.getByTestId("timeline-row");
    await expect(rows.first()).toBeVisible();
    for (const r of await rows.all()) {
      const key = await r.getAttribute("data-item");
      const name = (await r.locator("button[title]").first().textContent())!.trim();
      expect(name.length, `${key} carries its name`).toBeGreaterThan(2);
      expect(name, `${key}'s name has no id`).not.toMatch(/\b[A-Z]-\d{2}[a-z]?\b|#\d/);
      // The bar says its name too (to a screen reader), never an id.
      const bar = await r.getByTestId("timeline-bar").getAttribute("aria-label");
      expect(bar, `${key}'s bar is named`).toMatch(/^\S.{2,}, /);
      expect(bar!).not.toMatch(/\b[A-Z]-\d{2}[a-z]?\b|#\d/);
    }

    const title = "Push notifications for alerts";
    await page.getByLabel("Add an item").fill(title);
    const roadmap = page.getByTestId("quick-add-roadmap");
    if (await roadmap.count()) await roadmap.selectOption({ label: "Alerts roadmap" });
    await page.getByLabel("Add an item").press("Enter");
    const added = rows.filter({ has: page.locator(`button[title="${title}"]`) });
    await expect(added).toHaveCount(1);
    await expect(added.locator("button[title]").first()).toHaveText(/^Push notifications for alerts\s*Draft$/);
  });

  test("qa-30: the month axis reads three-letter months, the first in sight with its year", async ({ page }) => {
    await open(page);
    // At 6 months the axis has no week marks (the Timeline opens on 3 months).
    await page.getByTestId("zoom-6m").click();
    const scroll = page.getByTestId("timeline-scroll");
    const months = scroll.locator("div.sticky.top-0 span");
    await expect(months.first()).toBeAttached();
    const ticks = (await months.allTextContents()).map((t) => t.trim());
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect(t).toMatch(MONTH);
    // The names column covers the chart's left 232 px: the first month right of it says its year.
    const sb = (await scroll.boundingBox())!;
    const seen = [];
    for (const m of await months.all()) {
      const b = (await m.boundingBox())!;
      if (b.x >= sb.x + 230 && b.x < sb.x + sb.width) seen.push({ x: b.x, t: (await m.textContent())!.trim() });
    }
    seen.sort((a, b) => a.x - b.x);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0].t).toMatch(/ \d{4}$/);
    for (let i = 1; i < seen.length; i++) expect(seen[i].x - seen[i - 1].x, "months keep a month's room apart").toBeGreaterThan(60);
  });

  // fix4 review: a move years past the scenario's last date (Q4 2031; its span already ran to
  // late 2028), so only the preview's own days bring it in: without them the ghost was drawn
  // off the chart's right edge (x 1753 past a chart ending at 1015).
  // mk-qa4-roadmap: the Timeline (QR1 A) draws no preview ghost; the Gantt's chart does.
  test("qa-10: the Ask panel's Preview ghosts the bar where it lands (Q4 2031), inside the Gantt", async ({ page }) => {
    await open(page, "light", "simple-chat");
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
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
      const lanes = page.getByTestId("timeline-lane");
      await expect(lanes.first()).toBeVisible();
      for (const l of await lanes.all()) {
        const lb = (await l.boundingBox())!;
        expect(lb.height).toBeGreaterThanOrEqual(31.5);
        // tb-mk: a track band reads its name, goal and health; No track reads bare; Below the line keeps its count.
        if (await l.getByTestId("track-head").count()) await expect(l.getByTestId("track-head")).toHaveText(/\S.*(On track|Needs a look)$/);
        else await expect(l).toHaveText(/^No track$|\S.* · \d+ items?$/);
        const name = l.locator(":scope > div");
        const nb = (await name.boundingBox())!;
        expect(nb.y, "the name and count sit inside their lane").toBeGreaterThanOrEqual(lb.y - 0.5);
        expect(nb.y + nb.height, "the name and count sit inside their lane").toBeLessThanOrEqual(lb.y + lb.height + 0.5);
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

  test("qa-45: the phone Timeline is a list by quarter; today's quarter says Today; each quarter counts the items it lists", async ({ page }) => {
    await open(page);
    const list = page.getByTestId("timeline-list");
    await expect(list).toBeVisible();
    await expect(page.getByTestId("timeline-scroll")).toHaveCount(0);
    const quarters = list.getByTestId("timeline-quarter");
    expect(await quarters.count()).toBeGreaterThan(0);
    await expect(quarters.filter({ has: page.locator("h3", { hasText: /Today (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}/ }) })).toHaveCount(1);
    // qa4-simple-roadmap-33: the count alone ("4 items"), no "up to 1 at once".
    for (const q of await quarters.all()) {
      const head = (await q.locator("h3").textContent())!;
      const n = Number(/· (\d+) items/.exec(head)?.[1]);
      expect(head).not.toMatch(/at once/);
      await expect(q.getByTestId("timeline-row")).toHaveCount(n);
    }
  });
});
