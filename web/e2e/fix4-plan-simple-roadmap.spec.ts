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

  // Moved: the Timeline's key writes Today month first; the milestone ends are the Gantt's now.
  test("qa-plan-54: the Timeline's key and the Gantt's milestone ends write days as 'Oct 31'", async ({ page }) => {
    await lanes(page);
    const key = page.getByTestId("timeline-key");
    const today = key.locator('[data-key="today"]');
    await expect(today).toHaveCount(1);
    const words = (await today.innerText()).trim().replace(/^Today\s*/, "");
    expect(words).toMatch(DAY);
    await expect(key).not.toContainText(GB_DAY);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    await expect(page.getByTestId("legend")).not.toContainText(GB_DAY);
    await expect(page.getByTestId("milestone-end-label").first()).toBeVisible();
    for (const label of await page.getByTestId("milestone-end-label").allTextContents()) expect(label).not.toMatch(GB_DAY);
    await expect(page.getByTestId("milestone-end-label").first()).toHaveText("M1 ends Nov 27");
  });

  // Re-pointed: the pills with slices and milestone marks are the Gantt's now.
  test("qa-plan-55: a Gantt pill's label never runs past its pill or under its milestone mark", async ({ page }) => {
    await lanes(page);
    await page.getByTestId("format-gantt").click();
    const chart = page.getByTestId("simple-chart");
    await expect(chart).toHaveAttribute("data-format", "gantt");
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

  // Train AD: the roadmap's own lane wins: whom may not start a review sees no Start review at all
  // (over qa-plan-56's disabled button with a reason).
  test("qa-plan-56: a commenter sees no Start review", async ({ page }) => {
    await login(page, "commenter@example.com");
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await expect(page.getByTestId("key-dates-open")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
    await expect(page.getByTestId("start-review-reason")).toHaveCount(0);
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

  // Moved: a phone's Timeline is a list by quarter; its rows write days month first.
  test("qa-plan-54: the phone Timeline's rows write days as 'Nov 2 – Nov 13'", async ({ page }) => {
    await lanes(page);
    const list = page.getByTestId("timeline-list");
    await expect(list).toBeVisible();
    await expect(list.getByTestId("timeline-row").filter({ hasText: "Nov 2 – Nov 13" }).first()).toBeVisible();
    await expect(list).not.toContainText(GB_DAY);
  });
});
