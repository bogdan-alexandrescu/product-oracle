// Temporary (never committed): captures the built screens beside the picked frames.
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { test, type Page } from "./test";

const OUT = `${process.env.SWARM_ARTIFACTS_DIR}/compare/built-`;
type Shot = { frame: string; w: number; h: number; scenario?: string; steps: string[]; phone?: boolean };
const SHOTS: Shot[] = [
  { frame: "rest", w: 1440, h: 900, steps: [] },
  { frame: "open", w: 1440, h: 900, steps: ["open"] },
  { frame: "mid", w: 1440, h: 900, steps: ["open", "mid"] },
  { frame: "result", w: 1440, h: 900, steps: ["open", "mid", "result"] },
  { frame: "hard", w: 1440, h: 900, scenario: "goal-map-hard", steps: [] },
  { frame: "hard-scrolled", w: 1440, h: 900, scenario: "goal-map-hard", steps: ["scrolled"] },
  { frame: "hard-1512", w: 1512, h: 945, scenario: "goal-map-hard", steps: [] },
  { frame: "phone-390", w: 390, h: 844, steps: [], phone: true },
];

async function run(page: Page, steps: string[]) {
  for (const s of steps) {
    if (s === "open") await page.getByTestId("gm-propose").click();
    if (s === "mid") {
      const ed = page.getByTestId("gm-editor");
      await ed.getByLabel("Name").fill("40 sign-ups per rep");
      await ed.getByLabel("Met when the reading is at least").fill("40");
      await ed.locator("label", { hasText: "Scale per rep" }).click();
      await ed.locator("label", { hasText: "Onboarding & revenue" }).click();
      await ed.getByLabel("Comes after").selectOption({ label: "25 sign-ups per rep" });
    }
    if (s === "result") {
      await page.getByTestId("gm-save").click();
      await page.getByTestId("gm-flash").waitFor();
      await page.waitForTimeout(700);
    }
    if (s === "scrolled") {
      await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('[data-testid="gm-ladder-scroll"]');
        const g = [...document.querySelectorAll<HTMLElement>('[data-testid="gm-gate"]')].find((x) => x.textContent?.includes("8 paid conversions per rep"));
        if (box && g) box.scrollLeft = g.offsetLeft - 200;
        const sec = document.querySelector('[data-testid="gm-ladder"]')!;
        window.scrollTo(0, sec.getBoundingClientRect().top + window.scrollY - 16);
      });
      await page.waitForTimeout(500);
    }
  }
}

for (const shot of SHOTS)
  for (const scheme of ["light", "dark"] as const)
    test(`${shot.frame} ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: shot.phone ? 2 : 1, isMobile: !!shot.phone, hasTouch: !!shot.phone, colorScheme: scheme });
      const page = await ctx.newPage();
      await ctx.addInitScript(([k, v, tk, t]) => { if (v) localStorage.setItem(k, v); localStorage.setItem(tk, t); }, [MOCK_SCENARIO_KEY, shot.scenario ?? "", THEME_KEY, scheme] as const);
      await login(page, ADMIN.email);
      await page.goto("/simple/goals");
      await page.getByTestId("gm-page").waitFor();
      await page.waitForTimeout(600);
      await run(page, shot.steps);
      const name = `${OUT}${shot.frame}`;
      if (scheme === "dark") return void (await page.screenshot({ path: `${name}-dark.png` }), await ctx.close());
      await page.screenshot({ path: `${name}.png` });
      await page.screenshot({ path: `${name}-full.png`, fullPage: true });
      await ctx.close();
    });
