import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA, batch B, on Simple's one-pagers (the mock's invented PRDs), driven through the UI
 * as an owner on a desktop.
 *
 * B-13: protects = each PRD's one-pager reads its own PRD: Saved carts PRD and Checkout
 * redesign PRD each show their own problem, never the same words; fails_when = the mock serves
 * every PRD the seeded page's invented body ("New workspace admins stall ...") under its title.
 *
 * B-14: protects = the Timeline strip's today line starts below the month names (it never
 * crosses "Nov"); a milestone's label keeps to one line, and one cut short holds its whole words,
 * its item count too, behind an (i); the "No milestone" row and the footnote under the strip
 * count the same items ("No milestone · 2 roadmap items", "1 of 2 ends after Jan", "1 of the 2
 * roadmap items with no milestone ends after Jan"); fails_when = the today line runs through the
 * month row, a label wraps onto two lines, or the footnote counts "1 roadmap item" beside a row
 * of 2. no_claim = Home's strip (simple-plan-strip.spec.ts).
 */

const DESKTOP = { width: 1366, height: 820 };
const SEEDED_PROBLEM = "New workspace admins stall";

async function openFromList(page: Page, title: string) {
  await page.goto("/simple/one-pagers");
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

const problem = (page: Page) => page.locator('[data-line="problem-1"]').getByTestId("one-pager-line-text");

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("B-13: two PRDs' one-pagers each show their own problem", async ({ page }) => {
    await login(page);
    await openFromList(page, "Saved carts PRD");
    await expect(problem(page)).toContainText("Shoppers build a cart on their phone");
    await expect(problem(page)).not.toContainText(SEEDED_PROBLEM);
    const carts = (await problem(page).textContent())!.trim();

    await openFromList(page, "Checkout redesign PRD");
    await expect(problem(page)).toContainText("Buyers leave checkout when the total changes late in the flow");
    await expect(problem(page)).not.toContainText(SEEDED_PROBLEM);
    expect((await problem(page).textContent())!.trim()).not.toBe(carts);
    // Its other blocks are its own too: its risks are its "Risks and open questions".
    await expect(page.getByRole("region", { name: "Risks and open decisions" })).toContainText("Pickup availability differs by region");
  });

  test("B-13: Saved carts' bets name the goal in words and are no template line", async ({ page }) => {
    // protects = a bet reads its goal by name ("Cart on every device: Retention") and every bet
    // is the PRD's own; fails_when = the fixture's table shows "G2" or its Feature detail is
    // the template's "One section per feature, in priority order."
    await login(page);
    await openFromList(page, "Saved carts PRD");
    const bets = page.getByRole("region", { name: "What we will build" });
    await expect(bets).toContainText("Cart on every device: Retention");
    await expect(bets).toContainText("Keep a signed-in shopper's cart on our servers");
    await expect(bets).not.toContainText(/\bG\d+\b/);
    await expect(bets).not.toContainText("One section per feature");
  });

  test("B-14: today's line starts below the month names", async ({ page }) => {
    await login(page);
    await page.goto("/simple/prds/guided-setup");
    const strip = page.getByLabel("Timeline strip");
    await expect(strip.getByTestId("plan-strip-month")).toHaveText(["Oct", "Nov", "Dec", "Jan"]);
    const today = strip.getByTestId("plan-strip-today");
    await expect(today).toHaveCount(1);
    const line = (await today.boundingBox())!;
    let monthsBottom = 0;
    for (const m of await strip.getByTestId("plan-strip-month").all()) {
      const b = (await m.boundingBox())!;
      monthsBottom = Math.max(monthsBottom, b.y + b.height);
    }
    expect(line.y).toBeGreaterThanOrEqual(monthsBottom - 0.5);
  });

  test("B-14: a milestone's label keeps to one line, its item count behind an (i) when cut", async ({ page }) => {
    // The "simple-walk" scenario: milestones with long names ("M1 · Measure it, make it safe").
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-walk"] as const);
    await login(page);
    await page.goto("/simple/prds/guided-setup");
    const strip = page.getByLabel("Timeline strip");
    const row = strip.getByTestId("plan-strip-row").filter({ hasText: "Measure it, make it safe · 3 roadmap items" });
    const label = row.getByTestId("plan-strip-label");
    await expect(label).toBeVisible();
    const { height, lineHeight, cut } = await label.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      cut: el.scrollWidth > el.clientWidth + 1,
    }));
    expect(height, "one line, never two or three").toBeLessThan(lineHeight * 1.5);
    const tip = row.getByTestId("plan-strip-label-tip");
    if (cut) {
      await tip.click();
      await expect(row.getByRole("tooltip")).toHaveText("Measure it, make it safe · 3 roadmap items");
      await page.keyboard.press("Escape");
      await expect(row.getByRole("tooltip")).toBeHidden();
    } else {
      await expect(tip).toHaveCount(0);
    }
    // The row still opens the roadmap filtered to the PRD.
    await row.click({ position: { x: 4, y: 4 } });
    await expect(page).toHaveURL(/\/simple\/roadmap\?prd=guided-setup$/);
  });

  test("B-14: at 1440 every plan row's label fits whole, its item count on the row", async ({ page }) => {
    // protects=B-14 fix 1; fails_when=the labels are cut ("M1 · Measure it, make i…") in a 32% column.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-walk"] as const);
    await login(page);
    await page.goto("/simple/prds/guided-setup");
    const labels = page.getByLabel("Timeline strip").getByTestId("plan-strip-label");
    await expect(labels.first()).toBeVisible();
    await expect(page.getByLabel("Timeline strip").getByTestId("plan-strip-row").filter({ hasText: "Measure it, make it safe · 3 roadmap items" })).toHaveCount(1);
    for (const label of await labels.all()) {
      const text = (await label.textContent())!;
      expect(text).toMatch(/ · \d+ roadmap items?$/);
      const cut = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(cut, `${text} fits whole`).toBe(false);
    }
    await expect(page.getByLabel("Timeline strip").getByTestId("plan-strip-label-tip")).toHaveCount(0);
  });

  test("B-14: the No milestone row and the footnote count the same items", async ({ page }) => {
    await login(page);
    await page.goto("/simple/prds/guided-setup");
    const strip = page.getByLabel("Timeline strip");
    const row = strip.getByTestId("plan-strip-row").filter({ hasText: "No milestone" });
    const label = (await row.getByTestId("plan-strip-label").textContent())!.replace(/\s+/g, " ").trim();
    const inRow = Number(/^No milestone · (\d+) roadmap items?$/.exec(label)?.[1]);
    expect(inRow).toBeGreaterThan(0);
    const edge = strip.getByTestId("plan-strip-edge");
    await expect(edge).toHaveText(/^\d+ of the \d+ roadmap items with no milestone ends? after Jan$/);
    const [, late, ofThem] = /^(\d+) of the (\d+) /.exec((await edge.textContent())!.trim())!;
    expect(Number(ofThem), "the footnote counts the row's own items").toBe(inRow);
    await expect(row.getByTestId("plan-strip-ends")).toHaveText(`${late} of ${inRow} ${late === "1" ? "ends" : "end"} after Jan`);
  });
});
