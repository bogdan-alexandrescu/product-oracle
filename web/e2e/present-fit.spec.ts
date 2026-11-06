import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// Visual QA pass E, review round 2 (PR 1300): in Present mode of Saved carts v2 a date never
// wraps between its parts ("Nov 15," on one line and "2026." on the next), at 1440 and at
// 390; at 390 the items table keeps its last column on the slide; a section that is one
// paragraph longer than a slide goes on continuation slides, every sentence once, none
// clipped (the mock's "long-paragraph" scenario).

const SLIDE = "/documents/saved-carts/v/2/present";
const current = (page: Page) => page.getByTestId("audience-view").locator(".current-slide");

/** The line boxes each match of ``date`` (spaces or no-break spaces between its parts) takes. */
async function lineBoxes(slide: Locator, date: string): Promise<number[]> {
  return slide.evaluate((host, date) => {
    const root: Node = (host as HTMLElement).shadowRoot ?? host;
    const re = new RegExp(date.replace(/ /g, "[ \\u00a0]"), "g");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out: number[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (const m of (n.textContent ?? "").matchAll(re)) {
        const range = document.createRange();
        range.setStart(n, m.index!);
        range.setEnd(n, m.index! + m[0].length);
        const tops = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        out.push(tops.size);
      }
    }
    return out;
  }, date);
}

/** The slide's own text, with its no-break spaces kept (innerText would keep them too). */
const rawText = (slide: Locator) =>
  slide.evaluate((host) => ((host as HTMLElement).shadowRoot ?? host).textContent ?? "");

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`at ${viewport.width}`, () => {
    test.use({ viewport });

    test("E-11: each date on a slide and in its footer is one line box", async ({ page }) => {
      await login(page);
      await page.goto(`${SLIDE}?slide=9`);
      await expect(page.getByTestId("slide-counter")).toHaveText("9 / 10");
      const slide = current(page);
      await expect(slide.locator(".slide-title")).toHaveText("Decisions needed");
      const text = await rawText(slide);
      // No-break spaces join a date's parts, in the body and in the footer's banner.
      expect(text).toContain("needed by Nov 1, 2026");
      expect(text).toContain("needed by Nov 15, 2026");
      expect(text).toMatch(/Imported [A-Z][a-z]{2} \d{1,2}, 2026/);
      for (const date of ["Nov 1, 2026", "Nov 15, 2026", "Oct 18, 2026"]) {
        const boxes = await lineBoxes(slide, date);
        expect(boxes.length, date).toBeGreaterThan(0);
        expect(boxes, date).toEqual(boxes.map(() => 1));
      }
    });
  });
}

test.describe("at 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the items table keeps its Outcome column on the slide", async ({ page }) => {
    await login(page);
    await page.goto(`${SLIDE}?slide=5`);
    const slide = current(page);
    await expect(slide.locator(".slide-title")).toHaveText("Features by milestone");
    const edges = await slide.evaluate((host) => {
      const root = (host as HTMLElement).shadowRoot!;
      const inner = root.querySelector(".slide-inner")!.getBoundingClientRect();
      const cells = [...root.querySelectorAll(".slide-body tr > :last-child")];
      return { right: inner.right, cells: cells.map((c) => c.getBoundingClientRect().right) };
    });
    expect(edges.cells.length).toBeGreaterThan(1);
    for (const right of edges.cells) expect(right).toBeLessThanOrEqual(edges.right + 1);
  });
});

test.describe("one paragraph longer than a slide", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("E-9: it goes on continuation slides, every sentence once, none clipped", async ({ page }) => {
    await page.addInitScript(([key]) => localStorage.setItem(key, "long-paragraph"), [MOCK_SCENARIO_KEY] as const);
    await login(page);
    await page.goto(SLIDE);
    const counter = page.getByTestId("slide-counter");
    await expect(counter).toHaveText(/^1 \/ \d+$/);
    const total = Number((await counter.innerText()).split("/")[1]);
    const shown: string[] = [];
    const headings: string[] = [];
    for (let n = 2; n <= total; n++) {
      await page.getByRole("button", { name: "Next slide" }).click();
      await expect(counter).toHaveText(`${n} / ${total}`);
      const slide = current(page);
      const heading = await slide.locator(".slide-title").innerText();
      if (!heading.startsWith("Problem")) continue;
      headings.push(heading);
      shown.push(await slide.locator(".slide-body").innerText());
      const fit = await slide.evaluate((host) => {
        const root = (host as HTMLElement).shadowRoot!;
        const inner = root.querySelector(".slide-inner")!;
        return inner.scrollHeight <= inner.clientHeight + 1;
      });
      expect(fit, heading).toBe(true);
    }
    expect(headings.length).toBeGreaterThan(1);
    expect(headings).toEqual(headings.map((_, i) => `Problem (${i + 1} of ${headings.length})`));
    const all = shown.join(" ");
    for (let i = 1; i <= 30; i++) {
      expect(all.split(`Sentence ${i} says`).length - 1, `sentence ${i}`).toBe(1);
    }
  });
});
