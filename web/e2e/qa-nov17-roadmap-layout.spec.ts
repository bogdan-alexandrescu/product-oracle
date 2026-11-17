import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 17, 2026: the Simple Roadmap's header and names column, driven as a person
 * does against the mock's invented data. The QA ran on Nov 17, when today sits just after the
 * mock's Customer conference (a key date), so these tests set the clock to that day.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const QA_DAY = new Date("2026-11-17T15:00:00Z");

type Format = "timeline" | "gantt" | "waterfall" | "board";
type Box = { x: number; y: number; width: number; height: number };

async function open(page: Page, format: Format) {
  await page.clock.setSystemTime(QA_DAY);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

const meets = (a: Box, b: Box) => a.x + 0.5 < b.x + b.width && b.x + 0.5 < a.x + a.width && a.y + 0.5 < b.y + b.height && b.y + 0.5 < a.y + a.height;

/** The boxes of the visible elements a locator finds. */
async function boxes(l: Locator): Promise<{ text: string; box: Box }[]> {
  const out: { text: string; box: Box }[] = [];
  for (const el of await l.all()) {
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    if (box && box.width > 0) out.push({ text: (await el.textContent()) ?? "", box });
  }
  return out;
}

function noneMeet(what: string, a: { text: string; box: Box }[], b: { text: string; box: Box }[]) {
  for (const x of a) for (const y of b) expect(meets(x.box, y.box), `${what}: "${x.text}" lies on "${y.text}"`).toBe(false);
}

/** The flags and names in `scope` that clip their words ("Not in the Ground …", "D…", "Usage alerts t…"). */
async function cutWords(scope: Locator, selector: string): Promise<string[]> {
  return scope.evaluate(
    (root, sel) =>
      [...root.querySelectorAll<HTMLElement>(sel)]
        .filter((e) => !e.classList.contains("sr-only") && e.getClientRects().length > 0 && e.clientWidth > 0 && getComputedStyle(e).overflowX !== "visible" && e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent ?? ""),
    selector,
  );
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  for (const format of ["gantt", "waterfall"] as const) {
    test(`${format}: the Today pill, counts and + Milestone keep off the header's names and chips (#3, #6)`, async ({ page }) => {
      // protects: QA Nov 17 #3/#6: on the Gantt and Waterfall the Today pill never sits on a key date's name ("Customer conference"), a same-day count never sits on a milestone's name, and the "+ Milestone" hint never covers a milestone chip
      // fails_when: the pill and a name, a count and a name, or the hint and a chip overlap
      await open(page, format);
      const chart = page.getByTestId("simple-chart");
      await expect(chart.getByTestId("today-pill")).toBeVisible();
      const names = [
        ...(await boxes(chart.getByTestId("key-date-label"))),
        ...(await boxes(chart.getByTestId("track-milestone-label"))),
        ...(await boxes(chart.getByTestId("milestone-end-label"))),
      ];
      expect(names.length).toBeGreaterThan(0);
      noneMeet("Today pill", await boxes(chart.getByTestId("today-pill")), names);
      noneMeet("same-day count", await boxes(chart.getByTestId("ms-same-day")), names);
      const chips = [
        ...(await boxes(chart.getByTestId("ms-label"))),
        ...(await boxes(chart.getByTestId("ms-prd-label"))),
        ...(await boxes(chart.getByTestId("ms-band-more"))),
        ...(await boxes(chart.getByTestId("ms-same-day"))),
        ...(await boxes(chart.getByTestId("ms-diamond"))),
      ];
      noneMeet("+ Milestone", await boxes(chart.getByTestId("ms-add-hint")), chips);
      noneMeet("header name", names, chips);
    });
  }
  test("timeline: a milestone's label sits beside its own day, and a key date's name is never under a diamond (#4)", async ({ page }) => {
    // protects: QA Nov 17 #4: at All 3 years each milestone label starts at its own dashed line ("M6 Beta · Nov 30" was drawn five months on, at Apr); at 6 months no key date's name lies under a goal milestone's diamond ("…eting")
    // fails_when: a label starts more than 30 px from its line, or a key date's name and a diamond overlap
    await open(page, "timeline");
    await page.getByTestId("zoom-all").click();
    await expect(page.getByTestId("zoom-all")).toHaveAttribute("aria-pressed", "true");
    const labels = page.getByTestId("timeline-milestone").filter({ visible: true });
    await expect(labels.first()).toBeVisible();
    for (const l of await labels.all()) {
      const day = (await l.getAttribute("data-day"))!;
      expect(day, "a label names its day").toBeTruthy();
      const line = (await page.locator(`[data-testid="timeline-milestone-line"][data-day="${day}"]`).first().boundingBox())!;
      const b = (await l.boundingBox())!;
      expect(Math.abs(b.x - line.x), `${await l.textContent()} sits by its day`).toBeLessThanOrEqual(30);
    }
    await page.getByTestId("zoom-6m").click();
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
    noneMeet("key date", await boxes(page.getByTestId("timeline-key-date-label")), await boxes(page.getByTestId("ms-diamond")));
  });
  test("timeline and gantt: the names column's flags read whole (#8)", async ({ page }) => {
    // protects: QA Nov 17 #8: in the Timeline's names column "Draft" and the Not in the Ground Truth flag are never cut ("D…", "Not in the Grou…"), the flag keeps its full words in its title; the Gantt's rows, Below the line too, keep the flag whole
    // fails_when: a Draft tag or a flag clips its words
    await open(page, "timeline");
    const rows = page.getByTestId("timeline-row");
    await expect(rows.first()).toBeVisible();
    const flag = page.locator('[data-testid="timeline-row"] [data-testid="not-in-gt"]').first();
    await expect(flag).toHaveAttribute("title", "Not in the Ground Truth");
    const flags = '[data-testid="not-in-gt"], [data-testid="not-in-gt"] *, [data-testid="draft-tag"]';
    expect(await cutWords(page.locator("body"), flags.split(", ").map((x) => `[data-testid="timeline-row"] ${x}`).join(", "))).toEqual([]);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("format-gantt")).toHaveAttribute("aria-pressed", "true");
    const labels = page.getByTestId("chart-labels");
    await expect(labels.getByTestId("not-in-gt").first()).toBeVisible();
    expect(await cutWords(labels, flags)).toEqual([]);
  });
  test("timeline: no goal milestone diamond or line draws over the names column (#7)", async ({ page }) => {
    // protects: QA Nov 17 #7: at 3 and 6 months a goal milestone just left of the window in view (Oct 31) draws no diamond over the names header and no line through the row names
    // fails_when: a goal milestone's diamond or line starts left of the names column's right edge
    await open(page, "timeline");
    for (const zoom of ["zoom-3m", "zoom-6m"]) {
      await page.getByTestId(zoom).click();
      await expect(page.getByTestId(zoom)).toHaveAttribute("aria-pressed", "true");
      const head = (await page.getByTestId("timeline-names-head").boundingBox())!;
      for (const { text, box } of [...(await boxes(page.getByTestId("ms-diamond"))), ...(await boxes(page.getByTestId("ms-line")))])
        expect(box.x, `${zoom}: ${text || "a milestone line"} lies over the names`).toBeGreaterThanOrEqual(head.x + head.width - 1);
    }
  });
  test("timeline: an opened item's panel starts near the top of the screen, not at its foot (#9)", async ({ page }) => {
    // protects: QA Nov 17 #9: at 1440 x 900, opening an item on the Timeline brings the chart's top into view, so its side panel opens tall, as on the Gantt
    // fails_when: the panel opens as a short strip at the foot of the screen (its top far down the screen)
    await open(page, "timeline");
    await page.getByTestId("timeline-row-name").first().click();
    const panel = page.getByTestId("item-panel");
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(300);
  });
  test("timeline and board: a Goal filter shows that goal's milestones only, key dates kept (#12)", async ({ page }) => {
    // protects: QA Nov 17 #12: with Filters > Goal = Grow retention the Timeline's milestone band lists only milestones building toward Grow retention, and the board's milestone chips narrow with the rows; the key dates stay
    // fails_when: a milestone of another goal still shows under the Goal filter, or the board keeps every milestone chip
    await open(page, "board");
    const chips = page.getByTestId("ms-board-chip");
    await expect(chips.first()).toBeVisible();
    const before = await chips.count();
    const keys = await page.getByTestId("ms-board-key").count();
    await page.getByRole("combobox", { name: "Goal", exact: true }).selectOption({ label: "Grow retention" });
    await expect.poll(() => chips.count()).toBeLessThan(before);
    await expect(page.getByTestId("ms-board-key")).toHaveCount(keys);
    await page.getByTestId("format-timeline").click();
    await expect(page.getByTestId("format-timeline")).toHaveAttribute("aria-pressed", "true");
    const labels = page.getByTestId("ms-label");
    await expect(labels.first()).toBeAttached();
    for (const l of await labels.all()) await expect(l).toHaveAttribute("aria-label", /Builds toward Grow retention$/);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("gantt: band names, flags and chips read whole and each row holds its words (#5)", async ({ page }) => {
    // protects: QA Nov 17 #5: on a 390 px phone the Gantt's band names wrap whole ("Usage alerts t…" was cut), the Not in the Ground Truth flag reads whole in short words with its full words in its title, a row's name and badges stay inside the row, and the Today pill lies on no header name
    // fails_when: a band name or flag clips its words, a row's words run into the next row, or the Today pill covers a name
    await open(page, "gantt");
    const labels = page.getByTestId("chart-labels");
    await expect(labels.getByTestId("chart-label").first()).toBeVisible();
    expect(await cutWords(labels, '[data-testid="track-head"] *, [data-testid="not-in-gt"], [data-testid="not-in-gt"] *, [data-testid="draft-tag"]')).toEqual([]);
    await expect(labels.getByTestId("not-in-gt").first()).toHaveAttribute("title", "Not in the Ground Truth");
    for (const row of await labels.getByTestId("chart-label").all()) {
      const box = (await row.boundingBox())!;
      const inner = await row.evaluate((el) => [...el.querySelectorAll<HTMLElement>("*")].filter((e) => e.getClientRects().length > 0).map((e) => e.getBoundingClientRect().bottom));
      expect(Math.max(...inner), `${await row.textContent()} stays in its row`).toBeLessThanOrEqual(box.y + box.height + 1);
    }
    const chart = page.getByTestId("simple-chart");
    const names = [...(await boxes(chart.getByTestId("key-date-label"))), ...(await boxes(chart.getByTestId("track-milestone-label"))), ...(await boxes(chart.getByTestId("milestone-end-label")))];
    noneMeet("Today pill", await boxes(chart.getByTestId("today-pill")), names);
  });
  test("waterfall: no key date's or track milestone's name lies under a goal milestone's chip or diamond (#3)", async ({ page }) => {
    // protects: QA Nov 17 #3: on a 390 px phone the Waterfall's "M6 Beta" and "Board meeting" are never drawn under the milestone band's diamonds or chips
    // fails_when: a header name and a milestone chip or diamond overlap
    await open(page, "waterfall");
    const chart = page.getByTestId("simple-chart");
    await expect(chart.getByTestId("ms-diamond").first()).toBeVisible();
    const names = [...(await boxes(chart.getByTestId("key-date-label"))), ...(await boxes(chart.getByTestId("track-milestone-label"))), ...(await boxes(chart.getByTestId("milestone-end-label")))];
    expect(names.length).toBeGreaterThan(0);
    const chips = [...(await boxes(chart.getByTestId("ms-label"))), ...(await boxes(chart.getByTestId("ms-prd-label"))), ...(await boxes(chart.getByTestId("ms-band-more"))), ...(await boxes(chart.getByTestId("ms-diamond")))];
    noneMeet("header name", names, chips);
  });
});
