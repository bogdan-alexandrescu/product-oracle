import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA findings on /simple/roadmap, round 4 (qa-plan-54..56), driven through the UI on the mock
 * layer: the Timeline's goal lanes in the "simple-plan-lanes" scenario (Guided setup's plan,
 * M1 Prove it Nov 2 - Nov 27 ...), and the default scenario for who may start a review.
 */

const LANES = "/simple/roadmap?roadmap=onboarding-roadmap";
const DESKTOP = { viewport: { width: 1366, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
/** The app's one way to write a day: "Oct 31". */
const DAY = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$/;
const GB_DAY = /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/;

async function lanes(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan-lanes"] as const);
  await login(page);
  await page.goto(LANES);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("qa-plan-54: the legend and the milestone ends write days as 'Oct 31'", async ({ page }) => {
    await lanes(page);
    const legend = page.getByTestId("simple-chart").getByTestId("legend");
    const today = legend.getByTestId("legend-item").filter({ hasText: /^Today/ });
    await expect(today).toHaveCount(1);
    const words = (await today.innerText()).trim().replace(/^Today\s*/, "");
    expect(words).toMatch(DAY);
    await expect(legend).not.toContainText(GB_DAY);
    for (const label of await page.getByTestId("milestone-end-label").allTextContents()) expect(label).not.toMatch(GB_DAY);
    await expect(page.getByTestId("milestone-end-label").first()).toHaveText("M1 ends Nov 27");
  });

  test("qa-plan-55: a pill's label never runs past its pill or under its milestone mark", async ({ page }) => {
    await lanes(page);
    const chart = page.getByTestId("simple-chart");
    await expect(chart.locator('g[data-testid="bar"]').first()).toBeVisible();
    const bad = await chart.locator('g[data-testid="bar"]').evaluateAll((bars) => {
      const out: string[] = [];
      for (const g of bars) {
        const pieces = g.querySelectorAll('[data-testid="slice-bar"]');
        const groups = pieces.length ? [...pieces] : [g];
        for (const piece of groups) {
          const body = piece.querySelector("rect[data-slice-body], rect[data-body]") as SVGGraphicsElement | null;
          if (!body) continue;
          const rb = body.getBoundingClientRect();
          for (const t of piece.querySelectorAll('text[data-testid="slice-label"], text[data-testid="bar-label"]')) {
            const tb = (t as SVGGraphicsElement).getBoundingClientRect();
            if (t.getAttribute("data-beside") === "true") {
              if (tb.left < rb.right - 0.5) out.push(`${t.textContent}: beside but over its pill`);
            } else if (tb.right > rb.right + 0.5) out.push(`${t.textContent}: cut by its pill`);
            const mark = g.querySelector('[data-testid="item-milestone"]');
            if (mark && t.getAttribute("data-beside") !== "true") {
              const mb = mark.getBoundingClientRect();
              if (mb.left < tb.right && mb.right > tb.left) out.push(`${t.textContent}: under its milestone mark`);
            }
          }
        }
      }
      return out;
    });
    expect(bad).toEqual([]);
    // A slice too short for its code has it beside the pill, not an empty pill.
    const empty = await chart.locator('g[data-testid="slice-bar"]').evaluateAll(
      (els) => els.filter((e) => !e.querySelector('[data-testid="slice-label"]') && e.getAttribute("data-code")).map((e) => e.getAttribute("data-code")),
    );
    const beside = await chart.locator('[data-beside="true"]').count();
    expect(empty.length === 0 || beside > 0, `empty pills: ${empty.join(", ")}`).toBe(true);
  });

  test("qa-plan-56: a commenter's Start review reads as off beside its reason", async ({ page }) => {
    await login(page, "commenter@example.com");
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    const btn = page.getByRole("button", { name: "Start review" });
    await expect(btn).not.toHaveAttribute("aria-busy", "true");
    await expect(btn).toBeDisabled();
    await expect(page.getByTestId("start-review-reason")).toHaveText("Only an owner or the PRD's decider can start a review");
    const [off, on] = await Promise.all([
      btn.evaluate((e) => Number(getComputedStyle(e).opacity)),
      page.getByTestId("key-dates-open").evaluate((e) => Number(getComputedStyle(e).opacity)),
    ]);
    expect(off).toBeLessThan(0.7);
    expect(on).toBe(1);
  });

  test("qa-plan-56: an owner's Start review is on", async ({ page }) => {
    await login(page);
    await page.goto("/simple/roadmap");
    const btn = page.getByRole("button", { name: "Start review" });
    await expect(btn).toBeEnabled();
    expect(await btn.evaluate((e) => Number(getComputedStyle(e).opacity))).toBe(1);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("qa-plan-54: an open lane's rows write days as 'Nov 2 → Nov 13'", async ({ page }) => {
    await lanes(page);
    const lane = page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: /^Reliability$/ }) });
    await expect(lane).toHaveAttribute("data-open", "true");
    const list = page.getByTestId("lane-list");
    await expect(list.getByTestId("lane-row").first()).toContainText("Nov 2 → Nov 13");
    await expect(list).not.toContainText(GB_DAY);
  });
});
