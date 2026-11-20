import { expect, test } from "vitest";

import { buildCodeIndex, splitCodes } from "./code-index";

// A wall-clock budget: runs alone (npm run test:timing, CI's e2e-timing job), never in the
// parallel unit run, where other files' load counts against it.

test("a 60-section document indexes and splits quickly @timing", () => {
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
