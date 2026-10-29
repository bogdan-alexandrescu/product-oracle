import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The one-pager's plan strip, its bets' flows and its start sheet, from the PRD QA walk
 * (qa-simple-prd-13/20/21/22/33/38/39/40/46), driven through the UI on the mock (invented
 * data) on a desktop (1440x900) and, where the layout differs, a phone (390x844).
 *
 * - qa-13: protects = a plan bar reads against its card at 3:1 or more, light and dark (a
 *   dashed estimated bar by its outline); fails_when = the pale accent-soft fill.
 * - qa-20: protects = a flow's time carries the company zone, and its day when not today;
 *   fails_when = "drawn 8:00 AM" with no zone or day.
 * - qa-21: protects = Ask Oracle to draw it on a bet titles the flow from the bet's words;
 *   fails_when = "A bet of the one-pager".
 * - qa-22: protects = the opened flow and the storyboard dim the page behind; a click on it
 *   closes them; fails_when = no backdrop.
 * - qa-33: protects = bets with no flow give the hint once, under a flow icon (boxes, not the
 *   roadmap's dots); fails_when = the hint repeats on every bet.
 * - qa-38: protects = on a phone the strip's labels sit whole above their bars and a flow's
 *   thumbnail sits above its name; fails_when = labels cut with "…" or the title squeezed.
 * - qa-39/40: protects = no row repeats the PRD's title, bare codes read "Milestone M1", and
 *   the commitments past the edge say where they are, with no arrow; fails_when = "Guided
 *   setup" over the months, "M1 · 12 items", "1 commitment ends past Jan →".
 * - qa-46: protects = the start sheet's checkboxes, radios and selects are the app's styled
 *   controls, Cancel sits beside Start and closes, and the backdrop covers the whole page
 *   (rail included); fails_when = bare native controls, no Cancel, or the rail undimmed.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const URL = "/simple/prds/guided-setup";

async function open(page: Page, scheme: "light" | "dark" = "light") {
  // The default scenario: the one-pager with no dated plan, so its Timeline strip shows.
  await page.context().addInitScript(
    ([key, themeKey, theme]) => {
      localStorage.removeItem(key);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("one-pager")).toBeVisible();
}

const strip = (page: Page) => page.getByLabel("Timeline strip").getByTestId("plan-strip");
const bet = (page: Page, n: number) => page.getByRole("group", { name: `User flow of bet ${n}` }).getByTestId("flow-row");

/** The contrast of each bar against the card it sits on (a colour read through a canvas, so any CSS colour form works). */
async function barContrasts(s: Locator): Promise<{ estimated: boolean; ratio: number }[]> {
  return s.evaluate((root) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let el: Element | null = root;
    let card = "rgb(255,255,255)";
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (rgba(bg)[3] > 0.5) {
        card = bg;
        break;
      }
      el = el.parentElement;
    }
    const lc = lum(rgba(card));
    return [...root.querySelectorAll<HTMLElement>('[data-testid="plan-strip-bar"]')].map((bar) => {
      const estimated = bar.dataset.estimated === "true";
      const cs = getComputedStyle(bar);
      const lb = lum(rgba(estimated ? cs.borderTopColor : cs.backgroundColor));
      return { estimated, ratio: (Math.max(lb, lc) + 0.05) / (Math.min(lb, lc) + 0.05) };
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-13: the plan bars read at 3:1 or more against the card (${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(strip(page).getByTestId("plan-strip-row")).toHaveCount(4);
      const bars = await barContrasts(strip(page));
      expect(bars.length).toBe(4);
      expect(bars.some((b) => !b.estimated)).toBe(true);
      for (const b of bars) expect(b.ratio, `${b.estimated ? "estimated" : "committed"} bar`).toBeGreaterThanOrEqual(3);
    });
  }

  test("qa-39/40: no row repeats the PRD's title; milestones are named; the edge says where, with no arrow", async ({ page }) => {
    await open(page);
    const s = strip(page);
    await expect(s.getByTestId("plan-strip-month")).toHaveText(["Oct", "Nov", "Dec", "Jan"]);
    await expect(s).not.toContainText("Guided setup");
    await expect(s.getByTestId("plan-strip-label")).toHaveText(["Milestone M1 · 12 items", "Milestone M2 · 5 items", "Milestone M3 · 3 items", "No milestone · 2 items"]);
    await expect(s.getByTestId("plan-strip-edge")).toHaveText("1 commitment with no milestone ends after Jan");
    await expect(s).not.toContainText("→");
  });

  test("qa-20: a flow's time carries the company zone, and its day when not today", async ({ page }) => {
    await open(page);
    // Drawn Oct 26 (the mock's today is Oct 22): the day and the zone.
    await expect(bet(page, 2).getByTestId("flow-drawn")).toHaveText("Version 1 · drawn Oct 26, 8:00 AM PDT");
    await bet(page, 2).getByRole("button", { name: "Open the flow", exact: true }).click();
    await expect(page.getByTestId("flow-detail").getByTestId("flow-drawn")).toHaveText("Version 1 · drawn Oct 26, 8:00 AM PDT");
  });

  test("qa-21: Ask Oracle to draw it titles the flow from the bet's words; drawn today, the time alone with its zone", async ({ page }) => {
    await open(page);
    const row = bet(page, 3);
    await expect(row.getByTestId("flow-empty")).toContainText("No flow yet");
    await row.getByRole("button", { name: "Ask Oracle to draw it" }).click();
    await expect(row.getByTestId("flow-row-drawn")).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("flow-row-drawn").locator("b").first()).toHaveText("Invite suggestions from the admin's calendar");
    await expect(row).not.toContainText("A bet of the one-pager");
    await expect(row.getByTestId("flow-drawn")).toHaveText(/^Version 1 · drawn \d{1,2}:\d{2} [AP]M P[DS]T$/);
  });

  test("qa-22: the opened flow and the storyboard dim the page behind; a click on it closes them", async ({ page }) => {
    await open(page);
    const row = bet(page, 2);
    for (const [button, testId] of [["Open the flow", "flow-detail"], ["Open the storyboard", "flow-storyboard"]] as const) {
      await row.getByRole("button", { name: button, exact: true }).click();
      await expect(page.getByTestId(testId)).toBeVisible();
      const backdrop = page.getByTestId("flow-backdrop");
      await expect(backdrop).toBeVisible();
      const look = await backdrop.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, bg: getComputedStyle(el).backgroundColor, corner: document.elementFromPoint(4, window.innerHeight - 4) === el };
      });
      expect(look.w).toBe(DESKTOP.width);
      expect(look.h).toBe(DESKTOP.height);
      expect(look.bg).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
      // The rail's corner is under the backdrop, not above it.
      expect(look.corner).toBe(true);
      await page.mouse.click(4, DESKTOP.height - 4);
      await expect(page.getByTestId(testId)).toHaveCount(0);
      await expect(backdrop).toHaveCount(0);
    }
  });

  test("qa-33: bets with no flow give the hint once, under a flow icon", async ({ page }) => {
    await open(page);
    const bets = page.getByRole("region", { name: "What we will build" });
    // Bets 3 and 4 have no flow yet.
    await expect(bets.getByTestId("flow-empty").filter({ hasText: "No flow yet" })).toHaveCount(2);
    await expect(bets.locator("p:visible", { hasText: "Oracle draws the steps and the screen they touch, from the PRD." })).toHaveCount(1);
    // The first of them gives it.
    await expect(bet(page, 3).getByText("Oracle draws the steps and the screen they touch, from the PRD.")).toBeVisible();
    // The empty box's icon is a flow (boxes joined), not the Roadmap's lines and dots.
    const icon = bet(page, 3).getByTestId("flow-empty").locator("svg").first();
    await expect(icon.locator("rect")).toHaveCount(3);
    await expect(icon.locator("circle")).toHaveCount(0);
  });

  test("qa-46: the start sheet uses the app's controls, has Cancel beside Start and dims the whole page", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Start review" }).click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await expect(sheet.getByRole("checkbox", { name: "Admin" })).toBeVisible();
    const looks = await sheet.evaluate((root) => {
      const box = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const radio = root.querySelector<HTMLInputElement>('input[type="radio"]')!;
      const select = root.querySelector<HTMLSelectElement>("select")!;
      const s = getComputedStyle(select);
      return {
        boxAccent: getComputedStyle(box).accentColor,
        radioAccent: getComputedStyle(radio).accentColor,
        boxSize: box.getBoundingClientRect().width,
        selectRadius: parseFloat(s.borderTopLeftRadius),
        selectHeight: select.getBoundingClientRect().height,
        selectBg: s.backgroundColor,
      };
    });
    expect(looks.boxAccent).not.toBe("auto");
    expect(looks.radioAccent).toBe(looks.boxAccent);
    expect(looks.boxSize).toBeGreaterThanOrEqual(18);
    expect(looks.selectRadius).toBeGreaterThanOrEqual(6);
    expect(looks.selectHeight).toBeGreaterThanOrEqual(36);
    expect(looks.selectBg).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    // Cancel beside Start, in one row.
    const start = sheet.getByRole("button", { name: "Start", exact: true });
    const cancel = sheet.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeVisible();
    const [a, b] = [(await cancel.boundingBox())!, (await start.boundingBox())!];
    expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(4);
    expect(a.x).toBeLessThan(b.x);
    // The backdrop is on top everywhere outside the sheet: the rail, the page, the corners.
    const backdrop = page.getByTestId("start-backdrop");
    const covered = await backdrop.evaluate((el) =>
      [[8, 8], [40, 450], [window.innerWidth - 8, 8], [8, window.innerHeight - 8], [window.innerWidth - 8, window.innerHeight - 8]].every(([x, y]) => document.elementFromPoint(x, y) === el),
    );
    expect(covered).toBe(true);
    await cancel.click();
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("desktop: the opened flow's diagram (qa-23, qa-28)", () => {
  test.use({ viewport: DESKTOP });

  /*
   * - qa-23: protects = every step and the No branch read in full words at 13 px or more on
   *   the screen (the boxes grow with their words; the diagram is not scaled down); fails_when =
   *   "The checklist moves on and asks..." or labels drawn at ~10 px.
   * - qa-28: protects = the storyboard cards say who and the screen in plain, normal-case
   *   words; fails_when = "USER" / "SCREEN".
   */
  test("qa-23: the diagram's steps are whole and read at 13 px or more", async ({ page }) => {
    await open(page);
    await bet(page, 2).getByRole("button", { name: "Open the flow", exact: true }).click();
    const opened = page.getByTestId("flow-detail");
    await expect(opened.getByRole("heading", { level: 2 })).toHaveText("Finish setup from the checklist · flow");
    const svg = opened.getByTestId("flow-svg");
    await expect(svg).toBeVisible();
    const look = await svg.evaluate((el) => {
      const texts = [...el.querySelectorAll<SVGTextElement>("text")].filter((t) => t.querySelector("tspan"));
      return {
        words: texts.map((t) => [...t.querySelectorAll("tspan")].map((s) => s.textContent).join(" ")),
        px: texts.map((t) => (t as SVGGraphicsElement).getScreenCTM()!.a * parseFloat(getComputedStyle(t).fontSize)),
        all: el.textContent ?? "",
      };
    });
    expect(look.all).not.toMatch(/…|\.\.\./);
    for (const step of ["Sign in as a new admin", "See the setup checklist", "Invite now or later?", "Invite a teammate", "See the progress meter fill", "The checklist moves on and asks again tomorrow"]) {
      expect(look.words, step).toContain(step);
    }
    for (const [k, px] of look.px.entries()) expect(px, look.words[k]).toBeGreaterThanOrEqual(13);
    // The No branch's box holds its words.
    const no = await svg.getByTestId("flow-no").evaluate((g) => {
      const box = g.querySelector("rect")!.getBoundingClientRect();
      const t = g.querySelector("text")!.getBoundingClientRect();
      return { inside: t.top >= box.top - 1 && t.bottom <= box.bottom + 1 && t.left >= box.left - 1 && t.right <= box.right + 1 };
    });
    expect(no.inside).toBe(true);
  });

  test("qa-28: the storyboard's cards say who and the screen in plain words", async ({ page }) => {
    await open(page);
    await bet(page, 2).getByRole("button", { name: "Open the storyboard", exact: true }).click();
    const cards = page.getByTestId("flow-storyboard").getByTestId("story-card");
    await expect(cards.first().getByTestId("story-who")).toHaveText("User");
    await expect(cards.first().getByTestId("story-who")).toHaveCSS("text-transform", "none");
    const screen = cards.last();
    await expect(screen).toHaveAccessibleName("The screen");
    await expect(screen).not.toContainText("SCREEN");
    expect(await screen.evaluate((el) => (el as HTMLElement).innerText)).not.toContain("SCREEN");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-38: the strip's labels sit whole above their bars", async ({ page }) => {
    await open(page);
    const rows = strip(page).getByTestId("plan-strip-row");
    await expect(rows).toHaveCount(4);
    for (let k = 0; k < 4; k++) {
      const fit = await rows.nth(k).evaluate((row) => {
        const label = row.querySelector<HTMLElement>('[data-testid="plan-strip-label"]')!;
        const bar = row.querySelector<HTMLElement>('[data-testid="plan-strip-bar"]')!;
        return { cut: label.scrollWidth > label.clientWidth + 1, labelBottom: label.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
      });
      expect(fit.cut, `row ${k + 1}'s label is whole`).toBe(false);
      expect(fit.labelBottom, `row ${k + 1}'s label is above its bar`).toBeLessThanOrEqual(fit.barTop);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  });

  test("qa-38: a flow's thumbnail sits above its name", async ({ page }) => {
    await open(page);
    const row = bet(page, 2);
    const thumb = (await row.getByTestId("flow-row-thumb").boundingBox())!;
    const name = (await row.getByTestId("flow-row-drawn").locator("b").first().boundingBox())!;
    expect(thumb.y + thumb.height).toBeLessThanOrEqual(name.y);
    // The name has the row's width, not what is left beside the thumbnail.
    expect(name.x).toBeLessThan(thumb.x + thumb.width);
  });
});
