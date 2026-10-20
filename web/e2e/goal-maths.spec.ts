import { expect, test } from "@playwright/test";

import type { EntityOut } from "@/lib/api/client";

import { assess, formatFigure, goalViews, parseFigure, type Point } from "../app/home/_goals";

/**
 * Unit tests for Home's goal maths (no browser): reading a figure, the goal's direction,
 * whether it is met and the distance to go. Every case from the round 2 review is here.
 */

function goal(attrs: Record<string, unknown>, title = "A goal"): EntityOut {
  return {
    id: "g1",
    type: "goal",
    key: "g.one",
    title,
    body: null,
    attrs,
    status: "confirmed",
    origin: "user",
    locked: false,
    locked_by: null,
    locked_at: null,
    confidence: null,
    run_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  } as EntityOut;
}

const points = (...values: number[]): Point[] =>
  values.map((value, i) => ({ at: new Date(Date.UTC(2026, i, 1)).toISOString(), value }));

test.describe("parseFigure reads the value, not the first number", () => {
  const cases: [string, { value: number; unit: string; currency?: string; low?: number; high?: number } | null][] = [
    ["45%", { value: 45, unit: "%" }],
    ["400 clinics", { value: 400, unit: "clinics" }],
    ["below 8%", { value: 8, unit: "%" }],
    ["reduce to 8%", { value: 8, unit: "%" }],
    ["FY26 revenue $4M", { value: 4_000_000, unit: "", currency: "$" }],
    ["p95 < 200ms", { value: 200, unit: "ms" }],
    ["10-15%", { value: 10, unit: "%", low: 10, high: 15 }],
    ["10 to 15%", { value: 10, unit: "%", low: 10, high: 15 }],
    ["900k", { value: 900_000, unit: "" }],
    ["1.2M", { value: 1_200_000, unit: "" }],
    ["2B", { value: 2_000_000_000, unit: "" }],
    ["1,200 users", { value: 1200, unit: "users" }],
    ["400 clinics by 2027", { value: 400, unit: "clinics" }],
    ["under 1.5 min", { value: 1.5, unit: "min" }],
    ["90s", { value: 90, unit: "s" }],
    ["€250k ARR", { value: 250_000, unit: "arr", currency: "€" }],
    ["0.4", { value: 0.4, unit: "" }],
    ["double it", null],
    ["v2 launch", null],
    ["", null],
  ];
  for (const [raw, want] of cases) {
    test(`"${raw}"`, () => {
      const f = parseFigure(raw);
      if (want === null) {
        expect(f).toBeNull();
        return;
      }
      expect(f).not.toBeNull();
      expect(f!.value).toBeCloseTo(want.value, 6);
      expect(f!.unit).toBe(want.unit);
      expect(f!.currency).toBe(want.currency ?? "");
      if (want.low != null) expect(f!.range).toEqual([want.low, want.high]);
      else expect(f!.range).toBeNull();
    });
  }
  test("a number reads as itself", () => {
    expect(parseFigure(12)).toMatchObject({ value: 12, unit: "" });
    expect(parseFigure(null)).toBeNull();
  });
});

test.describe("distance to go, met and direction", () => {
  // [title, target, current, history, the text Home shows under the goal]
  const cases: [string, string, string | null, Point[] | undefined, string][] = [
    // Home's seeded goals keep their figures.
    ["Raise activation", "45%", "38%", undefined, "7 pts to go"],
    ["Grow paid conversion", "12%", "9.4%", undefined, "2.6 pts to go"],
    ["Cut early churn", "below 8%", "11%", undefined, "3 pts to go"],
    // A bare target already passed is met, never "to go".
    ["Clinics", "400 clinics", "450", undefined, "Target met"],
    ["Clinics", "400 clinics", "236", undefined, "164 clinics to go"],
    ["Clinics", "400 clinics by 2027", "236", undefined, "164 clinics to go"],
    ["Activation", "45%", "50%", undefined, "Target met"],
    ["Activation", "45%", "45%", undefined, "Target met"],
    // Words give the direction.
    ["Churn", "reduce to 8%", "5%", undefined, "Target met"],
    ["Churn", "reduce to 8%", "11%", undefined, "3 pts to go"],
    ["Churn", "cut to 8%", "8%", undefined, "Target met"],
    ["Cut early churn", "8%", "11%", undefined, "3 pts to go"],
    ["Cut early churn", "8%", "5%", undefined, "Target met"],
    ["Latency", "p95 < 200ms", "260ms", undefined, "60 ms to go"],
    ["Latency", "p95 < 200ms", "180ms", undefined, "Target met"],
    ["Signups", "at least 100", "100", undefined, "Target met"],
    ["Signups", "≥ 100", "99", undefined, "1 to go"],
    ["Churn", "at most 8%", "8%", undefined, "Target met"],
    // Strict below/above is not met at equality.
    ["Churn", "below 8%", "8%", undefined, "Not below"],
    ["Churn", "less than 5", "5", undefined, "Not below"],
    ["Signups", "above 40", "40", undefined, "Not above"],
    ["Signups", "> 100", "100", undefined, "Not above"],
    ["Signups", "more than 100", "101", undefined, "Target met"],
    // A bare target and no words: the history says which way the metric has to move.
    ["Tickets", "200", "260", points(300, 280, 260), "60 to go"],
    ["Tickets", "200", "190", points(300, 280, 190), "Target met"],
    ["Tickets", "200", "260", points(100, 150, 260), "Target met"],
    ["Tickets", "200", "260", undefined, "Target met"],
    // Suffixes and magnitudes reconcile.
    ["Revenue", "1.2M", "900k", undefined, "300k to go"],
    ["Revenue", "FY26 revenue $4M", "$3.1M", undefined, "$900k to go"],
    ["Revenue", "FY26 revenue $4M", "3.1M", undefined, "$900k to go"],
    ["Setup time", "under 1.5 min", "3.1 min", undefined, "1.6 min to go"],
    ["Setup time", "under 1 min", "90s", undefined, "0.5 min to go"],
    ["Users", "1,200 users", "950 users", undefined, "250 users to go"],
    ["Score", "0.8", "0.4", undefined, "0.4 to go"],
    // Ranges: their bound in the goal's direction (entering the range meets it).
    ["Margin", "10-15%", "12%", undefined, "Target met"],
    ["Margin", "10-15%", "8%", undefined, "2 pts to go"],
    ["Margin", "reduce to 10-15%", "20%", undefined, "5 pts to go"],
    // Units that do not match, or a side that cannot be read: no distance at all.
    ["Clinics", "400 clinics", "38%", undefined, ""],
    ["Activation", "45%", "38", undefined, ""],
    ["Latency", "p95 < 200ms", "40%", undefined, ""],
    ["Revenue", "$4M", "€3M", undefined, ""],
    ["Growth", "double it", "12", undefined, ""],
    ["Growth", "45%", "rising", undefined, ""],
    // No current value.
    ["Growth", "45%", null, undefined, "No current value"],
  ];
  for (const [title, target, current, history, want] of cases) {
    test(`${title}: ${current ?? "–"} against "${target}"${history ? ` from ${history[0].value}` : ""}`, () => {
      const [g] = goalViews([goal({ target, ...(current == null ? {} : { current }) }, title)]);
      expect(assess(g, history).text).toBe(want);
    });
  }

  test("met is a state, not only a label", () => {
    const [g] = goalViews([goal({ target: "below 8%", current: "8%" })]);
    expect(assess(g).state).toBe("short");
    const [h] = goalViews([goal({ target: "400 clinics", current: "450" })]);
    expect(assess(h).state).toBe("met");
    const [r] = goalViews([goal({ target: "double it", current: "12" })]);
    expect(assess(r).state).toBe("raw");
  });
});

test.describe("formatFigure shows the current value in its own terms", () => {
  const cases: [string, string][] = [
    ["38%", "38%"],
    ["9.4%", "9.4%"],
    ["900k", "900k"],
    ["$3.1M", "$3.1M"],
    ["260ms", "260 ms"],
    ["236", "236"],
    ["450 clinics", "450"],
  ];
  for (const [raw, want] of cases) {
    test(`"${raw}"`, () => expect(formatFigure(parseFigure(raw)!)).toBe(want));
  }
});

test("goals with the same weight sort by title, as the Baseline sorts them", () => {
  const a = { ...goal({ weight: 0.5 }, "Beta"), id: "b" };
  const b = { ...goal({ weight: 0.5 }, "alpha"), id: "a" };
  const c = { ...goal({ weight: 0.9 }, "Zeta"), id: "z" };
  expect(goalViews([a, b, c]).map((g) => g.title)).toEqual(["Zeta", "alpha", "Beta"]);
});
