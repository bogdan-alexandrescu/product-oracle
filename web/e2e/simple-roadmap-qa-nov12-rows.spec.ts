import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-roadmap.md), the chart rows and exports lane,
 * driven as a person does against the mock's invented data (mock clock: Oct 22, 2026):
 * #1 every format's rows, cards and labels name a feature by its code and name ("F-06 Weekly alert
 * digest"); #2 an item with no Ground Truth code (Alert rules engine) is flagged "Not in the Ground
 * Truth" on its row and card; #4 the Today pill leaves when today scrolls out of the Timeline's view;
 * #5 the Gantt names its track milestones by their roadmap code ("M1 Beta"); #14 the board's key
 * keeps its how-to-move sentence behind an (i); and the board's export carries the same words.
 */

declare global {
  interface Window {
    __exportSvgs?: string[];
  }
}

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DIGEST = /^F-06 Weekly alert digest$/;
const NOT_IN_GT = "Not in the Ground Truth";

type Format = "timeline" | "gantt" | "waterfall" | "board";

async function open(page: Page, format: Format) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

/** A Gantt or Waterfall name-column row, by the item's name. */
const chartLabel = (page: Page, name: string): Locator =>
  page.getByTestId("chart-label").filter({ has: page.getByTestId("label-title").filter({ hasText: name }) });
const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("the Timeline's rows read code and name, and flag an item with no code", async ({ page }) => {
    // protects: QA Nov 12 #1/#2 on the Timeline: Weekly alert digest's row reads "F-06 Weekly alert digest"; Alert rules engine's row carries "Not in the Ground Truth", the coded row does not
    // fails_when: a row shows the name alone, or the uncoded item has no mark, or a coded one has it
    // no_claim: the phone's quarter list; how the mark looks
    await open(page, "timeline");
    const digest = page.locator('[data-testid="timeline-row"][data-item="alert-digest"]').first();
    await digest.scrollIntoViewIfNeeded();
    await expect(digest.getByTestId("timeline-row-name")).toHaveText(DIGEST);
    await expect(digest.getByTestId("not-in-gt")).toHaveCount(0);
    const rules = page.locator('[data-testid="timeline-row"][data-item="alert-rules"]').first();
    await rules.scrollIntoViewIfNeeded();
    await expect(rules.getByTestId("timeline-row-name")).toHaveText(/^Alert rules engine/);
    await expect(rules.getByTestId("not-in-gt")).toBeVisible();
    await expect(rules.getByTestId("not-in-gt")).toHaveText(NOT_IN_GT);
  });

  test("the Today pill leaves when today scrolls out of the 3 months' view", async ({ page }) => {
    // protects: QA Nov 12 #4: with the 3-month Timeline scrolled past today, no Today pill sits over the names column; Back to today brings it back right of the names
    // fails_when: the pill stays (clamped over the names) once today's line is out of view, or does not come back
    // no_claim: 6 months, 1 year, All 3 years
    await open(page, "timeline");
    await page.getByTestId("zoom-3m").click();
    const pill = page.getByTestId("today-pill");
    await expect(pill).toBeVisible();
    await page.getByTestId("timeline-scroll").evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect(pill).toHaveCount(0);
    await page.getByRole("button", { name: "Back to today" }).click();
    await expect(pill).toBeVisible();
    const names = (await page.getByTestId("timeline-names-head").boundingBox())!;
    const box = (await pill.boundingBox())!;
    expect(box.x, "the pill sits right of the names column").toBeGreaterThanOrEqual(names.x + names.width);
  });

  test("the Gantt and Waterfall name column reads code and name, and flags an item with no code", async ({ page }) => {
    // protects: QA Nov 12 #1/#2 on the Gantt and the Waterfall: the label reads "F-06 Weekly alert digest"; Alert rules engine's label carries "Not in the Ground Truth"
    // fails_when: a label shows the name alone, or the uncoded item has no mark
    // no_claim: the phone's narrower column
    await open(page, "gantt");
    for (const format of ["gantt", "waterfall"] as const) {
      await page.getByTestId(`format-${format}`).click();
      await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
      await expect(chartLabel(page, "Weekly alert digest").getByTestId("label-title"), format).toHaveText(DIGEST);
      await expect(chartLabel(page, "Weekly alert digest").getByTestId("not-in-gt"), format).toHaveCount(0);
      await expect(chartLabel(page, "Alert rules engine").getByTestId("not-in-gt"), format).toBeVisible();
    }
  });

  test("the Gantt names its track milestones by their roadmap code", async ({ page }) => {
    // protects: QA Nov 12 #5 (Gantt part): each axis milestone's label and, grouped by Milestone, a track milestone's lane read its M code before the name ("M1 Beta")
    // fails_when: a label or a lane reads the milestone's name alone ("Beta", "Beta (Nov 30)")
    // no_claim: the panel's Milestone row, the Removed list (other lanes)
    await open(page, "gantt");
    const labels = page.getByTestId("track-milestone-label");
    await expect(labels.first()).toBeAttached();
    for (const t of await labels.allTextContents()) expect(t).toMatch(/^M\d+ \S/);
    await page.getByTestId("group-milestone").click();
    await expect(page.getByTestId("group-milestone")).toHaveAttribute("aria-pressed", "true");
    const lanes = page.getByTestId("chart-group");
    await expect(lanes.filter({ hasText: /Beta \(/ }).first()).toBeVisible();
    for (const t of await lanes.allTextContents()) expect(t.trim(), "a milestone lane leads with its code").not.toMatch(/^Beta \(/);
    await expect(lanes.filter({ hasText: /M\d+ Beta \([A-Z][a-z]{2} \d{1,2}\)/ }).first()).toBeVisible();
  });

  test("the board's cards and its PNG read code and name, and flag an item with no code", async ({ page }) => {
    // protects: QA Nov 12 #1/#2 on the board and its export: the card reads "F-06 Weekly alert digest", Alert rules engine's card carries "Not in the Ground Truth"; the exported picture names the card "F-06 Weekly alert digest" and flags Alert rules engine
    // fails_when: a card or the export shows the name alone, or the uncoded item is not flagged
    // no_claim: the PDF's pages; the Timeline's and Gantt's exports
    await page.context().addInitScript(() => {
      const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        ...d,
        set(v: string) {
          const src = String(v);
          if (src.startsWith("data:image/svg+xml")) (window.__exportSvgs ??= []).push(decodeURIComponent(src.slice(src.indexOf(",") + 1)));
          d.set!.call(this, v);
        },
      });
    });
    await open(page, "board");
    await expect(boardCard(page, "alert-digest").getByTestId("board-card-name")).toHaveText(DIGEST);
    await expect(boardCard(page, "alert-digest").getByTestId("not-in-gt")).toHaveCount(0);
    await expect(boardCard(page, "alert-rules").getByTestId("not-in-gt")).toBeVisible();
    await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Export PNG" }).click()]);
    const svgs = await page.evaluate(() => window.__exportSvgs ?? []);
    expect(svgs.length).toBeGreaterThan(0);
    const texts = await page.evaluate(
      (markup) => [...new DOMParser().parseFromString(markup, "image/svg+xml").querySelectorAll("text")].map((t) => (t.textContent ?? "").trim()),
      svgs[svgs.length - 1],
    );
    expect(texts).toContain("F-06 Weekly alert digest");
    expect(texts).not.toContain("Weekly alert digest");
    const rules = texts.findIndex((t) => t.startsWith("Alert rules engine"));
    expect(rules, "Alert rules engine is in the picture").toBeGreaterThanOrEqual(0);
    expect(`${texts[rules]} ${texts[rules + 1] ?? ""}`, "and flagged on its card").toContain(NOT_IN_GT);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the board's key keeps how to move a card behind an (i)", async ({ page }) => {
    // protects: QA Nov 12 #14 (_board.tsx half): on a phone the board's key shows no "Drag a card…" sentence; its words sit behind an (i) that opens them
    // fails_when: the sentence shows as prose under the board, or the (i) does not open it
    // no_claim: the Waterfall's key (its Phases line is _roadmap.tsx's)
    await open(page, "board");
    const key = page.getByTestId("legend");
    await expect(key).toBeVisible();
    await expect(key.getByText(/Drag a card to another column/)).toBeHidden();
    const tip = key.getByTestId("board-drag-tip");
    await expect(tip).toBeVisible();
    await tip.click();
    await expect(page.getByText(/Drag a card to another column \(press and hold first\) to move its dates there/)).toBeVisible();
  });
});
