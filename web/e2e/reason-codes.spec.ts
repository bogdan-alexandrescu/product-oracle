import { expect, test } from "./test";

import { buildCodeIndex, nameCodes, type CodeIndex } from "../lib/code-index";

/*
 * codes-and-chips: a proposal's reason, unit-tested without a browser. A known goal or
 * feature code written bare gets its name beside it; a code nothing in the company names
 * (a source document's own requirement number) is shown with the source's title.
 * protects = no code is shown without its name; fails_when = a bare code is left as written,
 * or a code already named gets its name twice; no_claim = how the card looks (named-codes-text.spec.ts).
 */

const index: CodeIndex = buildCodeIndex(
  [],
  [
    { id: "goal-b", kind: "Goal", code: "G-B", name: "Growth", status: "confirmed" },
    { id: "goal-a1", kind: "Goal", code: "G-A1", name: "Activation rate", status: "confirmed" },
    { id: "feat-8", kind: "Feature", code: "F-08", name: "Example feature", status: "confirmed" },
  ],
);
const SOURCE = "Example trip planner brief";
const name = (text: string) => nameCodes(text, index, SOURCE);

test("a known code written bare gets its name", () => {
  expect(name("Updates the G-B goal body.")).toBe("Updates the G-B Growth goal body.");
  expect(name("Reads the (G-A1 metric) as written.")).toBe("Reads the (G-A1 Activation rate metric) as written.");
  expect(name("F-08 ships first.")).toBe("F-08 Example feature ships first.");
});

test("a code already named keeps its one name", () => {
  expect(name("F-08 Example feature ships first.")).toBe("F-08 Example feature ships first.");
  expect(name("F-08: Example feature ships first.")).toBe("F-08: Example feature ships first.");
  expect(name("Growth (G-B) needs a target.")).toBe("Growth (G-B) needs a target.");
  // Named twice over is the same text: the renderer may run on its own output.
  expect(name(name("The G-B goal body."))).toBe(name("The G-B goal body."));
});

test("a code nothing names is shown with the source's title", () => {
  expect(name("Covers FR-06.")).toBe(`Covers FR-06 (from ${SOURCE}).`);
  expect(name("Splits FR-08/FR-09 into two.")).toBe(`Splits FR-08/FR-09 (from ${SOURCE}) into two.`);
  expect(name(name("Covers FR-06."))).toBe(`Covers FR-06 (from ${SOURCE}).`);
  // Known and unknown codes side by side: each its own way.
  expect(name("F-08 and FR-06 agree.")).toBe(`F-08 Example feature and FR-06 (from ${SOURCE}) agree.`);
});

test("words that only look like codes stay as written", () => {
  for (const text of [
    "Ships in Q4 with UTF-8 names.",
    "See https://example.com/FR-06 for more.",
    "Follows ISO-8601 dates.",
    "Text with no codes.",
    // Look-alikes no deny-list named: only a requirement number's own prefix is from a source.
    "Tried GPT-4 on the draft.",
    "Merged in PR-12 last week.",
    "Needs an A-1 visa.",
  ]) {
    expect(name(text)).toBe(text);
  }
});

test("a goal or feature code the index does not hold is never from a source", () => {
  // While the company's codes load, or a rejected or archived goal's code.
  for (const index of [new Map(), buildCodeIndex([], [])] as CodeIndex[]) {
    expect(nameCodes("Updates the G-B goal body.", index, SOURCE)).toBe("Updates the G-B goal body.");
    expect(nameCodes("F-08 ships first.", index, SOURCE)).toBe("F-08 ships first.");
    expect(nameCodes("Covers FR-06.", index, SOURCE)).toBe(`Covers FR-06 (from ${SOURCE}).`);
  }
  expect(name("Retires G-Z, an archived goal.")).toBe("Retires G-Z, an archived goal.");
});

test("with no known source, a source's number reads as written", () => {
  expect(nameCodes("Covers FR-06.", index, null)).toBe("Covers FR-06.");
  expect(nameCodes("F-08 and FR-06 agree.", index, null)).toBe("F-08 Example feature and FR-06 agree.");
});
