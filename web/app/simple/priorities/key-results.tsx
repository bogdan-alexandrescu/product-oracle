"use client";

import { useMemo, type ReactNode } from "react";

import { InfoTip } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { keyResults, type KeyResults } from "@/lib/key-results";
import { useQuery } from "@/lib/use-query";

import { goalLabel } from "./plan-buckets";

type Out = Schemas["SimplePrioritiesOut"];
type Buckets = Schemas["GoalBucketsOut"];
type Plan = Schemas["SimplePlanOut"];
type GoalRef = { key: string; title: string; position?: number | null };
/** A row's goal as Priorities reads it: its top-level goal, and the key result it names (`kr_key`), if any. */
type PlacedGoal = GoalRef & { kr_key?: string };

/** A row's top-level goal key and, when the row names a key result, that key result's own: a goal's list (?goal=) matches either. */
export const goalKeysOf = (g: GoalRef): string[] => [g.key, ...((g as PlacedGoal).kr_key ? [(g as PlacedGoal).kr_key!] : [])];

/** A goal's key result as its bucket lists it: its name (with its code) and its target line, if it has one. */
export type BucketKeyResult = { id: string; name: string; line: string | null };

export type PriorityKeyResults = {
  krs: KeyResults;
  /** A goal's key results by its id, key or name (its bucket's list); `gb`: the goal buckets as read, for each one's target. */
  of: (refs: (string | null | undefined)[], gb?: Buckets) => BucketKeyResult[];
  /** The top-level goal of a key result named by its id, key, title or name; null for a goal. */
  top: (ref: string | null | undefined) => { id: string; key: string; title: string } | null;
  /**
   * goal-delete-r7: whether `goal` (by id, else by name) is above the goal `id`, up its parents whatever
   * their status (goal_buckets.is_live walks so: a proposed goal counts as live, so it is walked through).
   */
  under: (id: string, goal: { id: string; title: string }) => boolean;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** A key result's name that starts with a code of its own ("KR 1 Half of …") reads without the goal tree's code too. */
const OWN_CODE = /^(KR|O)[\s-]?\d+(\.\d+)*\b/i;

/**
 * kr-in-priorities: the confirmed goals as Priorities shows them, as the roadmap does (lib/key-results):
 * only top-level goals are goals; a key result (a subgoal) sits in its goal's bucket.
 */
export function usePriorityKeyResults(): PriorityKeyResults {
  const goals = useQuery("simple-priorities-goal-tree", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  return useMemo(() => {
    const list = goals.data ?? [];
    const krs = keyResults(list);
    // A goal named without its code ("Faster activation" for "G-A Faster activation") is found by its name.
    const named = (ref: string) => list.find((e) => goalLabel(e.title).name.toLowerCase() === goalLabel(ref).name.toLowerCase())?.id;
    const find = (refs: (string | null | undefined)[]) => {
      for (const ref of refs.filter((r): r is string => !!r)) for (const k of [ref, named(ref)]) if (k && krs.of(k).length) return krs.of(k);
      return [];
    };
    const of = (refs: (string | null | undefined)[], gb?: Buckets): BucketKeyResult[] =>
      find(refs).map((k) => {
        // Its target line: the goal buckets' own (measure, target; by id, else by name), else the Ground Truth's.
        const rec = gb?.goals.find((g) => g.id === k.id) ?? gb?.goals.find((g) => goalLabel(g.title).name.toLowerCase() === k.name.toLowerCase());
        const attrs = list.find((e) => e.id === k.id)?.attrs;
        const measure = text(rec?.measure) ?? krs.metricOf(k.id);
        const target = text(rec?.target) ?? text(attrs?.target_text) ?? text(attrs?.target);
        return { id: k.id, name: k.code && !OWN_CODE.test(k.name) ? `${k.code} ${k.name}` : k.name, line: target && (measure ? `${measure}: ${target}` : target) };
      });
    const top = (ref: string | null | undefined) => (ref ? (krs.parentOf(ref) ?? krs.parentOf(named(ref))) : null);
    const byId = new Map(list.map((e) => [e.id, e]));
    const name = (title: string) => goalLabel(title).name.toLowerCase();
    const under = (id: string, goal: { id: string; title: string }) => {
      const seen = new Set<string>();
      for (let at = byId.get(id); at?.parent_id && !seen.has(at.id); at = byId.get(at.parent_id)) {
        const up = byId.get(at.parent_id);
        if (at.parent_id === goal.id || (up && name(up.title) === name(goal.title))) return true;
        seen.add(at.id);
      }
      return false;
    };
    return { krs, of, top, under };
  }, [goals.data]);
}

/** The top-level goal of a goal named by its key or title: itself unless it is a key result. */
function topOf<G extends GoalRef>(g: G, krs: KeyResults): G {
  const p = krs.parentOf(g.key) ?? krs.parentOf(g.title);
  return p ? { ...g, key: p.key, title: p.title } : g;
}

/**
 * The priorities with each key result's work under its top-level goal: every row, draft and
 * unranked item names that goal, and a key result's bucket is added to its goal's (in the goal's
 * place, else the key result's), so the buckets, the chart's shapes and the ranked list read one goal.
 */
export function topGoalPriorities(data: Out | undefined, krs: KeyResults): Out | undefined {
  if (!data) return data;
  const top = <G extends GoalRef>(g: G | null | undefined): G | null => (g ? topOf(g, krs) : null);
  // A goal's position: its own row's, so its key results' rows sort with it.
  const position = new Map<string, number | null>();
  for (const r of data.rows) if (r.goal && !krs.parentOf(r.goal.key)) position.set(r.goal.key, r.goal.position ?? null);
  for (const b of data.buckets) if (!b.no_goal && !krs.parentOf(b.key)) position.set(b.key, b.position ?? null);
  const placed = <G extends GoalRef>(g: G | null | undefined): G | null => {
    const t = top(g);
    // Its own goal's key stays as `kr_key`, so a key result's list (?goal=) still finds it.
    return t && g && t.key !== g.key ? { ...t, position: position.get(t.key) ?? t.position ?? null, kr_key: g.key } : t;
  };
  const buckets: Out["buckets"] = [];
  for (const b of data.buckets) {
    const t = b.no_goal ? null : (krs.parentOf(b.key) ?? krs.parentOf(b.title));
    // A goal's bucket already taken in (its key result came first): nothing more to add.
    if (!t) {
      if (!buckets.some((x) => x.key === b.key)) buckets.push({ ...b, codes: [...b.codes] });
      continue;
    }
    const into = buckets.find((x) => x.key === t.key);
    if (into) {
      into.weeks += b.weeks;
      into.codes.push(...b.codes);
      continue;
    }
    // Its goal's own bucket, wherever it comes, takes it in here; else the goal's bucket stands here.
    const own = data.buckets.find((x) => x.key === t.key);
    buckets.push(own ? { ...own, weeks: own.weeks + b.weeks, codes: [...own.codes, ...b.codes] } : { ...b, key: t.key, title: t.title, position: position.get(t.key) ?? b.position ?? null, codes: [...b.codes] });
  }
  for (const b of buckets) {
    b.weeks = Number(b.weeks.toFixed(3));
    b.share = data.weeks_total ? Number((b.weeks / data.weeks_total).toFixed(3)) : 0;
  }
  return {
    ...data,
    rows: data.rows.map((r) => (r.goal ? { ...r, goal: placed(r.goal) } : r)),
    drafts: data.drafts.map((d) => (d.goal ? { ...d, goal: placed(d.goal) } : d)),
    unranked: data.unranked.map((u) => (u.goal ? { ...u, goal: placed(u.goal) } : u)),
    buckets,
  };
}

/**
 * The goal buckets as Priorities draws them: top-level goals only (numbered 1 to n), each
 * feature linked to a key result linked to its goal instead. A key result whose goal has no
 * bucket stays a goal of its own, so nothing is lost.
 */
export function topGoalBuckets(gb: Buckets | undefined, krs: KeyResults): Buckets | undefined {
  if (!gb) return gb;
  const parent = new Map<string, string>();
  for (const g of gb.goals) {
    const p = krs.parentOf(g.id) ?? krs.parentOf(g.title);
    const to = p && gb.goals.find((x) => x.id === p.id || x.title === p.title);
    if (to && to.id !== g.id) parent.set(g.id, to.id);
  }
  if (!parent.size) return gb;
  const lift = (ids: string[] | undefined) => [...new Set((ids ?? []).map((id) => parent.get(id) ?? id))];
  return {
    ...gb,
    // The API's numbers count key results too: the goals left are numbered again, without gaps.
    goals: gb.goals.filter((g) => !parent.has(g.id)).map((g, i) => ({ ...g, order: i + 1 })),
    features: gb.features.map((f) => ({ ...f, goal_ids: lift(f.goal_ids), assumed_goal_ids: lift(f.assumed_goal_ids) })),
  };
}

/**
 * A dated plan with each slice that names a key result under its top-level goal (a plan goal that is
 * a key result is left out when its goal is listed), so placedPlan finds the goal among the buckets.
 */
export function topGoalPlan(plan: Plan, top: PriorityKeyResults["top"]): Plan {
  const same = (a: string, b: string) => goalLabel(a).name.toLowerCase() === goalLabel(b).name.toLowerCase();
  const listed = (name: string) => plan.goals.some((g) => same(g.name, name));
  const up = (name: string) => {
    const t = top(name);
    return t && (listed(t.title) || !listed(name)) ? (plan.goals.find((g) => same(g.name, t.title))?.name ?? t.title) : name;
  };
  if (!plan.slices.some((s) => s.goal && up(s.goal) !== s.goal) && !plan.goals.some((g) => up(g.name) !== g.name)) return plan;
  const weeks = new Map<string, Plan["goal_weeks"][number]>();
  for (const w of plan.goal_weeks) {
    const k = `${up(w.goal)}|${w.milestone}`;
    const was = weeks.get(k);
    weeks.set(k, was ? { ...was, weeks: was.weeks + w.weeks } : { ...w, goal: up(w.goal) });
  }
  return {
    ...plan,
    slices: plan.slices.map((s) => (s.goal ? { ...s, goal: up(s.goal) } : s)),
    goals: plan.goals.filter((g) => up(g.name) === g.name),
    goal_weeks: [...weeks.values()],
  };
}

/** A goal's key results inside its bucket: each one's name, its target line behind an (i). */
export function KeyResultList({ list, goal, className = "" }: { list: BucketKeyResult[]; goal: string; className?: string }) {
  if (!list.length) return null;
  return (
    <ul data-testid="goal-krs" aria-label={`${goal}'s key results`} className={`mt-1 text-[15px] leading-5 text-text2 ${className}`}>
      {list.map((k) => (
        <li key={k.id} data-testid="goal-kr" className="flex min-w-0 items-center gap-1">
          <span className="truncate" title={k.name}>
            {k.name}
          </span>
          {k.line && (
            <InfoTip label={`${k.name}'s target`} testId="goal-kr-tip">
              {k.line}
            </InfoTip>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A move as the goal buckets write it: a feature carried off its goal's bucket leaves the link it
 * is placed by (a key result's, when that is what places it there), so it never keeps that link behind.
 */
export function liftedMoves<W extends { move: (feature: string, from: string | null, to: string, text: ReactNode) => Promise<boolean> }>(writes: W, read: Buckets | undefined): W {
  return { ...writes, move: (feature, from, to, text) => writes.move(feature, from && (read?.features.find((f) => f.id === feature)?.goal_ids?.[0] ?? from), to, text) };
}
