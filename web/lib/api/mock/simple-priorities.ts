/**
 * Simple S6 (#723): GET /v1/simple/priorities, as api/oracle/simple/priorities.py serves it,
 * over the mock's company-wide roadmap (./simple-roadmap.ts): each visible item stands for
 * its baseline feature, with an invented goal value and effort.
 *
 * Oracle's order is the goal_weighted ranking (oracle.priorities.scoring): rows serving a
 * goal first, by score = goal value x confidence / effort; then those serving none (flagged);
 * a prerequisite moves up to just before its highest-ranked dependent. People's pins
 * (`override_priority` changes, ./simple-changes.ts) apply after the formula, never above a
 * dependency. `estimate_feature` writes a person's goal value or effort, which the score uses.
 */
import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { roadmapOut, type SimpleDb } from "./simple-roadmap";
import { flowFor } from "./simple-visuals";

type Row = Schemas["SimplePriorityRow"];
type Item = Schemas["SimpleRoadmapItem"];
type Role = Schemas["Me"]["role"];
type Values = Record<string, unknown>;

export interface PrioritiesCtx {
  id: string;
  role: Role;
  owners: string[];
  names: Record<string, string>;
  roles?: Record<string, Role>;
}

/** Each item's feature: Oracle's goal value (Σ goal weight x contribution) and effort in weeks. */
const FEATURES: Record<string, { value: number; effort: number }> = {
  "alert-rules": { value: 6, effort: 4 },
  "alert-digest": { value: 5, effort: 2 },
  "alert-mobile": { value: 4, effort: 3 },
  "alert-export": { value: 0, effort: 1 },
  "alert-sso": { value: 3, effort: 2 },
  "setup-checklist": { value: 4, effort: 2 },
  "setup-import": { value: 6, effort: 3 },
  "setup-video": { value: 0, effort: 1 },
  "price-tiers": { value: 0, effort: 3 },
};
const CONFIDENCE: Record<string, number> = { high: 0.8, medium: 0.5, low: 0.3 };

const round = (n: number): number => Math.round(n * 1000) / 1000;
const featureId = (itemId: string): string => `feature-${itemId}`;

function quarter(today: string): Schemas["SimpleQuarter"] {
  const d = new Date(`${today}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3);
  const start = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0)).toISOString().slice(0, 10);
  return { start, end, label: `Q${q + 1} ${d.getUTCFullYear()}` };
}

/** The values stored for an item's non-versioned targets (./simple-changes.ts `db.targets`). */
function stored(db: SimpleDb, itemId: string): Values {
  return db.targets?.[itemId] ?? {};
}

/** A person's estimates, else the feature's: [goal value, effort, whether the value is a person's]. */
export function estimates(db: SimpleDb, key: string, itemId: string): { value: number; effort: number; valueEstimated: boolean } {
  const f = FEATURES[key] ?? { value: 0, effort: 1 };
  const s = stored(db, itemId);
  return {
    value: typeof s.goal_value === "number" ? s.goal_value : f.value,
    effort: typeof s.effort === "number" ? s.effort : f.effort,
    valueEstimated: typeof s.goal_value === "number",
  };
}

/** targets.py's `before` of estimate_feature and override_priority, as stored now. */
export function priorityBefore(db: SimpleDb, key: string, op: string, itemId: string): Values {
  if (op === "estimate_feature") {
    const s = stored(db, itemId);
    return { goal_value: typeof s.goal_value === "number" ? s.goal_value : null, effort: estimates(db, key, itemId).effort };
  }
  return { override: (stored(db, itemId).override as Values | undefined) ?? null };
}

/** targets.py's stored `after` of the two ops (a pin at a rank; the estimates rounded). */
export function priorityAfter(op: string, after: Values): Values | string {
  if (op === "override_priority") {
    const pos = after.position;
    const reason = String(after.reason ?? "").trim();
    if (typeof pos !== "number" || pos < 1) return "after.position: a rank from 1 (the top)";
    if (!reason || /[\r\n]/.test(reason)) return "after.reason: why, in one line of 1 to 500 characters";
    return { override: { kind: "pin", position: pos, above_feature_id: null, reason } };
  }
  const out: Values = {};
  for (const k of ["goal_value", "effort"]) {
    if (!(k in after)) continue;
    const v = Number(after[k]);
    if (!(v > 0)) return `after.${k}: a number above 0`;
    out[k] = Math.round(v * 10) / 10;
  }
  return Object.keys(out).length ? out : "after: goal_value or effort";
}

function depsOf(item: Item, byId: Map<string, Item>): string[] {
  return item.depends_on.filter((d) => byId.has(d));
}

/** scoring.dependency order: a prerequisite moves up to just before its highest-ranked dependent. */
function dependencyOrder(sorted: Item[], byId: Map<string, Item>): Item[] {
  const out: Item[] = [];
  const placed = new Set<string>();
  const place = (i: Item, stack: Set<string>) => {
    if (placed.has(i.id) || stack.has(i.id)) return;
    stack.add(i.id);
    for (const d of depsOf(i, byId)) place(byId.get(d)!, stack);
    placed.add(i.id);
    out.push(i);
  };
  for (const i of sorted) place(i, new Set());
  return out;
}

function ancestors(id: string, byId: Map<string, Item>, seen = new Set<string>()): Set<string> {
  for (const d of depsOf(byId.get(id)!, byId)) {
    if (seen.has(d)) continue;
    seen.add(d);
    ancestors(d, byId, seen);
  }
  return seen;
}

/** The latest override_priority change that holds for this item (applied or accepted, not undone). */
function activeOverride(db: SimpleDb, itemId: string): Schemas["SimpleChangeOut"] | undefined {
  const cs = db.changes ?? [];
  return cs
    .filter((c) => c.op === "override_priority" && c.target.item_id === itemId && ["applied", "accepted"].includes(c.status) && !cs.some((u) => u.undoes_id === c.id))
    .sort((a, b) => ((a.decided_at ?? a.at) < (b.decided_at ?? b.at) ? -1 : 1))
    .at(-1);
}

export function prioritiesOut(
  db: SimpleDb,
  ctx: PrioritiesCtx,
  route: (c: Schemas["SimpleChangeOut"]) => string[],
  decides: (itemId: string) => boolean,
): Schemas["SimplePrioritiesOut"] {
  const today = new Date(mockNowMs()).toISOString().slice(0, 10);
  const read = roadmapOut(db, ctx.role, new URLSearchParams(), { id: ctx.id, role: ctx.role })!;
  // A cut draft reads as "draft" on the roadmap: the seed says it is cut (as the API's cut set).
  const cut = new Set(db.items.filter((s) => s.status === "cut").map((s) => s.key));
  const live = read.items.filter((i) => i.status !== "cut" && !cut.has(i.key));
  // Every feature ranks (the baseline is company-wide); one whose item the reader may not see
  // is a row with no item, never reorderable (priorities.py).
  const seen = new Set(read.items.map((i) => i.id));
  const all = roadmapOut(db, "owner", new URLSearchParams())!.items.filter((i) => i.status !== "cut" && !cut.has(i.key));
  // A draft item is never ranked (priorities.py `_items`): it sits under "Not ranked yet", with no
  // row and no bucket weeks. Here each item stands for its own feature, so a draft has no row at all.
  const ranked = all.filter((i) => !i.draft);
  const byId = new Map(ranked.map((i) => [i.id, i]));
  const keyOf = (i: Item) => i.key;
  const score = new Map<string, number>();
  for (const i of ranked) {
    const e = estimates(db, keyOf(i), i.id);
    score.set(i.id, round((e.value * (CONFIDENCE[i.confidence ?? ""] ?? 0.5)) / e.effort));
  }
  const sorted = [...ranked].sort((a, b) => Number(!a.goal) - Number(!b.goal) || score.get(b.id)! - score.get(a.id)! || a.title.localeCompare(b.title));
  const oracle = dependencyOrder(sorted, byId);
  const oracleRank = new Map(oracle.map((i, n) => [i.id, n + 1]));
  // People's pins, oldest first; never above a dependency.
  let yours = [...oracle];
  const pins = ranked
    .map((i) => ({ i, c: activeOverride(db, i.id) }))
    .filter((x) => x.c)
    .sort((a, b) => ((a.c!.decided_at ?? a.c!.at) < (b.c!.decided_at ?? b.c!.at) ? -1 : 1));
  for (const { i, c } of pins) {
    const pos = Number((c!.after.override as Values).position);
    yours = yours.filter((x) => x.id !== i.id);
    yours.splice(Math.min(pos - 1, yours.length), 0, i);
  }
  yours = dependencyOrder(yours, byId);
  const can = ctx.role !== "viewer";
  const rows: Row[] = yours.map((i, n) => {
    const e = estimates(db, keyOf(i), i.id);
    const above = yours.slice(0, n);
    let after: Row["after"] = null;
    if (above.some((a) => score.get(a.id)! < score.get(i.id)!)) {
      const anc = ancestors(i.id, byId);
      const dep = [...above].reverse().find((a) => anc.has(a.id));
      if (dep) after = { code: dep.key, title: dep.title };
    }
    const o = activeOverride(db, i.id);
    const mine = seen.has(i.id);
    return {
      rank: n + 1,
      oracle_rank: oracleRank.get(i.id) ?? null,
      feature_id: featureId(i.id),
      item_id: mine ? i.id : null,
      code: i.key,
      title: i.title,
      goal: i.goal ? { key: i.goal.key, title: i.goal.title } : null,
      milestone: mine ? (i.milestone?.name ?? null) : null,
      horizon: mine ? i.horizon : null,
      goal_value: e.value,
      effort: e.effort,
      score: score.get(i.id)!,
      value_estimated: e.valueEstimated,
      depends_on: depsOf(i, byId).map((d) => byId.get(d)!.key),
      after,
      override: o ? { by_name: o.by_name, reason: String((o.after.override as Values).reason), at: o.decided_at ?? o.at } : null,
      above_line: mine && i.horizon === "now",
      no_goal: !i.goal,
      can_reorder: can && mine,
      applies: mine && decides(i.id),
      before_override: (stored(db, i.id).override as Record<string, unknown> | undefined) ?? null,
    };
  });
  const codes = new Map(read.items.map((i) => [i.id, i]));
  const proposals: Schemas["SimplePriorityProposal"][] = (db.changes ?? [])
    // Ranking proposals, and a draft's Confirm or Merge (a cut), as priorities.py.
    .filter((c) => c.status === "proposed" && codes.has(String(c.target.item_id)))
    .filter((c) => c.op === "override_priority" || c.op === "estimate_feature" || ((c.op === "confirm_item" || c.op === "cut") && codes.get(String(c.target.item_id))!.draft))
    .filter((c) => ctx.role === "owner" || c.by === ctx.id || route(c).includes(ctx.id))
    .map((c) => {
      const i = codes.get(String(c.target.item_id))!;
      return {
        change_id: c.id, op: c.op as Schemas["SimplePriorityProposal"]["op"], item_id: i.id, feature_id: featureId(i.id), code: i.key, title: i.title, by_name: c.by_name, at: c.at, reason: c.reason,
        after: c.after, waiting_for: route(c).map((p) => ctx.names[p] ?? "someone"), can_decide: decides(i.id), flow: flowFor(db.visuals, "change", c.id) ?? flowFor(db.visuals, "feature", i.id),
      };
    });
  const drafts: Schemas["SimplePriorityDraft"][] = live
    .filter((i) => i.draft)
    .map((i) => ({
      item_id: i.id, code: i.key, title: i.title, goal: i.goal ? { key: i.goal.key, title: i.goal.title } : null, roadmap: i.roadmap, applies: decides(i.id),
      merge_into: ranked
        .filter((x) => seen.has(x.id))
        .filter((x) => x.roadmap.id === i.roadmap.id)
        .sort((a, b) => Number(a.goal?.key !== i.goal?.key) - Number(b.goal?.key !== i.goal?.key) || a.key.localeCompare(b.key))
        .slice(0, 8)
        .map((x) => ({ item_id: x.id, code: x.key, title: x.title })),
    }));
  const buckets: Schemas["SimpleGoalBucket"][] = [];
  for (const r of rows) {
    const key = r.goal?.key ?? "none";
    let b = buckets.find((x) => x.key === key);
    if (!b) buckets.push((b = { key, title: r.goal?.title ?? "No goal", weeks: 0, share: 0, codes: [], no_goal: !r.goal }));
    if (r.horizon === "now" && r.item_id) {
      b.weeks = round(b.weeks + (r.effort ?? 0));
      b.codes.push(r.code);
    }
  }
  buckets.sort((a, b) => Number(a.no_goal) - Number(b.no_goal));
  const total = round(buckets.reduce((s, b) => s + b.weeks, 0));
  for (const b of buckets) b.share = total ? round(b.weeks / total) : 0;
  return {
    today, quarter: quarter(today), method: "goal_weighted",
    formula: "score = Σ(goal weight × contribution) × confidence × track record ÷ effort",
    rows, proposals, drafts, buckets, weeks_total: total, can_change: can,
  };
}
