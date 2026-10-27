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
 * their text before " (" or ";", one row each; fails_when = the two copies of the rules drift; no_claim =
 * drawing (simple-plan-strip.spec.ts drives it). No page: pure rules.
 */

type Case = { name: string; today: string; items: PlanInput[]; expected: unknown };
const CASES: Case[] = JSON.parse(readFileSync(path.join(__dirname, "../../api/tests/fixtures/plan_strip_cases.json"), "utf8"));

for (const c of CASES) {
  test(`the plan strip as the API draws it: ${c.name}`, () => {
    expect(planByMonth(c.items, c.today)).toEqual(c.expected);
  });
}
