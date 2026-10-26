import { readFileSync } from "node:fs";
import path from "node:path";

import { audienceSections, redact, type BoardItem } from "../lib/api/mock/audience";
import { expect, test } from "./test";

/**
 * The mock renders each audience as the API does. Team and Engineering keep the written
 * text without what they hide, case for case with the API (api/tests/fixtures/
 * audience_redaction.json, run there by tests/test_audience_redaction.py). Board (owner
 * decision 2026-10-26) is built from the roadmap items alone: each shown item's title,
 * outcome, confidence and goal, grouped by horizon, and no written text of any form
 * (tables in blockquotes and nested lists, owner labels of any qualifier, estimate
 * headers, task lists, a left-out item's heading, HTML).
 */
type Case = {
  name: string;
  items: { title: string; tracker?: string[]; no_goal?: boolean }[];
  text: string;
  team: string;
  engineering: string;
};

const CASES: Case[] = JSON.parse(readFileSync(path.join(__dirname, "../../api/tests/fixtures/audience_redaction.json"), "utf8"));

// Words Board writes itself (headings, column heads, the left-out and no-items lines).
const BOARD_WORDS = new Set(
  "now next later item items outcome confidence goal serve serves no confirmed and is are left out this roadmap version has structured so board rows to show built from its only never written text yet the a of 0 1 2 3 4 5 6 7 8 9".split(" "),
);
const words = (text: string) => new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase()));

function sections(text: string, items: BoardItem[]) {
  const rows: [string, number, string][] = [
    ["roadmap", 1, "Written roadmap heading"],
    ["summary", 2, "Summary"],
    ["brief-items", 2, "Items by horizon"],
    ["now", 2, "Now"],
    ...items.map((i): [string, number, string] => [`now-${i.key}`, 3, i.title]),
    ["next", 2, "Next"],
    ["releases", 2, "Releases"],
    ["release-1", 3, "Release one"],
    ["not-doing", 2, "Not doing"],
  ];
  return rows.map(([section_key, level, heading]) => ({ section_key, level, heading, body_md: text, body_text: text, layer: "detail" }));
}

const boardItems = (items: Case["items"]): BoardItem[] =>
  items.map((i, n) => ({
    key: `item-${n}`,
    title: i.title,
    outcome: `Outcome ${n} lands`,
    horizon: (["now", "next", "later"] as const)[n % 3],
    position: n,
    confidence: "high",
    rank: null,
    goals: i.no_goal ? [] : [`Goal ${n}`],
    no_goal: !!i.no_goal,
  }));

const board = (text: string, items: BoardItem[]) =>
  audienceSections(sections(text, items), "board", items)
    .map((s) => `${s.heading}\n${s.body_md}`)
    .join("\n");

for (const c of CASES) {
  test(`the mock renders as the API: ${c.name}`, () => {
    const refs = c.items.flatMap((i) => i.tracker ?? []);
    expect(redact(c.text, "team", refs)).toBe(c.team);
    expect(redact(c.text, "engineering", refs)).toBe(c.engineering);
    const items = boardItems(c.items.length ? c.items : [{ title: "Bulk import" }]);
    const out = board(c.text, items);
    expect(out).toBe(board("", items));
    const shown = items.filter((i) => !i.no_goal);
    const allowed = new Set([...BOARD_WORDS, ...words(shown.map((i) => `${i.title} ${i.outcome} ${i.confidence} ${i.goals.join(" ")}`).join(" "))]);
    expect([...words(out)].filter((w) => !allowed.has(w))).toEqual([]);
    expect(out).not.toMatch(/[<>`]/);
    for (const i of shown) expect(out).toContain(`| ${i.title} | ${i.outcome} | high | ${i.goals[0]} |`);
    for (const i of items.filter((x) => x.no_goal)) expect(out).not.toContain(`| ${i.title} |`);
  });
}

test("the mock's Board leaves out goal-less items and says how many", () => {
  const items = boardItems([{ title: "Import", no_goal: true }, { title: "Import wizard" }, { title: "SSO" }, { title: "Audit", no_goal: true }]);
  const out = board("- Import: a second importer\n- Import wizard: guided", items);
  expect(out).toContain("2 items serve no confirmed goal and are left out.");
  expect(out).not.toContain("second importer");
});

test("the mock's Board of a version without items says so in words", () => {
  const out = audienceSections(sections("| Item | Owner |\n|---|---|\n| CSV | Dana |", []), "board", []);
  expect(out.map((s) => s.body_md)).toEqual(["This roadmap version has no structured items yet, so Board has no rows to show: Board is built from its items only, never its written text."]);
});
