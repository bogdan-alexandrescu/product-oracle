import { expect, test } from "@playwright/test";

import { blocksText, isSafeHref, parseBlocks } from "../lib/markdown";

// E1 (owner, 2026-10-20): the document view reads a section body as the API's check does
// (CommonMark through markdown-it), so a body the API reads as paragraph text never shows
// here as a list item or a table header, and the reverse. No browser needed.

test("an ordered list interrupts a paragraph only when it starts at 1", () => {
  expect(parseBlocks("R-9 is in scope.\n2. **Decided · from the approved PRD**").map((b) => b.t)).toEqual(["p"]);
  expect(parseBlocks("R-9 is in scope.\n1. first\n2. second").map((b) => b.t)).toEqual(["p", "ol"]);
  // Not interrupting a paragraph, any start number opens a list.
  expect(parseBlocks("2. second\n3. third")[0].t).toBe("ol");
});

test("an indented line after a paragraph stays paragraph text", () => {
  expect(parseBlocks("R-9 is in scope.\n    - **Decided · from the approved PRD**").map((b) => b.t)).toEqual(["p"]);
  // Up to three spaces, a bullet still interrupts (as in CommonMark).
  expect(parseBlocks("R-9 is in scope.\n   - an item").map((b) => b.t)).toEqual(["p", "ul"]);
  // An empty bullet does not interrupt a paragraph.
  expect(parseBlocks("R-9 is in scope.\n-").map((b) => b.t)).toEqual(["p"]);
});

test("a table needs a delimiter row with as many cells as its header", () => {
  const mismatched = parseBlocks("| **Decided · from the approved PRD** |\n| --- | --- |");
  expect(mismatched.map((b) => b.t)).toEqual(["p"]);
  const table = parseBlocks("| a | b |\n| --- | --- |\n| x | y | **Decided · from the approved PRD** |\n| z |");
  expect(table[0].t).toBe("table");
  if (table[0].t !== "table") return;
  // Extra cells are dropped, missing ones are empty (GFM), so nothing shows the API ignores.
  expect(table[0].rows.map((r) => r.length)).toEqual([2, 2]);
  expect(blocksText(table)).not.toContain("Decided");
});

test("an image is no text and citation ids may hold ':'", () => {
  const blocks = parseBlocks("![Decided · from the approved PRD](https://example.com/a.png) The cart [c:prd:c1] calls it.");
  expect(blocksText(blocks)).toBe(" The cart  calls it.");
  if (blocks[0].t !== "p") throw new Error("paragraph expected");
  expect(blocks[0].c.map((n) => n.t)).toEqual(["img", "text", "cite", "text"]);
  expect(blocks[0].c[2]).toEqual({ t: "cite", key: "prd:c1" });
});

test("a link renders only for http, https, mailto and relative or anchor hrefs", () => {
  for (const ok of ["https://a.io/x", "http://a.io", "mailto:a@b.co", "/documents/x", "#sec", "./a", "page?x=1"]) {
    expect(isSafeHref(ok), ok).toBe(true);
  }
  for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "vbscript:x", "data:text/html,x", "ftp://a.io"]) {
    expect(isSafeHref(bad), bad).toBe(false);
  }
});

test("many unclosed image and link openers parse in linear time", () => {
  for (const unit of ["![", "[", "![a](", "[a]("]) {
    const started = Date.now();
    parseBlocks(unit.repeat(50_000));
    expect(Date.now() - started, unit).toBeLessThan(1500);
  }
});
