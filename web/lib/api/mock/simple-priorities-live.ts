import type { Schemas } from '@/lib/api/client';

type Out = Schemas['SimplePrioritiesOut'];

/**
 * prio-3 (#1739, #1898, #1894), the "priorities-live-shape" scenario: "priorities-plan-goal-outside" read with the
 * shape the live GET /v1/simple/priorities has (Nov 27), on invented data. The plan is one PRD's: a few slices with no
 * engineer-weeks, its milestones with none planned, goal_weeks empty, its milestones coded by the PRD's own M1, M2,
 * M3 (the roadmap's M1 is another milestone); in_plan only on the plan's features; a goal whose rows make this quarter
 * holds weeks in `buckets` and nothing in the plan; ranks above the line skip (they interleave with the rows below);
 * a row's milestone carries the PRD's own number with a goal target, "M2 (99.7% setup success)".
 */
export const PRIORITIES_LIVE_SHAPE_SCENARIO = 'priorities-live-shape';

export function liveShape(out: Out): Out {
  const plan = out.plan;
  if (!plan) return out;
  const slices = plan.slices.slice(0, 6).map((s) => ({ ...s, effort_weeks: null }));
  const inPlan = new Set(slices.map((s) => s.feature_code));
  const target = plan.goals.flatMap((g) => g.targets).find((t) => t.milestone === 'M2');
  // The goal none of the plan serves: its first two rows make this quarter.
  const outside = out.rows.filter((r) => r.goal?.title === 'Grow retention').slice(0, 2);
  const lifted = new Set(outside.map((r) => r.code));
  const rows = out.rows.map((r, i) => ({
    ...r,
    in_plan: !!r.own_key && inPlan.has(r.own_key),
    above_line: r.above_line || lifted.has(r.code),
    milestone: i === 0 && target ? `M2 (${target.target})` : r.milestone,
  }));
  const buckets = out.buckets.map((b) =>
    b.title === 'Grow retention'
      ? {
          ...b,
          weeks: outside.reduce((n, r) => n + (r.effort ?? 0), 0),
          codes: outside.map((r) => r.code),
        }
      : b,
  );
  const total = buckets.reduce((n, b) => n + b.weeks, 0);
  return {
    ...out,
    rows,
    buckets: buckets.map((b) => ({
      ...b,
      share: total ? Math.round((b.weeks / total) * 100) / 100 : 0,
    })),
    weeks_total: total,
    plan: {
      ...plan,
      slices,
      goal_weeks: [],
      milestones: plan.milestones.map((m) => ({ ...m, planned_weeks: 0, effort_weeks: null })),
    },
  };
}
