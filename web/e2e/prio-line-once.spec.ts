import { stableUuid } from "../lib/api/mock/ids";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * prio-line-once (the owner, Nov 3: "show it once"): on the "roadmap-keydates" scenario the
 * Guided setup PRD's M1 Prove it ends Nov 27, and the plan's own milestone M1 · Prove it ends
 * that day too. Simple › Priorities' Line picker lists it once, as "From the PRD: M1 · Prove
 * it · Nov 27, 2026" (never also "Milestone: …"); picking it draws the line on its day, and the
 * box reads it in full on a 390 px phone. A saved pick of the plan's milestone (the URL here)
 * draws the same line and shows as the "From the PRD" option. Desktop and phone, light and dark.
 * prio-line-once review: on "roadmap-keydates-uncoded" the onboarding track's milestone "Prove it"
 * (M1's name without its code, on its day), which Simple › Roadmap draws once, is listed once
 * too, as the PRD's M1. With the line drawn, the caption's and the Makes heading's score (i) each open with their
 * own id. Invented data.
 */

const M1 = "M1 · Prove it · Nov 27, 2026";
// The plan's own milestone M1 (the mock's id for it): a pick saved before it was left out.
const PLAN_M1 = `milestone:${stableUuid("simple-plan-milestone/M1")}`;

async function setUp(page: Page, scheme: "light" | "dark", scenario = "roadmap-keydates"): Promise<void> {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
}

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/simple/priorities${query}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${name}, ${scheme}`, () => {
      test.use({ viewport });

      test("the Line picker lists a PRD milestone once and draws its line", async ({ page }) => {
        await setUp(page, scheme);
        await open(page);
        const select = page.getByTestId("line-picker").getByLabel("Line", { exact: true });
        await expect(select).toBeVisible();
        const options = select.locator("option");
        await expect(options.filter({ hasText: `From the PRD: ${M1}` })).toHaveCount(1);
        // Each milestone once: no "<name> · <day>" is listed twice, as a key date and a milestone.
        const texts = await options.allTextContents();
        const named = texts.filter((t) => / · /.test(t)).map((t) => t.replace(/^(Key date|From the PRD|Milestone): /, ""));
        expect(named.length).toBeGreaterThan(1);
        expect(new Set(named).size, texts.join("\n")).toBe(named.length);
        expect(texts).not.toContain(`Milestone: ${M1}`);

        // Picked, it draws the line on its day, and the box reads it in full.
        await select.selectOption({ label: `From the PRD: ${M1}` });
        const heads = page.getByTestId("prio-part-head");
        await expect(heads).toHaveCount(2);
        await expect(heads.nth(0)).toHaveAttribute("aria-label", `Makes ${M1}`);
        await expect(heads.nth(1)).toHaveAttribute("aria-label", `Misses ${M1}`);
        await expectShownInFull(page, `From the PRD: ${M1}`);
      });

      // qa-prio-twins (review of #1503): the caption's and the Makes heading's score (i) show at once, one id each.
      test("both score (i)s of a list split at the line open, each with its own id", async ({ page }) => {
        await setUp(page, scheme);
        await open(page);
        await page.getByTestId("line-picker").getByLabel("Line", { exact: true }).selectOption({ label: `From the PRD: ${M1}` });
        const heads = page.getByTestId("prio-part-head");
        await expect(heads).toHaveCount(2);
        const words = "Score = goal value × Oracle's confidence in it (0 to 1) ÷ effort in engineer-weeks.";
        await page.getByTestId("line-caption").getByTestId("prio-score-help").click();
        await expect(page.locator("#prio-score-text")).toHaveText(words);
        await heads.nth(0).getByTestId("prio-score-help").click();
        await expect(page.locator("#prio-score-text-makes")).toHaveText(words);
        const ids = await page.locator("[id^='prio-score-text']").evaluateAll((els) => els.map((e) => e.id));
        expect(new Set(ids).size, ids.join(", ")).toBe(ids.length);
      });

      test("a milestone named without its code on M1's day is listed once, as the PRD's M1", async ({ page }) => {
        await setUp(page, scheme, "roadmap-keydates-uncoded");
        await open(page);
        const options = page.getByTestId("line-picker").getByLabel("Line", { exact: true }).locator("option");
        await expect(options.filter({ hasText: `From the PRD: ${M1}` })).toHaveCount(1);
        const texts = await options.allTextContents();
        expect(texts.filter((t) => t.includes("Prove it")), texts.join("\n")).toEqual([`From the PRD: ${M1}`]);
      });

      test("a saved pick of the plan's M1 draws the same line, shown as From the PRD", async ({ page }) => {
        await setUp(page, scheme);
        await open(page, `?line=${encodeURIComponent(PLAN_M1)}`);
        const heads = page.getByTestId("prio-part-head");
        await expect(heads).toHaveCount(2);
        await expect(heads.nth(0)).toHaveAttribute("aria-label", `Makes ${M1}`);
        await expectShownInFull(page, `From the PRD: ${M1}`);
      });
    });
  }
}

/** The select shows `label` as its chosen option, never an empty box, and fits it whole inside the page. */
async function expectShownInFull(page: Page, label: string): Promise<void> {
  const select = page.locator("#prio-line");
  await expect.poll(() => select.evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? "")).toBe(label);
  // The label's own width (in the box's font) and the box's padding fit inside the box.
  const fit = await select.evaluate((s: HTMLSelectElement, text: string) => {
    const css = getComputedStyle(s);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    const need = ctx.measureText(text).width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
    return { need, has: s.clientWidth, right: s.getBoundingClientRect().right, page: document.documentElement.clientWidth };
  }, label);
  expect(fit.need).toBeLessThanOrEqual(fit.has + 1);
  expect(fit.right).toBeLessThanOrEqual(fit.page);
  await page.getByTestId("line-picker").screenshot({ path: test.info().outputPath("line-picker.png") });
}
