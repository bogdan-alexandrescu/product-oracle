import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-roadmap.md #6), driven as a person does
 * against the mock's invented data (mock clock: Oct 22, 2026): an item with only Oracle's
 * estimate (Health log, no dates of its own) reads one way everywhere it is shown: "No dates
 * yet · estimated Apr 1, 2027 – Oct 22, 2028", on the Timeline at every zoom, the Gantt, the
 * Waterfall, the board, the Needs a decision tray and the exports. Dates read month first.
 */

declare global {
  interface Window {
    __exportSvgs?: string[];
  }
}

const WORDS = "No dates yet · estimated Apr 1, 2027 – Oct 22, 2028";
const KEY = "setup-health-log";

async function open(page: Page, format: "timeline" | "gantt" | "waterfall" | "board") {
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
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

/** The words of the last exported picture, joined one per line. */
async function exported(page: Page): Promise<string> {
  await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Export PNG" }).click()]);
  const svgs = await page.evaluate(() => window.__exportSvgs ?? []);
  expect(svgs.length).toBeGreaterThan(0);
  const texts = await page.evaluate(
    (markup) => [...new DOMParser().parseFromString(markup, "image/svg+xml").querySelectorAll("text")].map((t) => (t.textContent ?? "").trim()),
    svgs[svgs.length - 1],
  );
  return texts.join("\n");
}

test.use({ viewport: { width: 1440, height: 900 } });

test("#6: an item with only Oracle's estimate reads the same on the Timeline at every zoom and in its export", async ({ page }) => {
  // protects: Health log's row on the Timeline reads "No dates yet · estimated Apr 1, 2027 – Oct 22, 2028" at 3 months, 6 months, 1 year and All 3 years, and the Timeline's PNG says the same
  // fails_when: a zoom shows the span alone, "No dates yet" alone, or the export shows the span alone
  test.setTimeout(120_000);
  await open(page, "timeline");
  const row = page.locator(`[data-testid="timeline-row"][data-item="${KEY}"]`);
  for (const z of ["3m", "6m", "1y", "all"]) {
    await page.getByTestId(`zoom-${z}`).click();
    await expect(page.getByTestId(`zoom-${z}`)).toHaveAttribute("aria-pressed", "true");
    await expect(row.getByText(WORDS, { exact: true }), `at ${z}`).toHaveCount(1);
    await expect(row.getByText("No dates yet", { exact: true }), `at ${z}`).toHaveCount(0);
  }
  await row.scrollIntoViewIfNeeded();
  expect(await exported(page)).toContain(WORDS);
});

test("#6: the Gantt and the Waterfall say the same on the item's bar", async ({ page }) => {
  // protects: Health log's bar on the Gantt and the Waterfall is named "… No dates yet · estimated Apr 1, 2027 – Oct 22, 2028"
  // fails_when: the bar's words give the span with no "No dates yet"
  await open(page, "gantt");
  await expect(page.locator(`[data-testid="bar"][data-item="${KEY}"]`).first()).toHaveAttribute("aria-label", new RegExp(`Health log: ${WORDS}`));
  await page.getByTestId("format-waterfall").click();
  await expect(page.getByTestId("format-waterfall")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-testid="bar"][data-item="${KEY}"]`).first()).toHaveAttribute("aria-label", new RegExp(`Health log: ${WORDS}`));
});

test("#6: the board's card and its export say the same", async ({ page }) => {
  // protects: Health log's board card reads "No dates yet · estimated Apr 1, 2027 – Oct 22, 2028", never "No dates"; the board's PNG says the same
  // fails_when: the card reads "No dates" or the export gives the span alone
  test.setTimeout(90_000);
  await open(page, "board");
  await expect(page.locator(`[data-testid="board-card"][data-item="${KEY}"]`).getByTestId("board-dates")).toHaveText(WORDS);
  expect(await exported(page)).toContain(WORDS);
});

test("#6: the Needs a decision tray names the item's estimate the same way beside Oracle's dates", async ({ page }) => {
  // protects: in the tray's Dates to confirm, Health log's line reads "No dates yet · estimated Apr 1, 2027 – Oct 22, 2028" with Oracle's suggested dates after it
  // fails_when: the line gives Oracle's suggestion alone, as if it were the item's dates
  await open(page, "timeline");
  await page.getByTestId("needs-decision").click();
  const line = page.getByTestId("decision-tray").getByTestId("tray-date").filter({ hasText: "Health log" });
  await expect(line).toContainText(WORDS);
  await expect(line).toContainText(/Oracle suggests [A-Z][a-z]{2} \d{1,2}/);
});
