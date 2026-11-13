import { login } from "./helpers";
import { expect, test, type Page } from "./test";
import { chartCodes } from "./vxe-counts";

/**
 * QA findings, Nov 12, 2026 (docs/qa/2026-11-12/simple-goalmap.md), Simple's Priorities, ranked list and
 * Value / effort, driven through the UI on the mock as the owner.
 * PR1: a feature shows its real code (F-12 for Sample data import), never made-up letters; one with no code
 * is flagged "Not in the Ground Truth". PR2: PM-owned work reads as a short "PM-owned" tag, its why behind an (i).
 * PR3: the NEW pill stays on the title's line. PR4: on a phone the row's ⋯ is pinned top-right.
 * PR5: the quadrant names have a background, so a dashed middle line never runs through them.
 */

const OWNER = "admin@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, theme: "light" | "dark", tab = ""): Promise<void> {
  await page.context().addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
  await login(page, OWNER);
  await page.goto(`/simple/priorities${tab ? `?tab=${tab}` : ""}`);
}

const row = (page: Page, key: string) => page.locator(`[data-testid="prio-row"][data-code="${key}"]`);
const side = (page: Page, key: string) => page.locator(`[data-testid="side-row"][data-code="${key}"]`);
/** A real Ground Truth code ("F-12"), never letters made up from a name ("ARB"). */
const REAL_CODE = /^[A-Z]{1,3}-\d+[a-j]?$/;

test.describe("1440 light", () => {
  test.use({ viewport: DESKTOP });

  test("PR1: ranked rows show the real code, or the Not in the Ground Truth flag", async ({ page }) => {
    // protects: a ranked row shows its feature's real code beside its name, and a row with none is flagged "Not in the Ground Truth"
    // fails_when: a row with no code has no flag, a coded row is flagged, or a made-up code chip shows on a row
    // no_claim: the flag's look
    await open(page, "light");
    const coded = row(page, "setup-import");
    await expect(coded.getByTestId("prio-own-key")).toHaveText("F-12");
    await expect(coded.getByTestId("not-in-gt")).toHaveCount(0);
    const uncoded = row(page, "alert-sso");
    await expect(uncoded.getByTestId("prio-own-key")).toHaveCount(0);
    await expect(uncoded.getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
    await expect(page.getByTestId("prio-row").getByTestId("prio-code")).toHaveCount(0);
  });

  test("PR1: Value / effort marks and the side list never show made-up letters", async ({ page }) => {
    // protects: on Value / effort each mark (or its row in a count) shows only a real code, the side list too, and a feature with no code is flagged in the side list and its mark's name tag
    // fails_when: a mark, a count's row or a side row shows initials (ARB, SC…), or the uncoded feature has no flag
    // no_claim: where the marks sit
    await open(page, "light", "value-effort");
    await expect(page.getByTestId("vxe-point").first()).toBeVisible();
    const codes = await chartCodes(page);
    expect(codes["setup-import"]).toBe("F-12");
    for (const [key, c] of Object.entries(codes)) expect(c === null || REAL_CODE.test(c), `${key} shows ${c}`).toBe(true);
    await expect(side(page, "setup-import").getByTestId("side-code")).toHaveText("F-12");
    await expect(side(page, "alert-sso").getByTestId("side-code")).toHaveCount(0);
    // The side row has no room for the flag: it shows under the row once the row is selected.
    await side(page, "alert-sso").getByRole("button").first().click();
    await expect(side(page, "alert-sso").getByTestId("not-in-gt")).toBeVisible();
    for (const t of await page.getByTestId("side-code").allTextContents()) expect(t.trim()).toMatch(REAL_CODE);
  });

  test("PR2: PM-owned work reads as a short tag, its why behind an (i)", async ({ page }) => {
    // protects: a PM-owned row shows only "PM-owned" (no repeated sentence); its (i) says why it has no score
    // fails_when: "PM-owned, no engineer-weeks, no score" shows on the rows, or the (i) is missing or says nothing
    // no_claim: which rows are PM-owned
    await open(page, "light");
    const pm = page.getByTestId("prio-pm-owned").first();
    await expect(pm).toBeVisible();
    await expect(page.getByText("PM-owned, no engineer-weeks, no score")).toHaveCount(0);
    expect((await pm.innerText()).replace(/\s+/g, " ").trim()).toMatch(/^PM-owned( i)?$/);
    await pm.getByTestId("prio-pm-owned-help").click();
    await expect(page.getByRole("tooltip").filter({ hasText: "no engineer-weeks" })).toBeVisible();
  });

  test("PR3: the NEW pill stays on the title's line", async ({ page }) => {
    // protects: on the ranked list at 1440, every row's current-state pill sits beside its title, never wrapped under it
    // fails_when: a pill's middle is below its title's box (it wrapped to a line of its own)
    // no_claim: the pill's colour or words
    await open(page, "light");
    await expect(page.getByTestId("prio-row").first()).toBeVisible();
    const pills = page.getByTestId("prio-row").getByTestId("prio-name").getByTestId("cs-mark");
    await expect(pills.first()).toBeVisible();
    const rows = page.getByTestId("prio-row").filter({ has: page.getByTestId("prio-name").getByTestId("cs-mark") });
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      const title = (await r.getByTestId("prio-title").boundingBox())!;
      const pill = (await r.getByTestId("prio-name").getByTestId("cs-mark").first().boundingBox())!;
      const mid = pill.y + pill.height / 2;
      expect(mid, `row ${i}: the pill wraps under its title`).toBeGreaterThanOrEqual(title.y - 1);
      expect(mid, `row ${i}: the pill wraps under its title`).toBeLessThanOrEqual(title.y + title.height + 1);
      expect(pill.x).toBeGreaterThan(title.x);
    }
  });

  test("PR5: the quadrant names have a background, so a middle line never runs through them", async ({ page }) => {
    // protects: each Value / effort quadrant name ("Quick wins · 4") has the plot's background behind it, so the dashed middle lines pass under it
    // fails_when: a quadrant name has a transparent background (the dashed line shows through its words)
    // no_claim: where the middle lines fall
    await open(page, "light", "value-effort");
    const names = page.getByTestId("vxe-quadrant");
    await expect(names).toHaveCount(4);
    const plotBg = await page.getByTestId("vxe-plot").evaluate((e) => getComputedStyle(e).backgroundColor);
    for (let i = 0; i < 4; i++) {
      const bg = await names.nth(i).evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
      expect(bg).toBe(plotBg);
    }
    await expect(names.first()).toHaveText(/^Quick wins · \d+$/);
  });
});

test.describe("390 dark", () => {
  test.use({ viewport: PHONE });

  test("PR4: on a phone the row's ⋯ is pinned top-right, never on a line of its own", async ({ page }) => {
    // protects: on a 390-wide phone each ranked row's "More for" button sits at the row's top-right corner, clear of the title
    // fails_when: the button drops to its own line under the row's details, or covers the title
    // no_claim: the menu's items
    await open(page, "dark");
    const rows = page.getByTestId("prio-row");
    await expect(rows.first()).toBeVisible();
    for (let i = 0; i < Math.min(3, await rows.count()); i++) {
      const r = rows.nth(i);
      const more = r.getByRole("button", { name: /^More for / });
      await more.evaluate((e) => e.scrollIntoView({ block: "center" }));
      const box = (await r.boundingBox())!;
      const btn = (await more.boundingBox())!;
      expect(btn.y - box.y, `row ${i}: the ⋯ is not at the top`).toBeLessThan(16);
      expect(box.x + box.width - (btn.x + btn.width), `row ${i}: the ⋯ is not at the right`).toBeLessThan(16);
      const title = (await r.getByTestId("prio-title").boundingBox())!;
      // The title's line ends before the ⋯ (or sits under it).
      expect(title.x + title.width <= btn.x + 1 || title.y >= btn.y + btn.height, `row ${i}: the ⋯ covers the title`).toBe(true);
    }
  });
});
