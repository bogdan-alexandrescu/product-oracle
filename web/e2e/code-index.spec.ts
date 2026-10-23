import { expect, test } from "@playwright/test";

import { buildCodeIndex, splitCodes, type CodeIndex } from "../lib/code-index";

/*
 * The code index (#305), unit-tested without a browser: built from a sample document, it
 * finds headings, requirement lines, slices (falling back to the parent) and ranges, and
 * ignores lookalikes in code blocks and URLs.
 * protects = the codes a reader is shown a card for; fails_when = a heading or line code
 * is missed, or a code inside a code block or a URL is recognised;
 * no_claim = how the card looks (named-codes-text.spec.ts).
 */

const DOC = [
  { section_key: "f-28", heading: "F-28 Shared trip notes", body_md: "Travellers keep notes on a trip.\n\n- R1 (F-28) Notes save offline. Even on a plane.\n- R2 (F-28) Notes sync on reconnect." },
  {
    section_key: "f-30",
    heading: "F-30 Packing lists",
    body_md: "F-30a ships first. See R1–R3 and R1-R2.\n\n1. **R3** (F-30) Lists share by link.\n\n```\nR9 (F-28) Lookalike in a fence.\n```",
  },
  { section_key: "milestones", heading: "Milestones", body_md: "| Code | Name |\n|---|---|\n| M1 | Private beta |\n| M2 | Public launch |" },
  { section_key: "decisions", heading: "Decisions and open questions", body_md: "- D1 — Lists are per trip\n- Q1: Who can edit a shared list?\n\nF-31 depends on F-30 in prose." },
  { section_key: "goal-trace", heading: "Goal trace", body_md: "- **G2 (retention)**: more repeat trips within 30 days." },
];

const index: CodeIndex = buildCodeIndex(DOC, [{ id: "goal-1", kind: "Goal", code: "G-B", name: "Growth", status: "confirmed" }]);

const known = (text: string) => splitCodes(text, index).flatMap((p) => (typeof p === "string" ? [] : [p.text]));

test("finds headings, requirement lines, table rows, decisions and goals", () => {
  expect(index.get("F-28")).toMatchObject({ kind: "Feature", name: "Shared trip notes", sectionKey: "f-28", from: "this PRD" });
  expect(index.get("R1")).toMatchObject({ kind: "Requirement", name: "Notes save offline", sectionKey: "f-28", line: "Feature F-28 Shared trip notes" });
  expect(index.get("R3")).toMatchObject({ kind: "Requirement", name: "Lists share by link", sectionKey: "f-30" });
  expect(index.get("M2")).toMatchObject({ kind: "Milestone", name: "Public launch", sectionKey: "milestones" });
  expect(index.get("D1")).toMatchObject({ kind: "Decision", name: "Lists are per trip" });
  expect(index.get("Q1")).toMatchObject({ kind: "Open question", name: "Who can edit a shared list?" });
  expect(index.get("G-B")).toMatchObject({ kind: "Goal", name: "Growth", entityId: "goal-1", from: "confirmed" });
  expect(index.get("G2")).toMatchObject({ kind: "Goal", name: "retention", line: "more repeat trips within 30 days", sectionKey: "goal-trace" });
  // A code that only prose mentions is not defined by it.
  expect(index.has("F-31")).toBe(false);
});

test("a slice takes its parent's name; a range lists its known members", () => {
  const [slice] = splitCodes("F-30a ships first.", index).filter((p) => typeof p !== "string");
  expect(slice).toMatchObject({ text: "F-30a", entry: { code: "F-30a", name: "Packing lists", line: "Feature F-30, slice a", sectionKey: "f-30" } });

  const ranges = splitCodes("See R1–R3 and R1-R2.", index).filter((p) => typeof p !== "string");
  expect(ranges.map((p) => p.text)).toEqual(["R1–R3", "R1-R2"]);
  expect(ranges[0].entry.members?.map((m) => m.code)).toEqual(["R1", "R2", "R3"]);
  expect(ranges[1].entry.members?.map((m) => m.code)).toEqual(["R1", "R2"]);
});

test("unknown codes, code blocks and URLs stay plain; the text is unchanged", () => {
  expect(index.has("R9")).toBe(false);
  expect(known("F-99 and F-31 are unknown; F-28 is known.")).toEqual(["F-28"]);
  expect(known("See https://example.com/specs/F-28 and www.example.com/R1 for more.")).toEqual([]);
  expect(known("Keys like g.F-28 or ?id=R1 are not codes.")).toEqual([]);
  const text = "R1–R3 cover F-28 (G-B), then M1.";
  expect(known(text)).toEqual(["R1–R3", "F-28", "G-B", "M1"]);
  expect(
    splitCodes(text, index)
      .map((p) => (typeof p === "string" ? p : p.text))
      .join(""),
  ).toBe(text);
});

test("a 60-section document indexes and splits quickly", () => {
  const sections = Array.from({ length: 60 }, (_, i) => ({
    section_key: `f-${i + 1}`,
    heading: `F-${i + 1} Feature ${i + 1}`,
    body_md: Array.from({ length: 10 }, (_, j) => `- R${i * 10 + j + 1} (F-${i + 1}) Requirement ${j}. It refers to F-${(i % 60) + 1} and R1–R10.`).join("\n"),
  }));
  const t0 = performance.now();
  const big = buildCodeIndex(sections);
  for (const s of sections) for (const line of s.body_md.split("\n")) splitCodes(line, big);
  expect(big.size).toBe(660);
  expect(performance.now() - t0).toBeLessThan(200);
});
