import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * fix2-simple-roadmap, the page pass (/simple/roadmap): red tests for QA2's findings 13, 4,
 * 5, 9, 20, 22, 23, 36, 37, 41, 43, 47 and 34 (its review is _roadmap.tsx, _card.tsx's
 * Callout / FixButtons / FloatingCard / SuggestionPopover, the mock's move-dependents fix,
 * and the toast's global position). Each test drives the UI as a person would against the
 * mock's default scenario (web/lib/api/mock/simple-roadmap.ts: alert-rules, alert-digest and
 * alert-mobile on the alerts roadmap), on desktop (1440x900) and a phone (390x844).
 */

const URL = "/simple/roadmap";
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const callout = (page: Page, key: string): Locator => page.locator(`[data-testid="broken-callout"][data-item="${key}"]`);
const depArrow = (page: Page, from: string, to: string): Locator =>
  page.locator(`[data-testid="dep-arrow"][data-from="${from}"][data-to="${to}"]`);

async function open(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

/** A box's edges, rounded so a sub-pixel layout difference does not fail the check. */
function edges(box: { x: number; y: number; width: number; height: number }) {
  return { left: Math.round(box.x), right: Math.round(box.x + box.width), top: Math.round(box.y), bottom: Math.round(box.y + box.height) };
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  /**
   * #13: an owner may still open the start sheet from the Roadmap; a commenter or a viewer
   * never starts a review (meetings.may_start: an owner or the PRD's decider), so the button
   * reads as disabled, with the reason shown, before they ever open the sheet.
   */
  test("Start review is enabled for an owner, disabled with a reason for a commenter and a viewer", async ({ page }) => {
    await open(page);
    const ownerBtn = page.getByRole("button", { name: "Start review" });
    await expect(ownerBtn).toBeEnabled();

    for (const email of ["commenter@example.com", "viewer@example.com"]) {
      await open(page, email);
      const btn = page.getByRole("button", { name: "Start review" });
      await expect(btn).toBeDisabled();
      const title = await btn.getAttribute("title");
      expect(title).toBeTruthy();
      expect(title).toMatch(/owner|decider/i);
    }
  });

  /**
   * #4: the red callout beside a broken bar (alert-digest depends on alert-rules) stays
   * inside the chart it is drawn over, not past its right edge.
   */
  test("a broken-link callout stays inside the chart's visible box", async ({ page }) => {
    await open(page);
    await expect(depArrow(page, "alert-rules", "alert-digest")).toHaveAttribute("data-state", "red");
    const c = callout(page, "alert-digest");
    await expect(c).toBeVisible();
    const chart = edges((await page.getByTestId("chart-scroll").boundingBox())!);
    const box = edges((await c.boundingBox())!);
    expect(box.left).toBeGreaterThanOrEqual(chart.left - 1);
    expect(box.right).toBeLessThanOrEqual(chart.right + 1);
  });

  /**
   * #9: "Move the dependents" from one broken item's callout also moves every other direct
   * dependent of the shared dependency (alert-mobile, whose dates are estimated, not only
   * alert-digest, the one clicked), and the fix is transitive.
   */
  test("Move the dependents fixes every sibling dependent, not only the one clicked", async ({ page }) => {
    await open(page);
    await expect(depArrow(page, "alert-rules", "alert-digest")).toHaveAttribute("data-state", "red");
    await expect(depArrow(page, "alert-rules", "alert-mobile")).toHaveAttribute("data-state", "red");
    await page.getByTestId("needs-decision").click();
    const tray = page.getByTestId("decision-tray");
    await expect(tray.getByTestId("tray-broken").filter({ hasText: "Mobile alert push" })).toHaveCount(1);
    await tray.getByRole("button", { name: "Close" }).click();

    await callout(page, "alert-digest").getByRole("button", { name: "Move the dependents" }).click();
    await expect(page.getByText(/Moved what depends on 'Alert rules engine' in your working draft/)).toBeVisible();

    await expect(depArrow(page, "alert-rules", "alert-digest")).toHaveAttribute("data-state", "ok");
    await expect(depArrow(page, "alert-rules", "alert-mobile")).toHaveAttribute("data-state", "ok");
    await page.getByTestId("needs-decision").click();
    await expect(tray.getByTestId("tray-broken").filter({ hasText: "Mobile alert push" })).toHaveCount(0);
    await expect(tray.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" })).toHaveCount(0);
  });

  /**
   * #22, #36: the Gantt legend says what it draws in plain words, not "PM-owned" or
   * "validation gate"; #41: the Oracle-suggestion wording is plain too.
   */
  test("the Gantt legend reads in plain words", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    const legend = page.getByTestId("legend");
    await expect(legend).toBeVisible();
    const text = (await legend.textContent())!;
    expect(text).not.toMatch(/PM-owned/);
    expect(text).not.toMatch(/validation gate/);
    expect(text).toMatch(/no engineering work/);
    expect(text).toMatch(/dates Oracle suggests/);
  });

  /**
   * #23: the Waterfall legend's phase keys name only the phases a bar actually draws (no
   * Discover key when nothing is in discovery), and the wording after them carries no stray
   * leading separator and no jargon ("validation gate").
   */
  test("the Waterfall legend has no stray separator and no unused phase key", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-waterfall").click();
    const legend = page.getByTestId("legend");
    await expect(legend).toBeVisible();
    await expect(page.getByTestId("phase-key").filter({ hasText: "Discover" })).toHaveCount(0);
    const text = (await legend.textContent())!;
    expect(text).not.toMatch(/validation gate/);
    expect(text.trim().startsWith("·")).toBe(false);
  });

  /**
   * #37: the roadmap's "Needs a decision" counts broken dates, suggestions and proposals on
   * this view; it is not the side menu's Decisions or Roadmap badge, so its label and title
   * say so instead of reading as the same count.
   */
  test("Needs a decision names what it counts, not the side menu's badges", async ({ page }) => {
    await open(page);
    const btn = page.getByTestId("needs-decision");
    await expect(btn).toContainText("Needs a decision here");
    const title = await btn.getAttribute("title");
    expect(title).toMatch(/this roadmap/i);
  });

  /**
   * #43: every "Needs a decision" tile's label sits at the same height, even "Dates to
   * confirm", which wraps onto two lines while its neighbours stay on one.
   */
  test("the decision tray's tile labels share one height", async ({ page }) => {
    await open(page);
    await page.getByTestId("needs-decision").click();
    const tiles = page.getByTestId("decision-tray").getByTestId("tray-counters").locator("li");
    await expect(tiles).toHaveCount(4);
    const heights = await tiles.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const h of heights) expect(Math.abs(h - heights[0])).toBeLessThanOrEqual(2);
  });

  /**
   * #47: the item card floats with a dimmed backdrop behind it on desktop; clicking the
   * backdrop closes the card, the same as its own close button.
   */
  test("the item card shows a backdrop and closes when it is clicked", async ({ page }) => {
    await open(page);
    await bar(page, "alert-rules").click();
    const card = page.getByTestId("floating-card");
    await expect(card).toBeVisible();
    const backdrop = page.getByTestId("floating-card-backdrop");
    await expect(backdrop).toBeVisible();
    await backdrop.click();
    await expect(card).not.toBeVisible();
  });

  /**
   * #34: the "Added … as a draft" toast is one host for the whole app; on desktop it now
   * sits in the bottom-right corner rather than centred over the middle of the chart.
   */
  test("the draft toast sits in a corner, not mid-chart", async ({ page }) => {
    await open(page);
    const chart = (await page.getByTestId("chart-scroll").boundingBox())!;
    await page.locator("#quick-add-title").fill("A new idea from the test");
    await page.locator("#quick-add-title").press("Enter");
    const toast = page.getByRole("status").filter({ hasText: "as a draft" });
    await expect(toast).toBeVisible();
    const box = (await toast.boundingBox())!;
    // Mid-chart would centre the toast under the chart's own midpoint; the corner keeps it
    // clear of that middle band.
    const chartMid = chart.x + chart.width / 2;
    expect(Math.abs(box.x + box.width / 2 - chartMid)).toBeGreaterThan(80);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  /**
   * #5: on a phone's Waterfall, the broken callout for the estimated dependent (Mobile alert
   * push) is not cut off on the chart's left edge.
   */
  test("a broken-link callout is not cut off on a phone Waterfall", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-waterfall").click();
    const c = callout(page, "alert-mobile");
    await expect(c).toBeVisible();
    await expect(c).toContainText("Mobile alert push");
    const chart = edges((await page.getByTestId("chart-scroll").boundingBox())!);
    const box = edges((await c.boundingBox())!);
    expect(box.left).toBeGreaterThanOrEqual(chart.left - 1);
    expect(box.right).toBeLessThanOrEqual(chart.right + 1);
  });

  /**
   * #20: a phone's Gantt names the milestone the current weeks hide, by its code and its
   * name ("M2 Scale volume"), not the code alone.
   */
  test("the swipe hint names the milestone, not only its code", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    const hint = page.getByTestId("swipe-hint");
    if (await hint.count()) {
      const text = (await hint.textContent())!;
      expect(text).toMatch(/^Swipe sideways for M\d+ \S/);
    }
  });

  /**
   * #36: a phone's Roadmap/Goal/Track filters and Group by read above the chart, not after
   * the legend, the actions and the goal cards at the page's foot.
   */
  test("the filters sit above the chart on a phone", async ({ page }) => {
    await open(page);
    const filtersBox = (await page.getByTestId("filters").boundingBox())!;
    const chartBox = (await page.getByTestId("simple-chart").boundingBox())!;
    expect(filtersBox.y).toBeLessThan(chartBox.y);
  });
});
