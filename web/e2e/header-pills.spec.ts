import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * The PRD header and the Runs table beside the 400 px Ask panel (found after train R): with the
 * panel docked on a 1512 px window the PRD header's action buttons squeezed its template and
 * theme pills, whose text wrapped inside their 26 px height and ran over the next pill, and
 * /runs cut its rows' buttons off at the table's right edge. Checked at 1512 and 1280 px, with
 * the panel open and closed, as a person opens it: the Ask strip. The PRD has a title as long as
 * real ones are (the mock's "long-title" scenario): the mock's short title left the old header
 * room enough that its squeezed pills stacked in a column without any pill's text wrapping.
 * /runs is swept from 1280 to 1600 px in 10 px steps (#711's review: the window's width does
 * not tell how much room the table has beside the panel).
 *
 * Cards: PRD header: protects=each pill keeps its text on one line at its 26 px height, and the
 * status row drops to its own line when the actions leave no room, its chip and pills on one row;
 * fails_when=a pill wraps, grows, overlaps the title, another pill or a button, or the pills
 * stack in a narrow column; no_claim=the order of the actions.
 * Runs table: protects=every row's button is fully visible inside the table and the window at
 * every width, and with the panel closed the inspector stays beside the table; fails_when=the
 * last column is cut off, or the closed-panel layout moves the inspector below; no_claim=which
 * columns a narrow table drops, where the inspector sits with the panel open.
 */

const SIZES = [
  { width: 1512, height: 806 },
  { width: 1280, height: 806 },
];

async function setPanel(page: Page, open: boolean) {
  const dock = page.getByTestId("hop-dock");
  await expect(dock).toBeVisible();
  // The strip opens it; open, the panel's own Close closes it (qa-shell-13: the drawer lies over the strip).
  if ((await dock.getAttribute("data-open")) !== String(open)) {
    if (open) await page.getByTestId("hop-strip").click();
    else await page.getByTestId("hop-panel").filter({ visible: true }).getByRole("button", { name: "Close Ask Oracle" }).click();
  }
  await expect(dock).toHaveAttribute("data-open", String(open));
  if (open) await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible();
}

type Box = { name: string; x: number; y: number; width: number; height: number };

/** The header's own boxes: the title, each status chip or pill and each action. */
async function headerBoxes(page: Page): Promise<Box[]> {
  return page.locator("main [data-page-header]").first().evaluate((h) => {
    const items = [h.querySelector("h1"), ...Array.from(h.children).filter((c) => c.tagName === "DIV").flatMap((c) => Array.from(c.children))];
    return items
      .filter((e): e is Element => !!e)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { name: (e.textContent ?? "").trim().slice(0, 40), x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .filter((b) => b.width > 0 && b.height > 0);
  });
}

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

/** The pill's top and height, and the height of its text's lines (one line: under 26 px). */
async function pillMetrics(page: Page, testId: string, text: RegExp) {
  // qa-docs: the pills name the template and theme ("Template: Goal-traced PRD"), not their keys.
  const pill = page.locator("main [data-page-header]").getByTestId(testId);
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText(text);
  return pill.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top)));
    const box = el.getBoundingClientRect();
    return { top: box.top, height: box.height, lines: tops.size, textHeight: range.getBoundingClientRect().height };
  });
}

/** An invented PRD title as long as real ones are (the "long-title" scenario's). */
const LONG_TITLE = "Saved carts for returning buyers PRD";

for (const size of SIZES) {
  for (const open of [true, false]) {
    const where = `${size.width}x${size.height}, Ask panel ${open ? "open" : "closed"}`;

    // PRD header card.
    test(`PRD header at ${where}: the template and theme pills stay on one line and nothing overlaps`, async ({ page }) => {
      await page.addInitScript(([key]) => localStorage.setItem(key, "long-title"), [MOCK_SCENARIO_KEY] as const);
      await page.setViewportSize(size);
      await login(page);
      await page.goto("/documents/saved-carts");
      await expect(page.getByRole("heading", { level: 1, name: LONG_TITLE })).toBeVisible();
      await expect(page.getByRole("link", { name: "Composition" })).toBeVisible();
      // Review settings arrives with the section states, after the document: measure the
      // header only once every action is in it, or a late button moves what was measured.
      await expect(page.getByRole("button", { name: "Review settings" })).toBeVisible();
      await setPanel(page, open);

      const tops: number[] = [];
      for (const [testId, text] of [
        ["doc-template", /^Template: \S/],
        ["doc-theme", /^Theme: \S/],
      ] as const) {
        const m = await pillMetrics(page, testId, text);
        expect(m.height, `${testId} height`).toBe(26);
        expect(m.lines, `${testId} lines`).toBe(1);
        expect(m.textHeight, `${testId} text height`).toBeLessThan(26);
        tops.push(m.top);
      }
      // The status chip and both pills share one row (beside the title or wrapped below it as
      // a group), never a column of pills squeezed beside the title.
      const status = (await page.locator("main [data-page-header] [data-status]").first().boundingBox())!;
      const chipMiddle = status.y + status.height / 2;
      for (const top of tops) {
        expect(Math.abs(top - tops[0]!), "the pills' tops").toBeLessThanOrEqual(2);
        expect(Math.abs(top + 13 - chipMiddle), "the pills' middles and the status chip's").toBeLessThanOrEqual(2);
      }
      const boxes = await headerBoxes(page);
      expect(boxes.length).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          expect(overlaps(boxes[i]!, boxes[j]!), `"${boxes[i]!.name}" overlaps "${boxes[j]!.name}"`).toBe(false);
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  }
}

// Runs table card: every 10 px from 1280 to 1600, with the panel open and closed.
const WIDTHS = Array.from({ length: 33 }, (_, i) => 1280 + i * 10);

for (const open of [true, false]) {
  test(`/runs from 1280 to 1600 px, Ask panel ${open ? "open" : "closed"}: every row's button is inside the table and the window`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1512, height: 806 });
    await login(page);
    await page.goto("/runs");
    await setPanel(page, open);
    const table = page.getByTestId("runs-table");
    const buttons = table.getByTestId("run-row").getByRole("button");
    const inspector = page.getByRole("complementary", { name: "Run", exact: true });
    await expect(buttons.first()).toBeVisible();
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 806 });
      await expect(page.getByTestId("hop-dock")).toHaveAttribute("data-open", String(open));
      const t = (await table.boundingBox())!;
      const panel = open ? (await page.getByTestId("hop-dock").boundingBox())! : null;
      for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        await expect(b, `button ${i} at ${width} px`).toBeInViewport({ ratio: 1 });
        const box = (await b.boundingBox())!;
        expect(box.x, `button ${i} left edge at ${width} px`).toBeGreaterThanOrEqual(t.x);
        expect(box.x + box.width, `button ${i} right edge at ${width} px`).toBeLessThanOrEqual(t.x + t.width);
        if (panel) expect(box.x + box.width, `button ${i} under the panel at ${width} px`).toBeLessThanOrEqual(panel.x);
      }
      // The panel-closed layout is as it was before #711: the inspector beside the table
      // on any window over 1100 px.
      if (!open) {
        const ins = (await inspector.boundingBox())!;
        expect(ins.x, `the inspector beside the table at ${width} px`).toBeGreaterThanOrEqual(t.x + t.width);
      }
    }
  });
}
