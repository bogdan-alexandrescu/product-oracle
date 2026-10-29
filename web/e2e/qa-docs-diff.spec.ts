import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";
import { readableWords, wordDiff } from "../lib/diff";

// QA pass 1, docs lane: the text diff of Saved carts v1 → v2 (its Problem section was rewritten;
// v2 has no roadmap items yet), opened at its address.

async function openDiff(page: Page) {
  await login(page);
  await page.goto("/documents/saved-carts/diff?from=1&to=2");
  await expect(page.getByRole("heading", { name: "Changes from v1 to v2" })).toBeVisible();
}

const problem = (page: Page) =>
  page.getByTestId("diff-section").filter({ has: page.getByRole("heading", { name: "Problem", exact: true }) });

/** Each change's neighbours: no removed and added words alternate around a word or two left alone. */
async function interleaved(diff: Locator): Promise<string[]> {
  return diff.evaluate((root) => {
    const bad: string[] = [];
    const isChange = (el: Element | null) => !!el && (el.tagName === "DEL" || el.tagName === "INS");
    for (const span of root.querySelectorAll("span")) {
      if (span.children.length > 0) continue;
      const text = span.textContent ?? "";
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      if (!text.includes("\n") && words <= 3 && isChange(span.previousElementSibling) && isChange(span.nextElementSibling)) {
        bad.push(`${span.previousElementSibling!.textContent}|${text}|${span.nextElementSibling!.textContent}`);
      }
    }
    return bad;
  });
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("qa-docs-11: a rewritten sentence reads as one removed phrase, then one added phrase", async ({ page }) => {
      await openDiff(page);
      const words = problem(page).getByTestId("word-diff");
      await expect(words.locator("del")).toHaveText(["Most start over; many give up."]);
      await expect(words.locator("ins")).toHaveText(["More than half start over."]);
      expect(await interleaved(words)).toEqual([]);
      await expect(words).toContainText("Shoppers build a cart on their phone, then lose it when they move to a laptop.");
    });

    test("qa-docs-28: no status code, no Open items before there are items, no section anchors", async ({ page }) => {
      await openDiff(page);
      const items = page.getByTestId("diff-items").filter({ visible: true });
      await expect(items).toContainText("Roadmap items for v2 are not ready yet.");
      await expect(items).not.toContainText(/\(\d{3}\)|\b409\b/);
      await expect(items.getByRole("link", { name: "Open items" })).toHaveCount(0);

      const section = problem(page);
      await expect(section).not.toContainText("#problem");
      await expect(page.getByTestId("diff-section").filter({ hasText: "#" })).toHaveCount(0);
      await section.getByRole("link", { name: "View Problem in v2" }).click();
      await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2/);
    });
  });
}

// Review of qa-docs-11: a short unchanged run joins two changes only when the sentence both lost
// and gained words; words only added (or only removed) around it never show it as removed.
test.describe("review: readable word diff", () => {
  const read = (from: string, to: string) => readableWords(wordDiff(from, to));

  test("words only added around a short unchanged run leave that run alone", () => {
    expect(read("a b c", "a X b Y c")).toEqual([
      { op: "equal", text: "a " },
      { op: "insert", text: "X " },
      { op: "equal", text: "b " },
      { op: "insert", text: "Y " },
      { op: "equal", text: "c" },
    ]);
  });

  test("words only removed around a short unchanged run leave that run alone", () => {
    expect(read("a X b Y c", "a b c")).toEqual([
      { op: "equal", text: "a " },
      { op: "delete", text: "X " },
      { op: "equal", text: "b " },
      { op: "delete", text: "Y " },
      { op: "equal", text: "c" },
    ]);
  });

  test("a rewritten sentence still reads as one removed phrase, then one added phrase", () => {
    const ops = read("Most start over; many give up.", "More than half start over.");
    expect(ops.filter((w) => w.op === "delete").map((w) => w.text.trim())).toEqual(["Most start over; many give up."]);
    expect(ops.filter((w) => w.op === "insert").map((w) => w.text.trim())).toEqual(["More than half start over."]);
  });
});
