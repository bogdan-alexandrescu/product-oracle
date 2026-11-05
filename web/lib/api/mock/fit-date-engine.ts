// Bring a date in's engine, for the mock: the API's oracle.simple.fit_date (schedule, apply, the
// levers, answer and draft) line for line, so the mock's days, person-weeks, ranking, pick and dates
// come from the same capacity queue as the API's. Its plan is ./fit-date-plan.json (invented data),
// which api/tests/test_simple_fit_date_mock_plan.py runs through the real engine and pins.

import raw from "./fit-date-plan.json";

export type Lever = "move" | "next_prd" | "slice" | "ungate" | "split" | "overlap" | "capacity";
export type CostKind = "none" | "risk" | "gate" | "goal" | "must";

export type Item = {
  id: string; title: string; pw: number; milestone: string; gate: boolean; guard: string | null; must: boolean;
  owner: string | null; lever: Lever | null; slice_pw: number | null; cost: string | null; own: boolean;
};
export type Milestone = { code: string; name: string; wait_days: number; wait_name: string | null; wait_cost: string | null };
export type Plan = {
  start: string; engineers: number; focus: number; milestones: Milestone[]; items: Item[];
  milestone: string; target: string; focus_raise: number | null; focus_cost: string | null;
};
export type Move = [what: string, before: string | null, after: string | null];
export type Change = {
  id: string; lever: Lever; item: string; title: string; days: number; pw_saved: number;
  cost_kind: CostKind; cost: string; pickable: boolean; moves: Move[];
};
export type Schedule = { milestones: Record<string, string>; items: Record<string, string> };

export const HARM: Record<CostKind, number> = { none: 0, risk: 1, gate: 2, goal: 3, must: 9 };
const LEVER_COST: Record<Lever, CostKind> = { move: "goal", next_prd: "none", slice: "none", ungate: "gate", split: "none", overlap: "risk", capacity: "risk" };
export const LEVER_TITLE: Record<Lever, string> = {
  move: "Move after the date",
  next_prd: "Move to the next PRD",
  slice: "Ship only the slice the milestone needs",
  ungate: "Take off the gate, keep on the roadmap",
  split: "Split so a first slice lands early",
  overlap: "Overlap a calendar-only wait",
  capacity: "Raise focus time",
};

const DAY = 86400000;
export const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const gap = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

/** Python's round(x): to the nearest whole number, a tie to the even one. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

/** Python's round(x, 1): the number's exact value, a tie to the even tenth (a negative one as its size). */
export function round1(x: number): number {
  if (x < 0) return -round1(-x);
  const [whole, frac] = x.toFixed(60).split(".");
  const tenths = Number(whole) * 10 + Number(frac[0]);
  const rest = frac.slice(1);
  const up = rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || tenths % 2 === 1));
  return (tenths + (up ? 1 : 0)) / 10;
}

/** The mock's plan at a smaller goal's share of its own work, as the API's build_plan: each of the goal's
 * own unlocked items at that share, a tenth at least, to a tenth of a week; a slice half its whole weeks,
 * never more than the item. */
export function basePlan(share: number, target: string): Plan {
  const items: Item[] = raw.items.map((i) => {
    const r = i as typeof i & Partial<{ guard: string; must: boolean; owner: string; lever: Lever; cost: string; own: boolean }>;
    let pw = r.pw;
    if (share < 1 && r.own) pw = Math.max(round1(pw * share), round1(pw * 0.1), Math.min(pw, 0.1));
    const lever = r.lever ?? null;
    return {
      id: r.id, title: r.title, pw, milestone: r.milestone, gate: true, guard: r.guard ?? null, must: !!r.must,
      owner: r.owner ?? null, lever, cost: r.cost ?? null, own: !!r.own,
      slice_pw: lever === "slice" || lever === "split" ? Math.min(Math.ceil(pw) / 2, pw) : null,
    };
  });
  const milestones: Milestone[] = raw.milestones.map((m) => {
    const r = m as typeof m & Partial<{ wait_days: number; wait_name: string; wait_cost: string }>;
    return { code: r.code, name: r.name, wait_days: r.wait_days ?? 0, wait_name: r.wait_name ?? null, wait_cost: r.wait_cost ?? null };
  });
  return {
    start: raw.start, engineers: raw.engineers, focus: raw.focus, milestones, items, milestone: raw.milestone, target,
    focus_raise: raw.focus_raise, focus_cost: raw.focus_cost,
  };
}

export const PLAN_TARGET = raw.target;
export const PLAN_HARD_TARGET = raw.hard_target;

const days = (pw: number, capacity: number) => pyRound((pw / capacity) * 7);

/** The capacity queue: milestone order, each milestone's gated items before the ones it no longer
 * waits for; a milestone lands when its last gated item ends; a wait holds every later start. */
export function schedule(plan: Plan): Schedule {
  const capacity = plan.engineers * plan.focus;
  let load = 0;
  let held = 0;
  const ms: Record<string, string> = {};
  const ends: Record<string, string> = {};
  let last = plan.start;
  for (const m of plan.milestones) {
    held += m.wait_days;
    const mine = plan.items.filter((i) => i.milestone === m.code);
    for (const it of [...mine.filter((i) => i.gate), ...mine.filter((i) => !i.gate)]) {
      load += it.pw;
      ends[it.id] = addDays(plan.start, days(load, capacity) + held);
      if (it.gate) last = ends[it.id];
    }
    const before = Object.values(ms);
    ms[m.code] = mine.some((i) => i.gate) ? last : before.length ? before.reduce((a, b) => (a > b ? a : b)) : plan.start;
  }
  return { milestones: ms, items: ends };
}

export function nextCode(plan: Plan, code: string): string | null {
  const codes = plan.milestones.map((m) => m.code);
  const i = codes.indexOf(code);
  return i + 1 < codes.length ? codes[i + 1] : null;
}

/** The plan with the picked changes in it (unknown, locked or must-include ids are ignored). */
export function apply(plan: Plan, ids: readonly string[]): Plan {
  const offered = new Map(levers(plan).map((c) => [c.id, c]));
  const items = [...plan.items];
  let milestones = [...plan.milestones];
  let focus = plan.focus;
  for (const cid of ids) {
    const c = offered.get(cid);
    if (!c || !c.pickable) continue;
    if (c.lever === "capacity") {
      focus = plan.focus_raise || focus;
      continue;
    }
    if (c.lever === "overlap") {
      const code = cid.replace(/^wait:/, "");
      milestones = milestones.map((m) => (m.code === code ? { ...m, wait_days: 0 } : m));
      continue;
    }
    const idx = items.findIndex((it) => it.id === cid);
    const it = items[idx];
    const after = nextCode(plan, it.milestone);
    if (c.lever === "next_prd") items.splice(idx, 1);
    else if (c.lever === "move") {
      items.splice(idx, 1);
      items.push({ ...it, milestone: after ?? it.milestone, gate: after !== null });
    } else if (c.lever === "ungate") items[idx] = { ...it, gate: false };
    else if (c.lever === "slice") items[idx] = { ...it, pw: it.slice_pw || it.pw };
    else if (c.lever === "split") {
      const first = it.slice_pw || it.pw;
      items[idx] = { ...it, pw: first };
      if (after && it.pw > first) items.push({ ...it, id: `${it.id}:2`, pw: it.pw - first, milestone: after });
    }
  }
  return { ...plan, items, milestones, focus };
}

/** Every change Oracle may offer, unranked and unmeasured. */
export function levers(plan: Plan): Change[] {
  const out: Change[] = [];
  const asked = plan.milestone;
  const codes = plan.milestones.map((m) => m.code);
  for (const it of plan.items) {
    if (it.milestone !== asked || !it.gate || it.guard) continue;
    // Its slice is the whole item: slicing it saves nothing.
    if ((it.lever === "slice" || it.lever === "split") && it.slice_pw != null && it.slice_pw >= it.pw) continue;
    const lever: Lever = it.lever ?? "move";
    out.push({ id: it.id, lever, item: it.title, title: LEVER_TITLE[lever], days: 0, pw_saved: 0, cost_kind: it.must ? "must" : LEVER_COST[lever], cost: it.cost ?? "", pickable: !it.must, moves: [] });
  }
  for (const m of plan.milestones.slice(0, codes.indexOf(asked) + 1))
    if (m.wait_days > 0)
      out.push({ id: `wait:${m.code}`, lever: "overlap", item: m.wait_name ?? `${m.code} ${m.wait_days}-day wait`, title: LEVER_TITLE.overlap, days: 0, pw_saved: 0, cost_kind: "risk", cost: m.wait_cost ?? "", pickable: true, moves: [] });
  if (plan.focus_raise && plan.focus_raise > plan.focus)
    out.push({
      id: "focus", lever: "capacity", item: `Team focus ${pyRound(plan.focus * 100)}% to ${pyRound(plan.focus_raise * 100)}%`, title: LEVER_TITLE.capacity,
      days: 0, pw_saved: 0, cost_kind: "risk", cost: plan.focus_cost ?? "", pickable: true, moves: [],
    });
  return out;
}

const gated = (p: Plan, code: string) => p.items.filter((i) => i.milestone === code && i.gate).reduce((t, i) => t + i.pw, 0);
export const pwSaved = (plan: Plan, after: Plan) => round1(gated(plan, plan.milestone) - gated(after, plan.milestone));
export const dateOf = (plan: Plan, picks: readonly string[] = []) => schedule(apply(plan, picks)).milestones[plan.milestone];

export type Answer = { today: string; changes: Change[]; pick: string[]; pick_date: string; best_date: string; reachable: boolean; locked: [Item, boolean][] };

/** Oracle's answer: each change measured alone, ranked strictly by days saved for the least harm, Oracle's
 * pick, the best date and the locked items with whether cutting one would have reached the target. */
export function answer(plan: Plan): Answer {
  const base = schedule(plan);
  const today = base.milestones[plan.milestone];
  const measured = levers(plan).map((c) => {
    const afterPlan = c.pickable
      ? apply(plan, [c.id])
      : { ...plan, items: plan.items.map((i) => (i.id === c.id ? { ...i, milestone: nextCode(plan, i.milestone) ?? i.milestone } : i)) };
    const after = schedule(afterPlan);
    const moves: Move[] = plan.milestones
      .filter((m) => base.milestones[m.code] !== after.milestones[m.code])
      .map((m) => [m.name, base.milestones[m.code], after.milestones[m.code]]);
    return { ...c, days: gap(today, after.milestones[plan.milestone]), pw_saved: pwSaved(plan, afterPlan), moves };
  });
  // Python's sort on (-days, harm, item) compares the item's text by code point.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const ranked = [...measured].sort((x, y) => y.days - x.days || HARM[x.cost_kind] - HARM[y.cost_kind] || cmp(x.item, y.item));
  const pickable = ranked.filter((c) => c.pickable && c.days > 0).map((c) => c.id);
  const best = dateOf(plan, pickable);
  const reachable = best <= plan.target;
  let pick: string[] = [];
  if (reachable) {
    for (const cid of pickable) {
      if (dateOf(plan, pick) <= plan.target) break;
      pick.push(cid);
    }
    const harm = (id: string) => HARM[ranked.find((c) => c.id === id)!.cost_kind];
    const byHarm = [...pick].sort((a, b) => harm(b) - harm(a));
    for (const cid of byHarm) {
      const rest = pick.filter((p) => p !== cid);
      if (dateOf(plan, rest) <= plan.target) pick = rest;
    }
  } else pick = pickable;
  const all = apply(plan, pickable);
  const locked: [Item, boolean][] = plan.items
    .filter((it) => it.guard && it.milestone === plan.milestone)
    .map((it) => [it, schedule({ ...all, items: all.items.filter((i) => i.id !== it.id) }).milestones[plan.milestone] <= plan.target]);
  return { today, changes: ranked, pick, pick_date: dateOf(plan, pick), best_date: best, reachable, locked };
}

export type Draft = { prd: [string, string][]; dates: Move[]; new_target: string | null; needs_estimate: Item[]; plan: Plan };

const PRD_WORDS: Record<Lever, string> = {
  move: "Moved to the next milestone",
  next_prd: "Moved to the next PRD",
  slice: "First slice only in this milestone",
  ungate: "No longer holds the milestone; still built",
  split: "First slice in this milestone; the rest after it",
  overlap: "Work starts during the wait",
  capacity: "Focus time raised",
};

/** The re-plan the picks write: what changes in the PRD, every date that moves (the target too when no
 * set reaches it) and the sliced or split items, which need a new estimate. */
export function draft(plan: Plan, picks: readonly string[]): Draft {
  const offered = new Map(levers(plan).filter((c) => c.pickable).map((c) => [c.id, c]));
  const picked = picks.filter((p) => offered.has(p)).map((p) => offered.get(p)!);
  const next = apply(plan, picked.map((c) => c.id));
  const before = schedule(plan);
  const after = schedule(next);
  const prd: [string, string][] = picked.map((c) => [c.item, PRD_WORDS[c.lever]]);
  const dates: Move[] = [];
  const newDate = after.milestones[plan.milestone];
  const newTarget = newDate > plan.target ? newDate : null;
  if (newTarget) dates.push(["Target", plan.target, newTarget]);
  for (const m of plan.milestones)
    if (before.milestones[m.code] !== after.milestones[m.code]) dates.push([m.name, before.milestones[m.code], after.milestones[m.code]]);
  const titles = new Map(plan.items.map((i) => [i.id, i.title]));
  for (const [id, end] of Object.entries(before.items)) {
    const to = after.items[id] ?? null;
    if (to !== end) dates.push([titles.get(id)!, end, to]);
  }
  const resized = new Set(picked.filter((c) => c.lever === "slice" || c.lever === "split").map((c) => c.id));
  return { prd, dates, new_target: newTarget, needs_estimate: plan.items.filter((i) => resized.has(i.id)), plan: next };
}
