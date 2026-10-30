import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * QA fixes on Simple's shell, Home and the plan strip (qa-simple-home-1, 2, 11, 12, 25, 29, 30,
 * 31, 32), driven through the UI against the mock (invented data). Phone = 390x844.
 *
 * Card fix2-simple-home-shell: protects = a phone page ends clear of the tab bar; the More sheet
 * closes on Escape (focus back on More), a tap outside and Ask; the phone shows the rail's counts;
 * the Mode switch is one Tab stop with arrow keys; the three segmented switches share one look;
 * the phone logo is a 44 px target; the rail shows a person's email in full; the goal cards
 * share the row; the plan strip's months line up with its rows, its bars show in dark and its
 * labels wrap on a phone; fails_when = any of those regresses; no_claim = the real API.
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;
const PHONE = { width: 390, height: 844 };

async function setUp(page: Page, scenario: string | null, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario ?? "", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

const box = async (l: Locator) => (await l.boundingBox())!;

test("qa-simple-home-1: on a phone the end of Home, Meetings and Priorities clears the tab bar", async ({ page }) => {
  await setUp(page, "simple-home");
  await page.setViewportSize(PHONE);
  await signIn(page, EMAILS.owner);
  for (const [path, frame] of [
    ["/simple", '[data-testid="simple-page"]'],
    ["/simple/meetings", '[data-testid="simple-page"]'],
    ["/simple/priorities", '[data-testid="simple-priorities"]'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator(frame).first()).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate((sel) => {
            const root = document.documentElement;
            // Wait for the page to be longer than the screen (its content has loaded).
            if (root.scrollHeight <= window.innerHeight + 100) return "short";
            window.scrollTo(0, root.scrollHeight);
            // Mid-navigation the frame or the bar may not be there yet: poll again.
            const last = document.querySelector(sel)?.lastElementChild;
            const bar = document.querySelector('[data-testid="simple-tab-bar"]');
            if (!last || !bar) return "loading";
            return last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top ? "clear" : "under the tab bar";
          }, frame),
        { message: path },
      )
      .toBe("clear");
  }
});

test("qa-simple-home-2: the phone's More sheet closes on Escape, a tap outside and Ask", async ({ page }) => {
  await setUp(page, "simple-home");
  await page.setViewportSize(PHONE);
  await signIn(page, EMAILS.owner);
  const more = page.getByTestId("simple-tab-more");
  const sheet = page.getByRole("dialog", { name: "More" });

  await more.click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: "Meetings", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");

  // qa-simple-home-19: the sheet dims the page; a tap on the dimmed page (over the title) closes it.
  await more.click();
  await expect(sheet).toBeVisible();
  const title = await box(page.getByTestId("phone-title"));
  await page.getByTestId("simple-more-sheet").getByTestId("sheet-scrim").click({ position: { x: title.x + 5, y: title.y + 5 } });
  await expect(sheet).toBeHidden();

  // Its close button closes it too; the header's Ask then opens Ask.
  await more.click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close More" }).click();
  await expect(sheet).toBeHidden();
  await page.getByTestId("phone-ask").click();
  await expect(page.getByTestId("phone-ask-sheet")).toBeVisible();
});

test("qa-simple-home-29: the phone's tabs and More sheet show the rail's counts", async ({ page }) => {
  await setUp(page, "simple-home");
  await signIn(page, EMAILS.owner);
  const rail = page.getByTestId("simple-nav");
  await expect(rail.getByTestId("simple-nav-roadmap-count")).toBeVisible();
  const counts: Record<string, string> = {};
  for (const d of ["roadmap", "decisions", "meetings"]) {
    const c = rail.getByTestId(`simple-nav-${d}-count`);
    if (await c.count()) counts[d] = (await c.textContent())!.trim();
  }
  expect(Object.keys(counts).length).toBeGreaterThan(0);

  await page.setViewportSize(PHONE);
  const bar = page.getByTestId("simple-tab-bar");
  for (const d of ["roadmap", "decisions"]) {
    const badge = bar.getByTestId(`simple-tab-${d}-count`);
    if (counts[d]) {
      await expect(badge).toHaveText(counts[d]);
      await expect(badge).toBeVisible();
      // The tab's name stays its label; the count is its description.
      const tab = bar.getByTestId(`simple-tab-${d}`);
      await expect(tab).toHaveAccessibleName(d === "roadmap" ? "Roadmap" : "Decisions");
      await expect(tab).toHaveAccessibleDescription(/waiting on you/);
    } else await expect(badge).toHaveCount(0);
  }
  if (counts.meetings) {
    await expect(page.getByTestId("simple-tab-more-count")).toHaveText(counts.meetings);
    await page.getByTestId("simple-tab-more").click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet.getByTestId("simple-more-meetings-count")).toHaveText(counts.meetings);
    await expect(sheet.getByRole("link", { name: "Meetings", exact: true })).toHaveAccessibleDescription(/live or coming up/);
  }
});

test("qa-simple-home-30: the rail's Mode switch is one Tab stop; the arrow keys move, Enter opens", async ({ page }) => {
  await setUp(page, "simple-home");
  await signIn(page, EMAILS.owner);
  const simple = page.getByTestId("mode-simple");
  const detailed = page.getByTestId("mode-detailed");
  await expect(simple).toHaveAttribute("aria-checked", "true");
  await expect(simple).toHaveAttribute("tabindex", "0");
  await expect(detailed).toHaveAttribute("tabindex", "-1");
  await simple.focus();
  await page.keyboard.press("Tab");
  await expect(detailed).not.toBeFocused();
  await expect(page.getByTestId("simple-nav-home")).toBeFocused();
  // With the shell's radio keys: an arrow moves focus without leaving the page; Enter opens it.
  await simple.focus();
  await page.keyboard.press("ArrowRight");
  await expect(detailed).toBeFocused();
  await expect(page).toHaveURL(/\/simple(\/|$|\?)/);
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(/\/simple(\/|$|\?)/);
});

test("qa-simple-home-31: the rail's, the More sheet's and the account menu's switches look the same", async ({ page }) => {
  await setUp(page, "simple-home");
  await signIn(page, EMAILS.owner);
  const look = (l: Locator) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.color, s.borderRadius, s.boxShadow, s.fontWeight, s.fontSize, s.height, s.borderTopWidth].join(" | ");
    });
  const track = (l: Locator) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.borderRadius, s.padding, s.borderTopWidth].join(" | ");
    });
  const rail = page.getByTestId("mode-switch");
  const railOn = await look(rail.locator('[aria-checked="true"]'));
  const railOff = await look(rail.locator('[aria-checked="false"]'));
  const railTrack = await track(rail);

  await page.getByTestId("user-menu").click();
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await expect(theme).toBeVisible();
  expect(await look(theme.locator('[aria-checked="true"]'))).toBe(railOn);
  expect(await look(theme.locator('[aria-checked="false"]').first())).toBe(railOff);
  expect(await track(theme)).toBe(railTrack);
  await page.keyboard.press("Escape");

  await page.setViewportSize(PHONE);
  await page.getByTestId("simple-tab-more").click();
  const sheet = page.getByTestId("mode-switch-sheet");
  await expect(sheet).toBeVisible();
  // fix4 (qa-simple-home-19): the More sheet is the ds Sheet, whose controls are 44 px touch
  // targets; the rest of the look is the rail's.
  const noHeight = (s: string) => s.split(" | ").filter((_, i) => i !== 6).join(" | ");
  expect(noHeight(await look(sheet.locator('[aria-checked="true"]')))).toBe(noHeight(railOn));
  expect(noHeight(await look(sheet.locator('[aria-checked="false"]')))).toBe(noHeight(railOff));
  expect((await sheet.locator('[aria-checked="true"]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await track(sheet)).toBe(railTrack);
});

test("qa-simple-home-32: the phone header's logo is a 44 px target, the mark where it was", async ({ page }) => {
  await setUp(page, "simple-home");
  await page.setViewportSize(PHONE);
  await signIn(page, EMAILS.owner);
  const brand = page.getByTestId("phone-brand");
  const b = await box(brand);
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.height).toBeGreaterThanOrEqual(44);
  const mark = await box(brand.locator("svg"));
  expect(mark.width).toBe(22);
  expect(Math.abs(mark.x - 12)).toBeLessThanOrEqual(1);
  // The title still starts 10 px after the mark.
  const title = await box(page.getByTestId("phone-title"));
  expect(Math.abs(title.x - (mark.x + mark.width + 10))).toBeLessThanOrEqual(1);
});

test("qa-simple-home-25: the rail shows a person's email in full", async ({ page }) => {
  await setUp(page, "simple-home");
  await signIn(page, EMAILS.viewer);
  const name = page.getByTestId("simple-person-name");
  await expect(name).toHaveText("viewer@example.com");
  await expect(name).toHaveAttribute("title", "viewer@example.com");
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true);
  const rail = await box(page.getByTestId("simple-nav"));
  const n = await box(name);
  expect(n.x + n.width).toBeLessThanOrEqual(rail.x + rail.width);
});

test("qa-simple-home-11: the goal cards share the row and a short path stays on one line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setUp(page, null);
  await signIn(page, EMAILS.owner);
  const goals = page.getByTestId("home-goal");
  await expect(goals.first()).toBeVisible();
  const n = await goals.count();
  expect(n).toBeGreaterThan(0);
  const band = await box(page.locator(".simple-goal-band").first());
  const gap = await page.locator(".simple-goal-band").first().evaluate((el) => parseFloat(getComputedStyle(el).columnGap) || 0);
  const first = await box(goals.first());
  const row = [];
  for (let i = 0; i < n; i++) {
    const g = await box(goals.nth(i));
    if (Math.abs(g.y - first.y) < 1) row.push(g);
  }
  // The first row's cards fill the band's width: no empty tracks beside them.
  const used = row.reduce((s, g) => s + g.width, 0) + gap * (row.length - 1);
  expect(Math.abs(used - band.width)).toBeLessThanOrEqual(2);
  // "From 31% · now 38% · target 45%": the target on the same line as "From".
  const path = page.getByTestId("home-goal-path").filter({ hasText: /target 45%$/ }).first();
  await expect(path).toBeVisible();
  const tops = await path.evaluate((el) => {
    const text = el.firstChild!;
    const s = text.textContent!;
    const at = (from: number, to: number) => {
      const r = document.createRange();
      r.setStart(text, from);
      r.setEnd(text, to);
      return r.getBoundingClientRect().top;
    };
    return [at(0, 4), at(s.length - 3, s.length)];
  });
  expect(Math.abs(tops[0] - tops[1])).toBeLessThanOrEqual(1);
});

for (const phone of [false, true]) {
  test(`qa-simple-home-12: the plan strip's months line up with its rows, its bars show in dark, labels wrap (${phone ? "phone" : "desktop"}, dark)`, async ({ page }) => {
    await page.setViewportSize(phone ? PHONE : { width: 1366, height: 820 });
    await setUp(page, null, "dark");
    await signIn(page, EMAILS.viewer);
    await page.goto("/simple/prds/guided-setup");
    const strip = page.getByLabel("Timeline strip");
    const months = strip.getByTestId("plan-strip-month");
    await expect(months.first()).toBeVisible();
    const ticks = await Promise.all((await months.all()).map(async (m) => (await box(m)).x));
    const rows = strip.getByTestId("plan-strip-row");
    for (let r = 0; r < (await rows.count()); r++) {
      const lines = rows.nth(r).getByTestId("plan-strip-gridline");
      await expect(lines).toHaveCount(ticks.length);
      for (let i = 0; i < ticks.length; i++) expect(Math.abs((await box(lines.nth(i))).x - ticks[i])).toBeLessThanOrEqual(1);
    }
    // Every label in full (wrapped on a phone, never "No milestone…").
    const label = strip.getByTestId("plan-strip-label").filter({ hasText: /^No milestone/ });
    await expect(label).toHaveText(/^No milestone · \d+ items?$/);
    for (const l of await strip.getByTestId("plan-strip-label").all())
      expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true);
    // A solid bar stands out from its card in dark (contrast at least 1.5:1).
    const ratio = await strip
      .locator('[data-testid="plan-strip-span"]:not([data-estimated])')
      .first()
      .evaluate((el) => {
        const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        let p = el.parentElement;
        while (p && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(p).backgroundColor)) p = p.parentElement;
        const a = lum(rgb(getComputedStyle(el).backgroundColor));
        const b = lum(rgb(getComputedStyle(p ?? document.body).backgroundColor));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    expect(ratio).toBeGreaterThanOrEqual(1.5);
  });
}
