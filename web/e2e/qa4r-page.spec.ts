import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap's page (qa4-simple-roadmap-8, -29, -30, -39 and the Needs a
 * decision drawer's Escape), driven as a person does against the mock's invented data: the
 * default scenario and "simple-plan-lanes" (Guided setup's plan on the onboarding roadmap, its
 * PM-owned work beside the Reliability, Growth, ... goals).
 */

const DESKTOP = { viewport: { width: 1512, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, opts: { scenario?: string; url?: string } = {}) {
  const { scenario = "", url = "/simple/roadmap" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await page.emulateMedia({ colorScheme: "light" });
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function format(page: Page, f: "timeline" | "gantt" | "board" | "waterfall") {
  await page.getByTestId(`format-${f}`).click();
  if (f === "board") await expect(page.getByTestId("board")).toBeVisible();
  else await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
}

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const escaped = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const num = (s: string | null) => Number((s ?? "").match(/\d+/)?.[0] ?? NaN);

/** Every legend entry's words in the view on screen. */
const legendWords = async (page: Page): Promise<string[]> => {
  await expect(page.getByTestId("legend").first()).toBeVisible();
  return (await page.getByTestId("legend").locator("> span").allTextContents()).map((t) => t.trim());
};

test.describe("desktop", () => {
  test.use(DESKTOP);

  for (const [name, opts] of [
    ["the default roadmap", {}],
    ["a roadmap with PM-owned work", { scenario: "simple-plan-lanes", url: "/simple/roadmap?roadmap=onboarding-roadmap" }],
  ] as const) {
    test(`qa4-8: a goal's count is the same on its card, the Timeline, the Waterfall and Now / Next / Later (${name})`, async ({ page }) => {
      await open(page, opts);
      const cards = page.getByTestId("goal-counter");
      await expect(cards.first()).toBeVisible();
      const goals: [string, number][] = [];
      for (const c of await cards.all()) goals.push([(await c.locator("p").first().textContent())!.trim(), num(await c.locator("b.tnum").first().textContent())]);
      expect(goals.length).toBeGreaterThan(0);

      // The Timeline's lanes.
      for (const [goal, n] of goals) {
        const lane = page.getByTestId("chart-group").filter({ has: page.locator("b", { hasText: new RegExp(`^${goal}$`) }) });
        await expect(lane, `${goal}'s Timeline lane`).toHaveCount(1);
        expect(num(await lane.getByTestId("lane-count").textContent()), `${goal}: Timeline vs its card`).toBe(n);
      }
      // The Waterfall's lanes.
      await format(page, "waterfall");
      for (const [goal, n] of goals) {
        const lane = page.getByTestId("chart-group").filter({ has: page.locator(`[title="${goal}"]`) });
        await expect(lane, `${goal}'s Waterfall lane`).toHaveCount(1);
        expect(num(await lane.getByTestId("lane-count").textContent()), `${goal}: Waterfall vs its card`).toBe(n);
      }
      // Now / Next / Later: the goal's cards above the line, over the three columns.
      await format(page, "board");
      for (const [goal, n] of goals) {
        const sections = page.getByTestId("board-group").filter({ has: page.locator("h3 span", { hasText: new RegExp(`^${goal}$`) }) });
        expect(await sections.getByTestId("board-card").count(), `${goal}: Now / Next / Later vs its card`).toBe(n);
      }
    });
  }

  test("qa4-29: a mark has one wording in every view's legend", async ({ page }) => {
    await open(page);
    const seen: Record<string, string[]> = {};
    for (const f of ["timeline", "gantt", "board", "waterfall"] as const) {
      await format(page, f);
      seen[f] = await legendWords(page);
    }
    const all = Object.values(seen).flat();
    // Estimated dates: one wording wherever the mark is named, and named in more than one view.
    const estimated = all.filter((t) => /estimated/i.test(t));
    expect(estimated.length).toBeGreaterThan(1);
    for (const t of estimated) expect(t).toBe("Estimated dates");
    // Oracle's dates: the Timeline and the Gantt say the same words.
    const suggestion = "Dates Oracle suggests (? opens them)";
    expect(seen.timeline).toContain(suggestion);
    expect(seen.gantt).toContain(suggestion);
    for (const t of all.filter((x) => /suggest/i.test(x))) expect(t).toBe(suggestion);
    expect(all.join(" | ")).not.toContain("horizon’s window");
  });

  test("qa4-30: an item's warnings are the same on Now / Next / Later, the Timeline and the Gantt", async ({ page }) => {
    await open(page);
    await format(page, "board");
    const card = boardCard(page, "alert-digest");
    await expect(card.getByTestId("board-flag")).toContainText("after its milestone");
    const warnings = [(await card.getByTestId("board-flag").textContent())!.trim(), (await card.getByTestId("board-broken").textContent())!.trim()];
    await format(page, "timeline");
    const pill = bar(page, "alert-digest");
    for (const w of warnings) {
      await expect(pill).toHaveAttribute("aria-label", escaped(w));
      // On hover too, for whoever reads the chart by eye.
      await expect(pill.locator("title", { hasText: w })).not.toHaveCount(0);
    }
    await format(page, "gantt");
    for (const w of warnings) await expect(bar(page, "alert-digest")).toHaveAttribute("aria-label", escaped(w));
  });

  test("qa4-39: a look-alike draft's choices say what happens: Merge into <name>, Keep both", async ({ page }) => {
    await open(page);
    const field = page.getByLabel("Add an item");
    await field.fill("Alert digest for admins");
    await page.getByTestId("quick-add-roadmap").selectOption({ label: "Alerts roadmap" });
    await field.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Added Alert digest for admins as a draft" })).toBeVisible();
    await page.getByTestId("needs-decision").click();
    const twin = page.getByTestId("decision-tray").getByTestId("tray-twin").filter({ hasText: "Alert digest for admins" });
    await expect(twin.getByTestId("looks-like-match").first()).toContainText("Looks like Weekly alert digest");
    await expect(twin.getByRole("button", { name: "Keep both", exact: true })).toBeVisible();
    await twin.getByRole("button", { name: "Merge into Weekly alert digest", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Merged 'Alert digest for admins' into Weekly alert digest" })).toBeVisible();
  });
});

for (const [where, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(size);

    test(`qa4: Escape in a dialog over the Needs a decision drawer leaves the drawer open (${where})`, async ({ page }) => {
      await open(page);
      await page.getByTestId("needs-decision").click();
      const tray = page.getByTestId("decision-tray");
      await expect(tray).toBeVisible();
      const suggestion = tray.getByTestId("tray-suggested").getByTestId("goal-suggestion").first();
      await suggestion.scrollIntoViewIfNeeded();
      await suggestion.getByRole("button", { name: "Reject", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Reject / });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Why (optional)")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(tray).toBeVisible();
      // Escape on the drawer itself still closes it.
      await tray.getByRole("button", { name: "Close" }).focus();
      await page.keyboard.press("Escape");
      await expect(tray).toHaveCount(0);
    });
  });
}
