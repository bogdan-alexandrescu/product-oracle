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
});
