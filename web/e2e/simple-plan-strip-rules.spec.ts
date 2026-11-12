import { readFileSync } from "node:fs";
import path from "node:path";

import { planByMonth, type PlanInput } from "../lib/simple-home";
import { expect, test } from "./test";

/*
 * Card plan-strip-rules (#723 polish review): protects = Home's strip (lib/simple-home.ts
 * planByMonth) reads the cases shared with the API's oracle.simple.plan_strip.strip exactly
 * as the API does (api/tests/fixtures/plan_strip_cases.json, run there by
 * tests/test_simple_one_pager_review.py): names compared by code point, an empty milestone
 * name read as "Milestone", milestone texts carrying notes grouped by their code (M1) or
 * their text before " (" or ";", one row each, items linking one milestone record in its row
 * whatever their texts, "M1.5"/"M2026" read as texts, a named label before a bare code; fails_when = the two copies of the rules drift; no_claim =
 * drawing (simple-plan-strip.spec.ts drives it). No page: pure rules.
 */

type Case = { name: string; today: string; coded?: boolean; items: PlanInput[]; expected: unknown };
const CASES: Case[] = JSON.parse(readFileSync(path.join(__dirname, "../../api/tests/fixtures/plan_strip_cases.json"), "utf8"));

for (const c of CASES) {
  test(`the plan strip as the API draws it: ${c.name}`, () => {
    // The shared rules; which items a row holds is the one-pager's (its own spec).
    const got = planByMonth(c.items, c.today, null, c.coded ?? false);
    for (const r of got?.rows ?? []) {
      delete (r as { item_ids?: string[] }).item_ids;
      delete (r as { code?: string | null }).code;
    }
    expect(got).toEqual(c.expected);
  });
}

/*
 * Card plan-dated-rows (moved from simple-plan-dated-milestones.spec.ts when Home's plan became
 * the company roadmap's, PR 1235): protects = a dated plan milestone's row spans its start to
 * its end date whatever its slices' own dates, and is not drawn as an estimate (M3 Open to all,
 * 28 Dec - 12 Feb, with a year-end break: its slices start 4 Jan); fails_when = a row starts at
 * its earliest slice, or a sliced feature falls into no milestone. No page: pure rules.
 */
test("a dated plan milestone's row spans its start to its end", () => {
  const slice = (start: string, end: string, milestone: string, milestoneStart: string, milestoneDate: string): PlanInput => ({ start, end, estimated: false, milestone, milestoneStart, milestoneDate });
  const strip = planByMonth(
    [
      slice("2026-11-09", "2026-11-20", "M1 · Prove it", "2026-11-02", "2026-11-27"),
      slice("2026-12-07", "2026-12-18", "M2 · Scale volume", "2026-11-30", "2026-12-25"),
      slice("2027-01-04", "2027-02-05", "M3 · Open to all", "2026-12-28", "2027-02-12"),
    ],
    "2026-11-05",
  )!;
  expect(strip.rows.map((r) => [r.name, r.start, r.end, r.estimated, r.items])).toEqual([
    ["M1 · Prove it", "2026-11-02", "2026-11-27", false, 1],
    ["M2 · Scale volume", "2026-11-30", "2026-12-25", false, 1],
    ["M3 · Open to all", "2026-12-28", "2027-02-12", false, 1],
  ]);
  expect(strip.months).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
});
