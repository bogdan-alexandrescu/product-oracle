import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 14, 2026, Simple Roadmap, driven as a person does against the mock's invented
 * data (mock clock: Oct 22, 2026):
 * #1 the Timeline's row names are whole, the "Not in the Ground Truth" tag cut instead;
 * #2 key dates show on the Timeline (with a key entry) and on Now / Next / Later;
 * #3 Now / Next / Later shows the track milestone its cards are measured against (M1 Beta);
 * #4 no red "Ends after" pill on a cut item or an item with no dates yet;
 * #5 a phone's Gantt and Waterfall keep the tag inside the label column, "1st to return" on its own line;
 * #6 a milestone's tooltip never reads "? → ?";
 * #7 under a filter the Needs-a-decision tiles count what the list shows ("1 of 17");
 * #8 a goal card does not repeat its title as its measure;
 * #9 at All 3 years the Today pill and a milestone label do not overlap;
 * and a track band names its goal (the seed ties the Usage alerts track to Reliability).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const NOT_IN_GT = "Not in the Ground Truth";

type Format = "timeline" | "gantt" | "waterfall" | "board";

async function open(page: Page, format: Format) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

const row = (page: Page, key: string): Locator => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`).first();

/** The red "Ends after" pills whose middle lies within the row's height. */
async function latePillsOn(page: Page, target: Locator): Promise<string[]> {
  const box = (await target.boundingBox())!;
  return page.$$eval(
    '[data-testid="ms-late"]',
    (els, [top, bottom]) =>
      els.flatMap((e) => {
        const r = e.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        return mid >= top && mid <= bottom ? [e.textContent ?? ""] : [];
      }),
    [box.y, box.y + box.height],
  );
}

const overlap = (a: { x: number; width: number; y: number; height: number }, b: { x: number; width: number; y: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("the Timeline's names are whole; the tag is cut instead (#1)", async ({ page }) => {
    // protects: QA Nov 14 #1: every Timeline row's name shows whole, "Team invite nudges" too; its tag keeps its words in its title
    // fails_when: a name is cut to "Te…" while the "Not in the Ground Truth" tag stays whole
    await open(page, "timeline");
    await expect(row(page, "setup-ideas")).toBeVisible();
    const cut = await page.$$eval('[data-testid="timeline-row-name"]', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    expect(cut).toEqual([]);
    await expect(row(page, "setup-ideas").getByTestId("timeline-row-name")).toHaveText("Team invite nudges");
    await expect(row(page, "setup-ideas").getByTestId("not-in-gt")).toHaveAttribute("title", NOT_IN_GT);
  });

  test("a key date added from the Roadmap shows on the Timeline and on Now / Next / Later (#2)", async ({ page }) => {
    // protects: QA Nov 14 #2: the Timeline draws the key dates (an added one too) and its key names them; the board's column holding the day shows it
    // fails_when: a key date shows only on the Gantt and Waterfall
    await open(page, "timeline");
    await page.getByTestId("key-dates-open").click();
    const editor = page.getByTestId("key-dates-editor");
    await editor.getByLabel("New key date's name").fill("Example partner demo");
    await editor.getByLabel("New key date's day").fill("2026-12-03");
    await editor.getByTestId("key-date-add-roadmap").selectOption({ label: "Alerts roadmap" });
    await editor.getByRole("button", { name: "Add", exact: true }).click();
    await expect(editor.locator('[data-testid="key-date-row"][data-name="Example partner demo"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    for (const name of ["Customer conference", "Example partner demo"])
      await expect(page.locator(`[data-testid="key-date-marker"][data-name="${name}"]`)).toHaveCount(1);
    await expect(page.locator('[data-testid="key-date-marker"][data-name="Example partner demo"] [data-testid="key-date-label"]')).toHaveAttribute("title", /^Example partner demo · Dec 3/);
    await expect(page.getByTestId("timeline-key").locator('[data-key="key"]')).toHaveText("Key date");

    await page.getByTestId("format-board").click();
    const now = page.getByTestId("ms-board-row").first();
    await expect(now.locator('[data-testid="ms-board-key"][data-name="Example partner demo"]')).toHaveText("Example partner demo · Dec 3");
    await expect(now.locator('[data-testid="ms-board-key"][data-name="Customer conference"]')).toHaveCount(1);
  });

  test("Now / Next / Later shows the track milestone its cards are measured against (#3)", async ({ page }) => {
    // protects: QA Nov 14 #3: the Now column has "M1 Beta · Nov 30", the milestone F-06's red flag names
    // fails_when: the Now column shows only the goal milestones, so M1 Beta is nowhere on the page
    await open(page, "board");
    const now = page.getByTestId("ms-board-row").first();
    await expect(now.getByTestId("ms-board-track")).toHaveText(["M1 Beta · Nov 30"]);
  });

  test("no red late pill on a cut item or one with no dates yet (#4)", async ({ page }) => {
    // protects: QA Nov 14 #4: In-app tour (cut) and Team invite nudges (no dates yet) carry no "Ends after M…" pill on the Timeline or the Waterfall
    // fails_when: either row has the red pill
    await open(page, "timeline");
    for (const key of ["setup-tour", "setup-ideas"]) {
      await row(page, key).scrollIntoViewIfNeeded();
      expect(await latePillsOn(page, row(page, key))).toEqual([]);
    }
    await page.getByTestId("format-waterfall").click();
    for (const key of ["setup-tour", "setup-ideas"]) {
      const label = page.locator(`[data-testid="chart-label"][data-item-id]`).filter({ has: page.getByTestId("label-title").filter({ hasText: key === "setup-tour" ? "In-app tour" : "Team invite nudges" }) });
      await label.scrollIntoViewIfNeeded();
      expect(await latePillsOn(page, label)).toEqual([]);
    }
  });

  test("a milestone's tooltip leaves out the ends it does not know (#6)", async ({ page }) => {
    // protects: QA Nov 14 #6: hovering M3 Grow retention on the Waterfall shows its measure without "? → ?"
    // fails_when: the tooltip reads "…: ? → ? (now 61)"
    await open(page, "waterfall");
    const label = page.getByTestId("ms-label").filter({ hasText: "M3 Grow retention" }).first();
    await label.scrollIntoViewIfNeeded();
    await label.hover();
    const done = page.getByTestId("ms-tip-done");
    await expect(done).toBeVisible();
    await expect(done).not.toContainText("?");
  });

  test("under a Goal filter the tiles count what the list shows (#7)", async ({ page }) => {
    // protects: QA Nov 14 #7: with Goal = Grow retention, the Dates to confirm tile reads "N of M", N the rows listed under it
    // fails_when: the tile counts every roadmap's dates while the list below is filtered
    await open(page, "timeline");
    await page.getByRole("combobox", { name: "Goal", exact: true }).selectOption({ label: "Grow retention" });
    await page.getByTestId("needs-decision").click();
    const tray = page.getByTestId("decision-tray");
    await expect(tray).toBeVisible();
    const shown = await tray.getByTestId("tray-date").count();
    const tile = tray.getByTestId("tray-counter").filter({ hasText: "Dates to confirm" });
    await expect(tile).toHaveText(new RegExp(`^${shown}( of \\d+)?\\s*Dates to confirm$`));
  });

  test("a goal card does not repeat its title as its measure (#8)", async ({ page }) => {
    // protects: QA Nov 14 #8: no goal card's measure line is its title again
    // fails_when: "Sign-ups per rep per day / sign-ups per rep per day"
    await open(page, "timeline");
    const cards = page.getByTestId("goal-counter");
    await expect(cards.first()).toBeVisible();
    const same = await cards.evaluateAll((els) =>
      els.filter((e) => {
        const t = e.querySelector("[data-testid=goal-counter-title]")?.textContent?.replace(/^\d+\s*/, "").trim().toLowerCase() ?? e.querySelector("p")?.textContent?.trim().toLowerCase();
        const m = e.querySelector("[data-testid=goal-counter-metric]")?.textContent?.trim().toLowerCase();
        return !!m && !!t && t.endsWith(m);
      }).length,
    );
    expect(same).toBe(0);
  });

  test("at All 3 years the Today pill and the milestone labels do not overlap (#9)", async ({ page }) => {
    // protects: QA Nov 14 #9: the Today pill keeps off every milestone label on the date axis
    // fails_when: the pill sits over M1 Beta's label ("Today M1 Beta")
    // The QA's day, Nov 14, when today is close to M1 Beta's day.
    await page.clock.setSystemTime(new Date("2026-11-14T18:00:00Z"));
    await open(page, "timeline");
    await page.getByTestId("zoom-all").click();
    await expect(page.getByTestId("zoom-all")).toHaveAttribute("aria-pressed", "true");
    const pill = (await page.getByTestId("today-pill").boundingBox())!;
    for (const l of await page.getByTestId("timeline-milestone").all()) expect(overlap(pill, (await l.boundingBox())!)).toBe(false);
    for (const l of await page.getByTestId("key-date-label").all()) expect(overlap(pill, (await l.boundingBox())!)).toBe(false);
  });

  test("a track band names its goal", async ({ page }) => {
    // protects: QA Nov 14 missing feature: the seed's Usage alerts track serves Reliability, as the API's goal_name reads; its Gantt band header shows it
    // fails_when: no track band names a goal
    await open(page, "gantt");
    await expect(page.getByTestId("chart-labels")).toContainText("Reliability");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the Gantt and Waterfall keep the tag in the label column, the return place on its own line (#5)", async ({ page }) => {
    // protects: QA Nov 14 #5: each "Not in the Ground Truth" tag ends inside the label column (whole in its title); "1st to return" sits under its name
    // fails_when: a tag runs past the column's edge, or the return place squeezes the name and tag beside it
    await open(page, "gantt");
    for (const f of ["gantt", "waterfall"] as const) {
      await page.getByTestId(`format-${f}`).click();
      const col = (await page.getByTestId("chart-labels").boundingBox())!;
      const tags = page.getByTestId("chart-labels").getByTestId("not-in-gt");
      expect(await tags.count()).toBeGreaterThan(0);
      for (const t of await tags.all()) {
        const b = (await t.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(col.x + col.width + 0.5);
        await expect(t).toHaveAttribute("title", NOT_IN_GT);
      }
      const back = page.getByTestId("chart-label").filter({ has: page.getByTestId("return-place") }).first();
      const name = (await back.getByTestId("label-title").boundingBox())!;
      const place = (await back.getByTestId("return-place").boundingBox())!;
      expect(place.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
    }
  });
});
