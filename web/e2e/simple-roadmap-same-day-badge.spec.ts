import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Two milestones on one day share one diamond with their count on the axis. The count read
 * "2 on Nov 20" in a dark chip about 80 px wide right of the diamond: at 3 months and 6 months
 * it covered the next milestone's diamond a week later, so a person could neither see nor click
 * it. Now it is a small badge with the count alone on the diamond's top-right corner, its names
 * in its tooltip, clear of every other diamond. Mock scenario "simple-prd-milestones" (invented
 * goals and people): its own "M1 First alert within a day" is moved to Nov 20 and a second one
 * added that day, a week before the PRD's hollow "M1 Rules in beta" on Nov 27.
 *
 * At 1 year and All 3 years a day is a few pixels wide: the badges of two such pairs a day
 * apart (Nov 20 and Nov 21) drew over each other. Now each keeps clear of the others, of the
 * diamonds, the month and week names and the Today pill, at every zoom and on a phone's Gantt
 * (boxes compared).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const card = (page: Page) => page.getByTestId("ms-card");

async function twoOnNov20(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-prd-milestones"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("ms-label").filter({ hasText: "M1 First alert within a day" }).click();
  await card(page).getByLabel("Date").fill("2026-11-20");
  await card(page).getByTestId("ms-save").click();
  await expect(card(page)).toBeHidden();
  await addOn(page, "Setup checks for new teams", "2026-11-20");
}

/** A click on the time axis, on a part of it in sight, opens a new milestone, saved on `date`. */
async function addOn(page: Page, name: string, date: string) {
  const axis = page.getByTestId("ms-axis").first();
  await axis.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 300));
  const box = (await axis.boundingBox())!;
  const seen = await axis.evaluate((el) => {
    let sc = el.parentElement;
    while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
    const r = (sc ?? document.body).getBoundingClientRect();
    return { left: Math.max(r.left, el.getBoundingClientRect().left), right: r.right };
  });
  // About two weeks after today (it starts 60 px in), clear of every diamond and the today tag.
  const at = { x: seen.left + 150, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await card(page).getByLabel("Name").fill(name);
  await card(page).getByLabel("Date").fill(date);
  await card(page).getByLabel("Goal").selectOption({ index: 1 });
  await card(page).getByTestId("ms-save").click();
  await expect(card(page)).toBeHidden();
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function boxOf(l: Locator) {
  await expect(l).toBeVisible();
  return (await l.boundingBox())!;
}

for (const [zoom, name] of [
  ["3m", "3 months"],
  ["6m", "6 months"],
] as const) {
  test(`${name}: the same-day count never covers the next diamond, which opens on a click`, async ({ page }) => {
    await twoOnNov20(page);
    await page.getByTestId(`zoom-${zoom}`).click();
    const badge = page.getByTestId("ms-same-day");
    const next = page.locator('[data-testid="ms-prd-diamond"][title^="M1 Rules in beta"]');
    const b = await boxOf(badge);
    const d = await boxOf(next);
    // A week after it, to the right.
    expect(d.x).toBeGreaterThan(b.x);
    expect(overlaps(b, d)).toBe(false);
    // The badge sits on its own diamond's corner.
    const own = await boxOf(page.locator('[data-testid="ms-diamond"][title$="Nov 20, 2026"]'));
    expect(b.x).toBeGreaterThan(own.x);
    expect(b.x).toBeLessThan(own.x + own.width);
    // Its count alone in sight (a screen reader also hears the day), the names of both in its tooltip.
    expect(await badge.evaluate((e) => e.firstChild?.textContent)).toBe("2");
    expect(b.width).toBeLessThanOrEqual(20);
    await expect(badge).toHaveAttribute("title", /^2 milestones on Nov 20: .*M1 First alert within a day.*Setup checks for new teams|^2 milestones on Nov 20: .*Setup checks for new teams.*M1 First alert within a day/);
    await next.click();
    await expect(page.getByTestId("ms-prd-card")).toBeVisible();
    await expect(page.getByTestId("ms-prd-card")).toContainText("From the PRD Usage alerts");
  });
}

/** Two more on Nov 21, the day after the pair on Nov 20. */
async function twoPairs(page: Page) {
  await twoOnNov20(page);
  await addOn(page, "Trial teams onboarded", "2026-11-21");
  await addOn(page, "Help pages written", "2026-11-21");
  await expect(page.getByTestId("ms-same-day")).toHaveCount(2);
}

/** Every same-day badge is clear of the others, of the diamonds, of each month's and week's name and of the Today pill. */
async function badgesClear(page: Page, names: Locator) {
  const badges = page.getByTestId("ms-same-day");
  await expect(badges).toHaveCount(2);
  const b = [await boxOf(badges.nth(0)), await boxOf(badges.nth(1))];
  expect(overlaps(b[0], b[1])).toBe(false);
  const diamonds = await page.locator('[data-testid="ms-diamond"], [data-testid="ms-prd-diamond"]').all();
  expect(diamonds.length).toBeGreaterThan(2);
  const words = [...(await names.all()), page.getByTestId("today-pill")];
  expect(words.length).toBeGreaterThan(2);
  for (const m of [...words, ...diamonds]) {
    const box = await m.boundingBox();
    if (!box) continue;
    for (const one of b) expect(overlaps(one, box), `a badge over "${(await m.textContent()) || (await m.getAttribute("title"))}"`).toBe(false);
  }
  // Each still names its own day and sits by its own diamond (never 160 px off, as it could).
  for (const d of ["20", "21"]) {
    const one = await boxOf(badges.filter({ hasText: `on Nov ${d}` }));
    const own = await boxOf(page.locator(`[data-testid="ms-diamond"][title$="Nov ${d}, 2026"]`));
    expect(Math.abs(one.x + one.width / 2 - (own.x + own.width / 2))).toBeLessThan(40);
  }
}

for (const zoom of ["3m", "6m", "1y", "all"] as const) {
  test(`${zoom}: same-day badges on neighbouring days keep apart, clear of the diamonds, the month and week names and the Today pill`, async ({ page }) => {
    await twoPairs(page);
    await page.getByTestId(`zoom-${zoom}`).click();
    await expect(page.getByTestId(`zoom-${zoom}`)).toHaveAttribute("aria-pressed", "true");
    const weeks = page.getByTestId("timeline-week");
    // Only 3 months names its weeks; at 1 year and All 3 years the diamonds sit closest.
    if (zoom === "3m") expect(await weeks.count()).toBeGreaterThan(0);
    await badgesClear(page, page.getByTestId("timeline-month").or(weeks));
  });
}

/*
 * Boxed in, the count's search went up to 160 px from its diamond, and to its left it could land
 * under the Timeline's names column, hidden. Now it stays near its diamond and right of the
 * names column: scrolled so the Nov 20 pair sits just right of the column, its count is in sight
 * beside it, and once the diamond is under the column its count goes with it.
 */
test("a same-day badge never sits under the Timeline's names column", async ({ page }) => {
  await twoPairs(page);
  const scroll = page.getByTestId("timeline-scroll");
  const nov20 = page.locator('[data-testid="ms-diamond"][title$="Nov 20, 2026"]');
  const badge = page.getByTestId("ms-same-day").filter({ hasText: "on Nov 20" });
  const names = page.getByTestId("timeline-names-head");
  for (const gap of [4, 8, 12, 16, 20]) {
    const edge = (await boxOf(names)).x + (await boxOf(names)).width;
    const d = await boxOf(nov20);
    await scroll.evaluate((el, by) => (el.scrollLeft += by), d.x + d.width / 2 - (edge + gap));
    await expect.poll(async () => Math.round((await boxOf(nov20)).x + (await boxOf(nov20)).width / 2 - edge)).toBe(gap);
    const b = await boxOf(badge);
    expect(b.x, `${gap} px right of the names column`).toBeGreaterThanOrEqual(edge);
    expect(Math.abs(b.x + b.width / 2 - (edge + gap))).toBeLessThan(40);
  }
  // Under the column, the diamond and its count are both out of sight.
  const edge = (await boxOf(names)).x + (await boxOf(names)).width;
  const d = await boxOf(nov20);
  await scroll.evaluate((el, by) => (el.scrollLeft += by), d.x + d.width / 2 - (edge - 30));
  await expect(badge).toBeHidden();
});

test("phone: on the Gantt, same-day badges on neighbouring days keep apart, clear of the month names and the Today pill", async ({ page }) => {
  await twoPairs(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("today-pill")).toBeVisible();
  await badgesClear(page, page.locator('[data-testid="axis-tick"], [data-testid="axis-month"], [data-testid="axis-year"]'));
});
