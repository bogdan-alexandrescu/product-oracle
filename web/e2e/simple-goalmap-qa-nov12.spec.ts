import { GM_TRACKS_HARD_SCENARIO, GM_TRACKS_SCENARIO } from "../lib/api/mock/goal-map-tracks";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA of Nov 12, 2026 on the Simple Goal map (docs/qa/2026-11-12/simple-goalmap.md): GM1 the
 * "No track" row's chips show their code (or the "Not in the Ground Truth" flag), GM3 a wrapped
 * track name reads at normal line height, GM4 a long milestone name wraps instead of being cut,
 * GM5 on a phone the goal cards pass under a solid corner cell. Mock data only (invented).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scenario?: string, theme?: "light" | "dark") {
  if (scenario) await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  if (theme) await page.context().addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
  await login(page, ADMIN.email);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("GM1: every chip in the No track row shows its code, or the Not in the Ground Truth flag", async ({ page }) => {
    // protects=a chip whose feature has no roadmap item still shows the code the map reads for it,
    // and a chip with no code at all carries the flag; fails_when=the No track row shows a bare name;
    // no_claim=the codes' numbering.
    await open(page, "goal-map-hard");
    const row = page.locator('[data-testid="gm-chip"][data-track="none"]');
    await expect(row.first()).toBeVisible();
    const coded = row.filter({ has: page.locator(".simple-code") });
    const flagged = row.filter({ has: page.getByTestId("not-in-gt") });
    const all = await row.count();
    expect(all).toBeGreaterThan(5);
    // Every chip names its code or is flagged; never a bare name.
    expect((await coded.count()) + (await flagged.count())).toBe(all);
    expect(await coded.count()).toBeGreaterThan(0);
    await expect(row.filter({ hasText: "Call queue autopilot" }).getByRole("button", { name: /^F-151\s*Call queue autopilot/ })).toBeVisible();
    await expect(row.filter({ hasText: "Faster ID check" }).getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
  });

  test("GM3: a wrapped track name reads at normal line height", async ({ page }) => {
    // protects=the track label's lines sit close (about 18px apart), as the chips' do;
    // fails_when=the label inherits the page's tall line height (about 28px); no_claim=colours.
    await open(page, GM_TRACKS_SCENARIO);
    const label = page.getByTestId("gm-track").filter({ hasText: /^Account Management$/ });
    await expect(label).toBeVisible();
    const lh = await label.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(lh).toBeLessThanOrEqual(20);
  });

  test("GM4: a long milestone name wraps instead of being cut", async ({ page }) => {
    // protects=a milestone's whole name reads on its strip (up to two lines), with no tooltip
    // needed; fails_when=it is cut with an ellipsis; no_claim=the strip's order.
    await open(page, GM_TRACKS_HARD_SCENARIO);
    for (const name of ["Self-serve setup", "Annual plans live"]) {
      const words = page.getByTestId("gm-strip-milestone").locator(`[title="${name}"]`);
      await expect(words).toHaveText(name);
      const cut = await words.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
      expect(cut, `"${name}" is cut`).toBe(false);
    }
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("GM5: the goal cards pass under a solid corner cell when the grid scrolls sideways", async ({ page }) => {
    // protects=on a phone the empty corner above the track names holds still with a solid
    // background, so a goal card scrolled sideways goes under it; fails_when=the card shows through
    // or over the corner; no_claim=the colour itself.
    await open(page, undefined, "dark");
    const corner = page.getByTestId("gm-corner");
    const card = page.getByTestId("gm-goal").first();
    await expect(card).toBeVisible();
    await page.getByTestId("gm-grid").evaluate((el) => (el.scrollLeft = 200));
    const box = await corner.boundingBox();
    const cardBox = await card.boundingBox();
    expect(box && cardBox).toBeTruthy();
    // The card now starts left of the corner's right edge: the corner must be on top of it.
    expect(cardBox!.x).toBeLessThan(box!.x + box!.width);
    const onTop = await corner.evaluate((el, y) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, y);
      return !!at && el.contains(at);
    }, cardBox!.y + cardBox!.height / 2);
    expect(onTop).toBe(true);
    const bg = await corner.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
  });
});
