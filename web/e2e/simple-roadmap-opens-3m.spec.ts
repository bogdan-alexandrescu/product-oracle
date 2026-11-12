import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner (Nov 9): the Simple roadmap's Timeline opens on 'Show: 3 months', about thirteen
 * weeks from just before today; a person's own pick holds for the rest of the visit. And the
 * Timeline always reaches at least the end of Q1 2027 (Mar 31, 2027), at every zoom, even when
 * no item runs that late: scrolling right reaches March 2027, and a milestone dated in it is
 * drawn as a line. The pick is the signed-in person's own: when someone else is signed in by
 * the time the tab comes back to the roadmap, it opens on 3 months. Driven against the mock's invented data (the mock's today is Oct 22, 2026).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page, scenario = "") {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("zoom-timeline")).toBeVisible();
}

/** The chart's view: its left edge past the names column, and its right edge. */
async function view(page: Page) {
  const head = (await page.getByTestId("timeline-names-head").boundingBox())!;
  const box = (await page.getByTestId("timeline-scroll").boundingBox())!;
  return { left: head.x + head.width, right: box.x + box.width };
}

/** Pixels per day, from two week lines seven days apart. */
async function perDay(page: Page) {
  const lines = page.getByTestId("timeline-week-line");
  const a = (await lines.nth(0).boundingBox())!;
  const b = (await lines.nth(1).boundingBox())!;
  const days = (Date.parse(`${await lines.nth(1).getAttribute("data-day")}T00:00:00Z`) - Date.parse(`${await lines.nth(0).getAttribute("data-day")}T00:00:00Z`)) / 86_400_000;
  return (b.x - a.x) / days;
}

/** Slides the chart to its right end with the mouse wheel, as a person would. */
async function slideToEnd(page: Page) {
  await page.getByTestId("timeline-names-head").scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("timeline-scroll").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 200, page.viewportSize()!.height - 20));
  const scroll = page.getByTestId("timeline-scroll");
  const atEnd = () => scroll.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  for (let n = 0; n < 40 && !(await atEnd()); n++) await page.mouse.wheel(1200, 0);
  await expect.poll(atEnd).toBe(true);
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("a first visit opens on 3 months: about 13 weeks from just before today", async ({ page }) => {
    // protects: at 1440 wide, a first visit to the Simple roadmap Timeline opens with "3 months" picked (and not 6 months, 1 year or All), today's line just inside the left edge (under 120 px), and a view of 12 to 14 weeks
    // fails_when: another zoom is picked on a first visit, today's line is off the left edge or far from it, or the view is not about 13 weeks wide
    // no_claim: a return visit, other widths, or exact pixel positions
    await open(page);
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    for (const z of ["6m", "1y", "all"]) await expect(page.getByTestId(`zoom-${z}`)).toHaveAttribute("aria-pressed", "false");

    // Today sits just inside the view's left edge, and the view spans about thirteen weeks.
    const v = await view(page);
    const today = (await page.getByTestId("today-line").boundingBox())!;
    expect(today.x).toBeGreaterThan(v.left);
    expect(today.x).toBeLessThan(v.left + 120);
    const weeks = (v.right - v.left) / (await perDay(page)) / 7;
    expect(weeks).toBeGreaterThan(12);
    expect(weeks).toBeLessThan(14);
  });

  test("a person's own pick holds after Back to today and a trip to the Gantt; a new visit opens on 3 months", async ({ page }) => {
    // protects: at 1440 wide, after picking "6 months" it stays picked after Back to today and after a trip to the Gantt and back, and a page reload opens on 3 months again
    // fails_when: the pick falls back to 3 months after Back to today or the Gantt, or a reload keeps 6 months
    // no_claim: other zooms, or a different person's pick (the next test)
    await open(page);
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    // 6 months stays picked after going back to today.
    await page.getByRole("button", { name: "6 months", exact: true }).click();
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Back to today" }).click();
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "false");
    // ...and after a look at the Gantt.
    await page.getByTestId("format-gantt").click();
    await page.getByTestId("format-timeline").click();
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
    // A new visit opens on 3 months again.
    await page.reload();
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
  });

  test("someone else signed in when the tab comes back to the roadmap opens on 3 months, not on the last person's pick", async ({ page }) => {
    // protects: at 1440 wide, when the first person picks "1 year", signs out, another person (the approver) signs in on a second tab, and the first tab goes Back to the roadmap, the Timeline opens on 3 months and not 1 year
    // fails_when: the new person sees the last person's 1 year pick
    // no_claim: that the same person's pick holds across a sign out, or other zooms
    await open(page);
    await page.getByRole("button", { name: "1 year", exact: true }).click();
    await expect(page.getByTestId("zoom-1y")).toHaveAttribute("aria-pressed", "true");
    // Signs out from the account menu (the page stays loaded: no reload)...
    await page.getByTestId("user-menu").click();
    await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    // ...someone else signs in on a second tab...
    const other = await page.context().newPage();
    await login(other, "approver@example.com");
    await other.close();
    // ...and the first tab goes back to the roadmap, now as them.
    await page.goBack();
    await expect(page).toHaveURL(/\/simple\/roadmap/);
    await expect(page.getByTestId("zoom-timeline")).toBeVisible();
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-1y")).toHaveAttribute("aria-pressed", "false");
  });

  test("scrolling right reaches the end of March 2027, where a milestone on Mar 15, 2027 is drawn as a line", async ({ page }) => {
    // protects: at 1440 wide on the "Example trails" roadmap at 3 months (items end by Feb 26, 2027), sliding right reaches Mar 1, 2027 with at least 29 days beyond it, and a Delivery milestone added on the axis and dated Mar 15, 2027 shows its label "Trail map launch · Mar 15, 2027" and a tall line in view
    // fails_when: the chart stops before the end of March 2027, or the milestone dated Mar 15, 2027 has no label or line
    // no_claim: other zooms (the code says it holds at every zoom), other milestone kinds, or that the milestone is kept after a reload
    // The Example trails roadmap's items all end by Feb 26, 2027.
    await open(page, "approved-roadmap");
    await page.getByTestId("filter-roadmap").selectOption({ label: "Example trails" });
    await expect(page.locator('[data-testid="timeline-row"]')).not.toHaveCount(0);
    await page.getByRole("button", { name: "3 months", exact: true }).click();
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");

    await slideToEnd(page);
    const march = page.locator('[data-testid="timeline-month-line"][data-day="2027-03-01"]');
    await expect(march).toBeInViewport();
    // The chart runs on to Mar 31, 2027: a month of days past March 1.
    const v = await view(page);
    const days = (v.right - (await march.boundingBox())!.x) / (await perDay(page));
    expect(days).toBeGreaterThanOrEqual(29);

    // A person adds a milestone on the time axis, dated Mar 15, 2027.
    const axis = page.getByTestId("ms-axis").first();
    const a = (await axis.boundingBox())!;
    await page.mouse.move(v.left + (v.right - v.left) * 0.4, a.y + a.height / 2);
    await page.mouse.click(v.left + (v.right - v.left) * 0.4, a.y + a.height / 2);
    // tb-mk: + Milestone asks for the kind first (Delivery, what a new one was before kinds), then opens the card.
    const picker = page.getByTestId("ms-kind-picker");
    await expect(picker.getByRole("heading", { name: "New milestone" })).toBeVisible();
    await picker.getByRole("option", { name: "Delivery" }).click();
    const card = page.getByTestId("ms-card");
    await expect(card.getByRole("heading", { name: "New milestone" })).toBeVisible();
    await card.getByLabel("Name").fill("Trail map launch");
    await card.getByLabel("Date").fill("2027-03-15");
    await card.getByTestId("ms-save").click();
    await expect(card).toBeHidden();

    await slideToEnd(page);
    // roadmap-milestone-codes: the band's label shows its code and name; its day is in its tip and accessible name.
    await expect(page.locator('[data-testid="ms-label"][aria-label*=" Trail map launch · Mar 15, 2027"]')).toBeInViewport();
    const line = page.locator('[data-testid="ms-line"][data-day="2027-03-15"]');
    await expect(line).toBeInViewport();
    const l = (await line.boundingBox())!;
    expect(l.height).toBeGreaterThan(20);
  });
});
