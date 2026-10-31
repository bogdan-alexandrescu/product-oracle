import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap (qa4-simple-roadmap-N), driven as a person does against the
 * mock's invented data: the default scenario, "simple-plan-lanes" (Guided setup's plan on the
 * onboarding roadmap, its slices under the Reliability, Growth, ... goals) and "roadmap-talk"
 * (the item card's Talk to Oracle).
 */

const DESKTOP = { viewport: { width: 1512, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, opts: { scenario?: string; theme?: "light" | "dark"; url?: string } = {}) {
  const { scenario = "", theme = "light", url = "/simple/roadmap" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey, t]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, t);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1512) <= 640;
const column = (page: Page, key: string): Locator => page.locator(`[data-testid="board-column"][data-horizon-column="${key}"]`);

async function openCard(page: Page, key: string): Promise<Locator> {
  if (!isPhone(page)) {
    const body = page.locator(`g[data-testid="bar"][data-item="${key}"]`).locator("rect[data-body], rect[data-slice-body]").first();
    await expect(body).toBeVisible();
    await body.click();
  } else await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card).toBeVisible();
  return card;
}

/** The WCAG contrast of two "#rrggbb" or "rgb(…)" colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const hex = c.trim().match(/^#([0-9a-f]{6})$/i);
    const parts = hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) : c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const [r, g, bl] = parts.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

for (const [where, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(size);

    test(`qa4-1 / 10: Now / Next / Later groups by the same goal lanes as the Timeline; a card per goal (${where})`, async ({ page }) => {
      await open(page, { scenario: "simple-plan-lanes", url: "/simple/roadmap?roadmap=onboarding-roadmap" });
      const laneTitles = isPhone(page)
        ? await page.getByTestId("phone-lane-name").allTextContents()
        : await page.getByTestId("chart-group").evaluateAll((gs) => gs.map((g) => g.querySelector("b")?.textContent ?? ""));
      const goals = laneTitles.filter((t) => t !== "No goal" && t !== "Below the line");
      expect(goals.length).toBeGreaterThan(1);
      // 10: a card for every goal with a lane.
      for (const g of goals) await expect(page.getByTestId("goal-counter").filter({ hasText: g })).toHaveCount(1);
      await page.getByTestId("format-board").click();
      await expect(page.getByTestId("board-group").first()).toBeVisible();
      const sections = new Set(await page.getByTestId("board-group").evaluateAll((gs) => gs.map((g) => g.querySelector("h3 span")?.textContent ?? "")));
      // Every board section is one of the Timeline's lanes, and every goal lane shows on the board.
      for (const t of sections) expect(laneTitles).toContain(t);
      for (const g of goals) expect([...sections]).toContain(g);
    });

    test(`qa4-14 / 38: the Needs a decision drawer closes on Escape and lists each flag once (${where})`, async ({ page }) => {
      await open(page);
      const btn = page.getByTestId("needs-decision");
      await btn.click();
      const tray = page.getByTestId("decision-tray");
      await expect(tray).toBeVisible();
      // 38: Weekly alert digest's milestone flag is under Other flags only, not again under Broken links.
      const milestoneFlag = /after its milestone/;
      await expect(tray.getByTestId("tray-broken").filter({ hasText: "Weekly alert digest" })).not.toContainText(milestoneFlag);
      await expect(tray.getByText(milestoneFlag)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(tray).toHaveCount(0);
      await expect(btn).toBeFocused();
    });

    test(`qa4-20 / 21 / 22 / 32: the board's words: years, counts, suggested features, names only (${where})`, async ({ page }) => {
      await open(page);
      await page.getByTestId("format-board").click();
      await expect(column(page, "now").getByTestId("column-window")).toHaveText("Oct 1 – Dec 31, 2026");
      await expect(column(page, "later").getByTestId("column-count")).toHaveText("1 item, 1 cut");
      const sugg = page.getByTestId("goal-suggestions-open").first();
      if (await sugg.count()) await expect(sugg).toHaveText(/^✦ \d+ suggested features?$/);
      for (const t of await page.getByTestId("board-looks-like").allTextContents()) expect(t).not.toMatch(/\b[FD]-\d/);
    });

    test(`qa4-42: an item card says Nothing / None for empty links (${where})`, async ({ page }) => {
      await open(page);
      const card = await openCard(page, "setup-checklist");
      await expect(card.getByTestId("card-depends")).toHaveText("Nothing");
    });

    test(`qa4-12: cutting an item nothing depends on offers just Cut it (${where})`, async ({ page }) => {
      await open(page, { scenario: "roadmap-talk" });
      const card = await openCard(page, "alert-digest");
      await expect(card.getByTestId("card-needed")).toHaveText("None");
      if (isPhone(page)) await card.getByRole("tab", { name: "Talk to Oracle" }).click();
      else await card.getByRole("button", { name: "Talk to Oracle" }).click();
      const talk = card.getByTestId("item-talk");
      await talk.getByRole("textbox", { name: "Message Oracle" }).fill("cut it");
      await talk.getByRole("button", { name: "Send" }).click();
      const cut = talk.getByTestId("chat-card").filter({ hasText: "Cut Weekly alert digest" });
      await expect(cut).toBeVisible();
      await expect(cut.getByRole("button", { name: "Cut it, keep the dependents" })).toHaveCount(0);
      await expect(cut.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
    });

    test(`qa4-18 / 37: Key dates says what Add is missing; names wrap (${where})`, async ({ page }) => {
      await open(page, { url: "/simple/roadmap?roadmap=alerts-roadmap" });
      await page.getByTestId("key-dates-open").click();
      const editor = page.getByTestId("key-dates-editor");
      await expect(editor).toBeVisible();
      const add = editor.getByTestId("key-date-add");
      await expect(add.getByTestId("key-date-missing")).toHaveText(/^Needs .*a name and a date$/);
      await add.getByLabel("New key date's name").fill("Partner summit");
      await expect(add.getByTestId("key-date-missing")).toHaveText(/a date$/);
      await expect(add.getByTestId("key-date-missing")).not.toContainText("a name");
      for (const name of await editor.getByTestId("key-date-row").all()) await expect(name.locator("span[title]").first()).not.toHaveClass(/truncate/);
    });

    test(`qa4-43 / 46: the swap message goes once the range changes; filters are named by their word (${where})`, async ({ page }) => {
      await open(page);
      const from = page.getByTestId("filter-from");
      await expect(from).toHaveAccessibleName("From");
      const to = page.getByRole("combobox", { name: "To", exact: true });
      await expect(to).toHaveCount(1);
      const fromOpts = await from.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      const toOpts = await to.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      await to.selectOption(toOpts[0]);
      await from.selectOption(fromOpts[fromOpts.length - 1]);
      const swapped = page.getByRole("status").filter({ hasText: "so they were swapped" });
      await expect(swapped).toBeVisible();
      await from.selectOption("");
      await expect(swapped).toHaveCount(0);
    });
  });
}

test.describe("desktop only", () => {
  test.use(DESKTOP);

  test("qa4-9: the side menu's Roadmap count says what it counts", async ({ page }) => {
    await open(page);
    const count = page.getByTestId("simple-nav-roadmap-count");
    await expect(count).toBeVisible();
    await expect(count).toHaveAttribute("title", /^\d+ (change or draft|changes or drafts) waiting on you$/);
  });

  test("qa4-17: Enter with a title but no roadmap moves focus to the roadmap picker", async ({ page }) => {
    await open(page);
    const title = page.getByLabel("Add an item");
    await title.fill("Example item");
    await title.press("Enter");
    await expect(page.getByTestId("quick-add-error")).toBeVisible();
    await expect(page.getByTestId("quick-add-roadmap")).toBeFocused();
  });

  test("qa4-19 / 23: a span in another year says its years; the cut row says 1st to return", async ({ page }) => {
    await open(page);
    const welcome = page.locator('g[data-testid="bar"][data-item="setup-video"]').first();
    await expect(welcome).toHaveAttribute("aria-label", /Jul 1, 2027 to Oct 30, 2028/);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("return-place").first()).toHaveText("1st to return");
  });

  test("qa4-36: a goal card with one item says 1 item", async ({ page }) => {
    await open(page, { scenario: "simple-plan-lanes", url: "/simple/roadmap?roadmap=onboarding-roadmap" });
    await expect(page.getByTestId("goal-counter").first()).toBeVisible();
    await expect(page.getByTestId("goal-counter").filter({ hasText: /\b1 items\b/ })).toHaveCount(0);
    await expect(page.getByTestId("goal-counter").filter({ hasText: /\b1 item\b/ }).first()).toBeVisible();
  });

  test("qa4-6: in dark mode the estimated hatch and bar outlines are 3:1 against the chart", async ({ page }) => {
    await open(page, { theme: "dark" });
    const v = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      const g = (n: string) => s.getPropertyValue(n).trim();
      return { bg: g("--simple-hatch-bg"), line: g("--simple-hatch-line"), outline: g("--simple-bar-outline"), surface: g("--surface"), paper: g("--simple-paper") };
    });
    expect(contrast(v.line, v.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(v.outline, v.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(v.outline, v.paper)).toBeGreaterThanOrEqual(3);
  });
});

test.describe("phone only", () => {
  test.use(PHONE);

  test("qa4-32 / 33 / 35: the phone lane list shows names only, a plain count and says what is below", async ({ page }) => {
    await open(page, { scenario: "simple-plan-lanes", url: "/simple/roadmap?roadmap=onboarding-roadmap" });
    await expect(page.getByTestId("lane-open-chip")).toHaveText("Listed below");
    const list = page.getByTestId("lane-list");
    await expect(list.getByTestId("lane-list-count")).toHaveText(/^\d+ items?$/);
    for (const t of await list.getByTestId("lane-row").allTextContents()) expect(t).not.toMatch(/\b[FD]-\d/);
  });
});
