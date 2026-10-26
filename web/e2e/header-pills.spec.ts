import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * The PRD header and the Runs table beside the 400 px Ask panel (found after train R): with the
 * panel docked on a 1512 px window the PRD header's action buttons squeezed its template and
 * theme pills, whose text wrapped inside their 26 px height and ran over the next pill, and
 * /runs cut its rows' buttons off at the table's right edge. Checked at 1512 and 1280 px, with
 * the panel open and closed, as a person opens it: the Ask strip.
 *
 * Cards: PRD header: protects=each pill keeps its text on one line at its 26 px height, and the
 * status row drops to its own line when the actions leave no room; fails_when=a pill wraps,
 * grows or overlaps the title, another pill or a button; no_claim=the order of the actions.
 * Runs table: protects=every row's button is fully visible inside the table and the window;
 * fails_when=the last column is cut off; no_claim=which columns a narrow table drops.
 */

const SIZES = [
  { width: 1512, height: 806 },
  { width: 1280, height: 806 },
];

async function setPanel(page: Page, open: boolean) {
  const dock = page.getByTestId("hop-dock");
  await expect(dock).toBeVisible();
  if ((await dock.getAttribute("data-open")) !== String(open)) await page.getByTestId("hop-strip").click();
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

/** The pill's height and the height of its text's lines (one line: under 26 px). */
async function pillMetrics(page: Page, text: string) {
  const pill = page.locator("main [data-page-header]").getByText(text, { exact: true });
  await expect(pill).toBeVisible();
  return pill.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top)));
    return { height: el.getBoundingClientRect().height, lines: tops.size, textHeight: range.getBoundingClientRect().height };
  });
}

for (const size of SIZES) {
  for (const open of [true, false]) {
    const where = `${size.width}x${size.height}, Ask panel ${open ? "open" : "closed"}`;

    // PRD header card.
    test(`PRD header at ${where}: the template and theme pills stay on one line and nothing overlaps`, async ({ page }) => {
      await page.setViewportSize(size);
      await login(page);
      await page.goto("/documents/saved-carts");
      await expect(page.getByRole("heading", { level: 1, name: /Saved carts PRD/ })).toBeVisible();
      await expect(page.getByRole("link", { name: "Composition" })).toBeVisible();
      await setPanel(page, open);

      for (const text of ["template oracle-default v2", "theme clean-document"]) {
        const m = await pillMetrics(page, text);
        expect(m.height, `${text} height`).toBe(26);
        expect(m.lines, `${text} lines`).toBe(1);
        expect(m.textHeight, `${text} text height`).toBeLessThan(26);
      }
      const boxes = await headerBoxes(page);
      expect(boxes.length).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          expect(overlaps(boxes[i]!, boxes[j]!), `"${boxes[i]!.name}" overlaps "${boxes[j]!.name}"`).toBe(false);
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scroll).toBeLessThanOrEqual(inner);
    });

    // Runs table card.
    test(`/runs at ${where}: every row's button is inside the table and the window`, async ({ page }) => {
      await page.setViewportSize(size);
      await login(page);
      await page.goto("/runs");
      await setPanel(page, open);
      const table = page.getByTestId("runs-table");
      const buttons = table.getByTestId("run-row").getByRole("button");
      await expect(buttons.first()).toBeVisible();
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      const t = (await table.boundingBox())!;
      const panel = open ? (await page.getByTestId("hop-dock").boundingBox())! : null;
      for (let i = 0; i < count; i++) {
        const b = buttons.nth(i);
        await expect(b).toBeInViewport({ ratio: 1 });
        const box = (await b.boundingBox())!;
        expect(box.x + box.width, `button ${i} right edge`).toBeLessThanOrEqual(t.x + t.width);
        if (panel) expect(box.x + box.width, `button ${i} under the panel`).toBeLessThanOrEqual(panel.x);
      }
    });
  }
}
