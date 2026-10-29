/**
 * Mock API for priorities, templates, themes and the new-draft picker (mock mode only).
 * Fixtures are generic and fictional: this repository is public. The rules mirror the
 * API (api/oracle/priorities/scoring.py, api/oracle/templates/*) closely enough for the
 * UI to be exercised; the API stays the reference.
 */
import type { Schemas } from "@/lib/api/client";
import { plainText } from "@/lib/markdown";
import { presenterNotes, resolveBrief } from "./brief";
import { mockUuid, seeded } from "./ids";
import { calibration } from "./quality";
import { cannotApproveNow } from "./runs";

import type { Db, DocumentRow, VersionRow } from "./server";

type Method = Schemas["PriorityRanking"]["method"];
type Kind = "prd" | "roadmap";
type ThemeKind = Schemas["ThemeOut"]["kind"];
type Tokens = Schemas["ThemeTokens"];
type Problem = Schemas["Problem"];

type TemplateRow = Omit<Schemas["TemplateOut"], "latest_version" | "suggested_theme" | "suggest_when">;
type ThemeRow = Schemas["ThemeOut"];
type SnapshotRow = Schemas["PrioritySnapshotOut"];
type OverrideRow = Schemas["OverrideOut"];
type PushbackMessage = Schemas["PushbackMessage"];
/** One reading of a reason, as the API's priority_override.reason_checked audit event. */
type ReasonCheckRow = {
  by: string;
  feature: string;
  reason: string;
  status: Schemas["ReasonCheckOut"]["status"];
  ms: number;
  evidence: Schemas["EvidenceChip"][];
  at: string;
};

export interface LaneFState {
  templates: TemplateRow[];
  themes: ThemeRow[];
  snapshots: SnapshotRow[];
  defaults: Schemas["DraftDefaults"];
  /** People's moves and pins (C9), newest last; absent in data saved before them. */
  overrides?: OverrideRow[];
  reason_checks?: ReasonCheckRow[];
}

const SEEDED_AT = "2026-10-01T09:00:00Z";
const now = () => new Date().toISOString();

const uuid = mockUuid;

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const notFound = (what: string) => json(404, { detail: `${what} not found` });

// ---------------------------------------------------------------- priorities

const FORMULAS: Record<Method, string> = {
  goal_weighted: "score = Σ(goal weight × contribution) × confidence × track record ÷ effort",
  rice: "score = reach × impact × confidence ÷ effort",
  moscow: "rank = must (4) > should (3) > could (2) > won't (1); ties by goal value",
  wsjf: "score = (business value + time criticality + risk reduction) ÷ job size",
};
const METHODS = Object.keys(FORMULAS) as Method[];
const MOSCOW: Record<string, number> = { must: 4, should: 3, could: 2, wont: 1, "won't": 1 };

type GoalLink = { goal: string; title: string; weight: number | null; contribution: number | null };
type FeatureSeed = {
  key: string;
  title: string;
  status: string;
  goals: GoalLink[];
  attrs: Record<string, number | string>;
  evidence: { id: string; confidence: number; ref: string; title: string; source_kind: string; date: string }[];
  depends_on: string[];
};

// The baseline's goals (./baseline.ts), by key; GET /v1/priorities titles them as the baseline does now.
const G1 = "Raise activation";
const G2 = "Grow paid conversion";

const FEATURES: FeatureSeed[] = [
  {
    key: "F-1",
    title: "Saved addresses at checkout",
    status: "confirmed",
    goals: [{ goal: "g.activation", title: G1, weight: 3, contribution: 2 }],
    attrs: { effort: 2, reach: 4000, impact: 2, business_value: 8, time_criticality: 5, risk_reduction: 3, job_size: 3, moscow: "must" },
    evidence: [
      { id: "ev-1", confidence: 0.8, ref: "https://example.com/research/interview-07", title: "Interview 07", source_kind: "upload", date: "2026-09-12" },
      { id: "ev-2", confidence: 0.7, ref: "https://example.com/analytics/funnel-september", title: "Funnel, September", source_kind: "google_docs", date: "2026-10-01" },
      // Five more at the mean (0.75), so the feature's confidence stays as it was.
      { id: "ev-5", confidence: 0.75, ref: "https://example.com/support/thread-1182", title: "Support thread 1182", source_kind: "slack", date: "2026-09-20" },
      { id: "ev-6", confidence: 0.75, ref: "interview-11.md", title: "Interview 11", source_kind: "upload", date: "2026-09-25" },
      // A source titled by its ref, as the API cites a pull request (prod-5).
      { id: "ev-7", confidence: 0.75, ref: "https://example.com/tracker/pull-920", title: "svc-backend#920", source_kind: "github:pull_request", date: "2026-09-28" },
      { id: "ev-8", confidence: 0.75, ref: "https://example.com/calls/review-0930", title: "Call review, 30 September", source_kind: "fireflies", date: "2026-09-30" },
      { id: "ev-9", confidence: 0.75, ref: "https://example.com/research/survey-q3-open", title: "Survey Q3, open answers", source_kind: "notion", date: "2026-10-03" },
    ],
    depends_on: [],
  },
  {
    key: "F-2",
    title: "Shipping cost shown in the cart",
    status: "confirmed",
    goals: [{ goal: "g.activation", title: G1, weight: 3, contribution: 3 }],
    attrs: { effort: 1, reach: 6000, impact: 1, business_value: 5, time_criticality: 8, risk_reduction: 2, job_size: 2, moscow: "should" },
    evidence: [{ id: "ev-3", confidence: 0.9, ref: "https://example.com/research/survey-q3", title: "Survey Q3", source_kind: "notion", date: "2026-09-15" }],
    depends_on: ["F-5"],
  },
  {
    key: "F-3",
    title: "Shared projects",
    status: "proposed",
    goals: [{ goal: "g.paid-conversion", title: G2, weight: null, contribution: null }],
    attrs: { effort: 4, reach: 1500, impact: 3, business_value: 9, time_criticality: 3, risk_reduction: 5, job_size: 8, moscow: "could" },
    evidence: [],
    depends_on: [],
  },
  {
    key: "F-4",
    title: "Usage alerts",
    status: "proposed",
    goals: [{ goal: "g.paid-conversion", title: G2, weight: 2, contribution: 1 }],
    attrs: { effort: 1, impact: 1, confidence: "low", business_value: 3, time_criticality: 2, risk_reduction: 1, job_size: 1, moscow: "should" },
    evidence: [],
    depends_on: [],
  },
  {
    key: "F-5",
    title: "Address lookup service",
    status: "confirmed",
    goals: [{ goal: "g.activation", title: G1, weight: 3, contribution: 1 }],
    attrs: { effort: 3, reach: 6000, impact: 0.5, business_value: 3, time_criticality: 3, risk_reduction: 3, job_size: 5, moscow: "could" },
    evidence: [{ id: "ev-4", confidence: 0.6, ref: "https://example.com/tracker/issue-412", title: "Issue 412", source_kind: "github", date: "2026-08-30" }],
    depends_on: [],
  },
  {
    key: "F-6",
    title: "Dark mode",
    status: "proposed",
    goals: [],
    attrs: { effort: 1, reach: 2000, impact: 0.5, confidence: 0.6, business_value: 2, time_criticality: 1, risk_reduction: 1, job_size: 1, moscow: "could" },
    evidence: [],
    depends_on: [],
  },
  {
    key: "F-7",
    title: "Bulk export",
    status: "proposed",
    goals: [{ goal: "g.paid-conversion", title: G2, weight: 2, contribution: 2 }],
    attrs: { effort: 2, reach: 800, impact: 2, confidence: 0.5, business_value: 4, time_criticality: 2, risk_reduction: 2, job_size: 3, moscow: "should" },
    evidence: [],
    depends_on: ["F-8"],
  },
  {
    key: "F-8",
    title: "Scheduled exports",
    status: "proposed",
    goals: [{ goal: "g.paid-conversion", title: G2, weight: 2, contribution: 1 }],
    attrs: { effort: 3, reach: 500, impact: 1, confidence: 0.5, business_value: 3, time_criticality: 1, risk_reduction: 1, job_size: 3, moscow: "could" },
    evidence: [],
    depends_on: ["F-7"],
  },
];

const round = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

function confidenceOf(f: FeatureSeed): Schemas["ConfidenceUsed"] {
  if (f.evidence.length) {
    const value = round(f.evidence.reduce((s, e) => s + e.confidence, 0) / f.evidence.length);
    return {
      value,
      source: "evidence",
      explain: `mean confidence of ${f.evidence.length} evidence item(s): ${value}`,
      evidence: f.evidence.map((e) => ({ ...e, source_removed: false })),
    };
  }
  const raw = f.attrs.confidence;
  const words: Record<string, number> = { high: 0.8, medium: 0.5, low: 0.3 };
  const value = typeof raw === "string" && raw in words ? words[raw] : num(raw);
  if (value != null) {
    return { value, source: "attrs", explain: `attrs.confidence = ${raw}: ${value}`, evidence: [] };
  }
  return { value: 0.5, source: "default", explain: "no evidence and no attrs.confidence: assumed 0.5", evidence: [] };
}

type Scored = Omit<Schemas["RankedFeature"], "rank" | "score_rank" | "dependents"> & {
  /** 0 scored, 1 unscored, 2 serves no goal: the ranking groups, in order. */
  group: number;
  /** Score used for ordering (MoSCoW keeps its goal-value tie-break here). */
  order_score: number;
};

/** H3: the track record factor a feature's goals carry (by goal title), or the company's. */
type TrackRecord = Schemas["CalibrationOut"] | null;

function trackFactor(f: FeatureSeed, cal: TrackRecord): Schemas["CalibrationUsed"] | null {
  if (!cal || !f.goals.length) return null;
  let best: Schemas["CalibrationUsed"] | null = null;
  for (const g of f.goals) {
    const own = cal.goals.find((x) => x.title === g.title && x.factor != null);
    const fig = own ?? (cal.company.factor != null ? cal.company : null);
    if (!fig || fig.factor == null) continue;
    const label = own ? `Goal '${own.title}'` : "Company";
    const found = {
      factor: fig.factor, applied: cal.setting === "apply", n: fig.n,
      basis: `${label}: ${fig.held} of ${fig.n} assessed predictions held (expected ${fig.expected})`,
    };
    if (!best || found.factor < best.factor) best = found;
  }
  return best;
}

function scoreFeature(f: FeatureSeed, method: Method, cal: TrackRecord = null): Scored {
  const flags: string[] = [];
  const servesGoal = f.goals.length > 0;
  if (!servesGoal) flags.push("no_confirmed_goal");
  const terms = f.goals.map((g) => {
    const weight = g.weight ?? 1;
    const contribution = g.contribution ?? 1;
    return {
      goal: g.goal,
      title: g.title,
      weight,
      weight_assumed: g.weight == null,
      contribution,
      contribution_assumed: g.contribution == null,
      link_status: "confirmed",
      term: round(weight * contribution),
    };
  });
  const value = terms.reduce((s, t) => s + (t.term ?? 0), 0);
  const track = trackFactor(f, cal);
  const confidence = confidenceOf(f);
  if (track?.applied) {
    confidence.before_track_record = confidence.value;
    confidence.value = round(confidence.value * track.factor);
  }
  if (confidence.source === "default") flags.push("no_confidence");
  else if (confidence.value < 0.4) flags.push("low_confidence");
  const inputs: Record<string, unknown> = {};
  const missing: string[] = [];
  const steps: string[] = [];
  let score: number | null = null;
  const need = (label: string, positive = false) => {
    const v = num(f.attrs[label]);
    inputs[label] = { value: v, attr: label, raw: f.attrs[label] ?? null };
    if (v == null || (positive && v <= 0)) {
      missing.push(label);
      return null;
    }
    return v;
  };
  const c = confidence.value;
  if (track?.applied) steps.push(`confidence = ${confidence.before_track_record} × track record ${track.factor} = ${c}`);
  if (method === "goal_weighted") {
    const effort = need("effort", true);
    inputs.goal_value = { value: round(value), terms };
    steps.push(
      "goal value = " +
        (terms.map((t) => `${t.weight}×${t.contribution} (${t.goal})`).join(" + ") || "0") +
        ` = ${round(value)}`,
    );
    if (effort != null) {
      score = (value * c) / effort;
      steps.push(`score = ${round(value)} × ${c} ÷ ${effort} = ${round(score)}`);
    }
  } else if (method === "rice") {
    const reach = need("reach");
    const impact = need("impact");
    const effort = need("effort", true);
    if (reach != null && impact != null && effort != null) {
      score = (reach * impact * c) / effort;
      steps.push(`score = ${reach} × ${impact} × ${c} ÷ ${effort} = ${round(score)}`);
    }
  } else if (method === "wsjf") {
    const bv = need("business_value");
    const tc = need("time_criticality");
    const rr = need("risk_reduction");
    const size = need("job_size", true);
    if (bv != null && tc != null && rr != null && size != null) {
      const cod = bv + tc + rr;
      score = cod / size;
      steps.push(`cost of delay = ${bv} + ${tc} + ${rr} = ${cod}`);
      steps.push(`score = ${cod} ÷ ${size} = ${round(score)}`);
    }
  } else {
    const raw = f.attrs.moscow;
    const category = typeof raw === "string" ? raw.toLowerCase() : null;
    const rank = category ? MOSCOW[category] : undefined;
    inputs.moscow = { value: category, attr: "moscow", raw: raw ?? null };
    inputs.goal_value = { value: round(value), terms };
    if (rank == null) missing.push("moscow");
    else {
      score = rank + value / 1000;
      steps.push(`${category} = ${rank}; tie-break goal value ${round(value)}`);
    }
  }
  if (missing.length) {
    flags.push("missing_inputs");
    steps.push("not scored: missing " + missing.join(", "));
  }
  return {
    entity_id: `00000000-0000-4000-8000-${hash(f.key).padStart(12, "0")}`,
    key: f.key,
    title: f.title,
    status: f.status,
    score: score == null ? null : round(method === "moscow" ? Math.floor(score) : score),
    serves_goal: servesGoal,
    flags,
    depends_on: f.depends_on,
    explanation: { method, formula: FORMULAS[method], inputs, confidence, calibration: track, goals: terms, missing, steps, order: [] },
    group: !servesGoal ? 2 : score != null ? 0 : 1,
    order_score: score ?? -Infinity,
  };
}

/** Strongly connected components with more than one member (Tarjan). */
function findCycles(deps: Record<string, string[]>): string[][] {
  let index = 0;
  const idx: Record<string, number> = {};
  const low: Record<string, number> = {};
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx[v] = low[v] = index++;
    stack.push(v);
    on.add(v);
    for (const w of deps[v] ?? []) {
      if (!(w in deps)) continue;
      if (!(w in idx)) {
        visit(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (on.has(w)) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of Object.keys(deps)) if (!(v in idx)) visit(v);
  return out;
}

export function ranking(method: Method, cal: TrackRecord = null): Schemas["PriorityRanking"] {
  const scored = FEATURES.map((f) => scoreFeature(f, method, cal));
  const byScore = [...scored].sort(
    (a, b) => a.group - b.group || b.order_score - a.order_score || a.key.localeCompare(b.key),
  );
  const scoreRank = Object.fromEntries(byScore.map((s, i) => [s.key, i + 1]));
  const deps = Object.fromEntries(scored.map((s) => [s.key, s.depends_on]));
  const cycles = findCycles(deps);
  const inCycle = new Set(cycles.flat());
  for (const s of scored) if (inCycle.has(s.key)) s.flags.push("dependency_cycle");
  const dependents: Record<string, string[]> = Object.fromEntries(scored.map((s) => [s.key, []]));
  for (const s of scored) for (const d of s.depends_on) dependents[d]?.push(s.key);

  // Dependency order: repeatedly place the best-scored feature whose prerequisites
  // (outside its own cycle) are already placed; a prerequisite inherits its
  // dependent's position.
  const placed: string[] = [];
  const effective: Record<string, number> = { ...scoreRank };
  const lift = (k: string, r: number, seen = new Set<string>()) => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const d of deps[k] ?? []) {
      if (effective[d] > r) effective[d] = r;
      lift(d, r, seen);
    }
  };
  for (const s of byScore) lift(s.key, effective[s.key]);
  const ready = (k: string) =>
    (deps[k] ?? []).every((d) => placed.includes(d) || (inCycle.has(d) && inCycle.has(k)) || !(d in deps));
  while (placed.length < scored.length) {
    const next = [...byScore]
      .filter((s) => !placed.includes(s.key) && ready(s.key))
      .sort((a, b) => effective[a.key] - effective[b.key] || scoreRank[a.key] - scoreRank[b.key])[0];
    placed.push((next ?? byScore.find((s) => !placed.includes(s.key))!).key);
  }

  const features = placed.map((k, i) => {
    const s = scored.find((x) => x.key === k)!;
    const position = i + 1;
    const order: string[] = [];
    if (position < scoreRank[k]) {
      const neededBy = dependents[k].filter((d) => scoreRank[d] < scoreRank[k]);
      if (neededBy.length) {
        order.push(`placed earlier because ${neededBy.sort().join(", ")} depend(s) on it`);
        s.flags.push("moved_for_dependency");
      }
    }
    const waiting = s.depends_on.filter((d) => scoreRank[d] > scoreRank[k]);
    if (waiting.length) order.push(`placed after its prerequisite(s) ${waiting.sort().join(", ")}`);
    const { group, order_score, ...rest } = s;
    void group;
    void order_score;
    return {
      ...rest,
      rank: position,
      score_rank: scoreRank[k],
      dependents: dependents[k].sort(),
      flags: [...new Set(s.flags)].sort(),
      explanation: { ...s.explanation, order },
    } satisfies Schemas["RankedFeature"];
  });
  return {
    method,
    formula: FORMULAS[method],
    generated_at: now(),
    features,
    cycles,
    counts: {
      features: features.length,
      no_goal: features.filter((f) => !f.serves_goal).length,
      unscored: features.filter((f) => f.score == null).length,
      in_cycles: inCycle.size,
    },
  };
}

// ---------------------------------------------------------------- overrides (C9 Move and pin)

const entityId = (key: string) => `00000000-0000-4000-8000-${hash(key).padStart(12, "0")}`;
const featureById = (id: string) => FEATURES.find((f) => entityId(f.key) === id);

/** The mock scenario (MOCK_SCENARIO_KEY) with one change from before a feature it moved above was retired. */
export const LEGACY_OVERRIDE_SCENARIO = "priority-legacy-override";

/**
 * A move stored while "Shipping carrier picker" was still a feature, kept after it was retired
 * (its key is no longer anyone's): the Changes log still has the API's own title for it, not
 * just its key.
 */
function legacyOverride(): OverrideRow {
  return {
    id: "00000000-0000-4000-8000-00000000f001",
    feature: { id: entityId("F-1"), key: "F-1", title: "Saved addresses at checkout" },
    kind: "move",
    above: { id: entityId("F-99"), key: "F-99", title: "Shipping carrier picker" },
    position: null,
    reason: "Checkout work came first while the carrier picker was still planned",
    evidence_ids: [],
    evidence: [],
    pushback: [],
    kept_after_pushback: false,
    reason_check: { status: "skipped", ms: null },
    snapshot_id: null,
    created_by: { id: "legacy", name: "Dana Decider" },
    created_at: "2026-09-01T09:00:00Z",
    removed_at: null,
    removed_by: null,
    removed_reason: null,
    replaced_by: null,
    no_longer_applies: false,
  };
}
type OverrideInput = {
  id: string;
  feature: string;
  kind: "move" | "pin";
  above: string | null;
  position: number | null;
  info: Omit<Schemas["RowOverride"], "id" | "kind"> | null;
};

/**
 * People's overrides after the formula, as the API's apply_overrides: in creation order a
 * move goes directly above its anchor and a pin at its rank (clamped); then a feature above
 * a prerequisite (outside its cycle) moves just below its lowest one, flagged
 * held_by_dependency. formula_rank keeps the rank before overrides.
 */
export function applyOverrides(r: Schemas["PriorityRanking"], overrides: OverrideInput[]): Schemas["PriorityRanking"] {
  const rows = new Map(r.features.map((f) => [f.key, f]));
  const order = r.features.map((f) => f.key);
  const applied = new Map<string, OverrideInput>();
  for (const o of overrides) {
    if (!rows.has(o.feature) || (o.kind === "move" && (!o.above || !rows.has(o.above) || o.above === o.feature))) continue;
    order.splice(order.indexOf(o.feature), 1);
    if (o.kind === "move") order.splice(order.indexOf(o.above!), 0, o.feature);
    else order.splice(Math.min(Math.max((o.position ?? 1) - 1, 0), order.length), 0, o.feature);
    applied.set(o.feature, o);
  }
  const cycleOf = new Map<string, number>();
  r.cycles.forEach((c, i) => c.forEach((k) => cycleOf.set(k, i)));
  const prerequisites = (k: string) =>
    rows.get(k)!.depends_on.filter((d) => rows.has(d) && !(cycleOf.has(k) && cycleOf.get(d) === cycleOf.get(k)));
  const held = new Map<string, string>();
  for (let pass = 0; pass <= order.length; pass++) {
    let moved = false;
    for (const k of [...order]) {
      const at = order.indexOf(k);
      const below = prerequisites(k).filter((d) => order.indexOf(d) > at);
      if (!below.length) continue;
      const lowest = below.reduce((a, b) => (order.indexOf(a) > order.indexOf(b) ? a : b));
      order.splice(order.indexOf(k), 1);
      order.splice(order.indexOf(lowest) + 1, 0, k);
      held.set(k, lowest);
      moved = true;
    }
    if (!moved) break;
  }
  const features = order.map((k, i) => {
    const row = rows.get(k)!;
    const o = applied.get(k);
    const hold = held.get(k);
    return {
      ...row,
      rank: i + 1,
      formula_rank: row.rank,
      flags: [...new Set([...row.flags, ...(hold ? ["held_by_dependency"] : [])])].sort(),
      explanation: hold
        ? { ...row.explanation, order: [...(row.explanation.order ?? []), `held below ${hold}: it depends on it`] }
        : row.explanation,
      override: o?.info ? { id: o.id, kind: o.kind, ...o.info } : null,
      held_below: hold ?? null,
    };
  });
  return { ...r, features };
}

function overrideInputs(list: OverrideRow[]): OverrideInput[] {
  return list
    .filter((o) => !o.removed_at && !o.snapshot_id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((o) => ({
      id: o.id,
      feature: o.feature.key,
      kind: o.kind,
      above: o.above?.key ?? null,
      position: o.position ?? null,
      info: {
        by: o.created_by.name,
        reason: o.reason,
        kept_after_pushback: o.kept_after_pushback,
        above: o.above?.key ?? null,
        position: o.position ?? null,
        created_at: o.created_at,
      },
    }));
}

const LOW = 0.4;
const n2 = (x: number | null | undefined) => (x == null ? "—" : String(Math.round(x * 100) / 100));
const confOf = (f: Schemas["RankedFeature"]) => f.explanation.confidence.value;

/** The four rules on the numbers (the API's pushback.rules), on the order the change makes. */
function pushbackRules(
  before: Schemas["RankedFeature"][],
  after: Schemas["RankedFeature"][],
  key: string,
): PushbackMessage[] {
  const was = new Map(before.map((f) => [f.key, f.rank]));
  const row = after.find((f) => f.key === key);
  if (!row) return [];
  const passed = after.filter(
    (f) => f.key !== key && (was.get(f.key) ?? 0) < (was.get(key) ?? 0) && f.rank > row.rank,
  );
  const out: PushbackMessage[] = [];
  if (!row.serves_goal) {
    const p = passed.find((f) => f.serves_goal);
    if (p) {
      const g = [...p.explanation.goals].sort((a, b) => (b.term ?? 0) - (a.term ?? 0))[0];
      out.push({
        code: "no_confirmed_goal",
        message: `${row.title} serves no confirmed goal. Features that serve none sink (score ${n2(row.score)}); ${p.title} serves ${g?.title ?? "a confirmed goal"} (weight ${g?.weight}, contribution ${g?.contribution}).`,
        numbers: { score: row.score, passes: p.key, passes_score: p.score, goal: g?.goal ?? null },
      });
    }
  }
  const c = confOf(row);
  if (c < LOW) {
    const p = passed.find((f) => confOf(f) >= LOW);
    if (p) {
      const count = p.explanation.confidence.evidence.length;
      out.push({
        code: "low_confidence",
        message: `Confidence ${n2(c)} is below ${LOW}; ${p.title} has ${n2(confOf(p))}${count ? ` from ${count} source${count === 1 ? "" : "s"}` : ""}.`,
        numbers: { confidence: c, threshold: LOW, passes: p.key, passes_confidence: confOf(p) },
      });
    }
  }
  const formulaRank = row.formula_rank ?? row.rank;
  if (formulaRank - row.rank >= 3 && row.score != null) {
    const own = row.score;
    const higher = passed.filter((f) => f.score != null && f.score > 0 && f.score >= 2 * own);
    if (higher.length) {
      const p = higher.reduce((a, b) => ((a.score ?? 0) >= (b.score ?? 0) ? a : b));
      const times = own > 0 ? p.score! / own : null;
      const ratio = times == null ? "" : ` (${times >= 10 ? Math.round(times) : Math.round(times * 10) / 10}× higher)`;
      out.push({
        code: "against_score",
        message: `Score ${n2(own)} against ${n2(p.score)} for ${p.title}${ratio}.`,
        numbers: { score: own, formula_rank: formulaRank, rank: row.rank, passes: p.key, passes_score: p.score },
      });
    }
  }
  return out;
}

const chipOf = (f: FeatureSeed, id: string): Schemas["EvidenceChip"] | null => {
  const e = f.evidence.find((x) => x.id === id);
  return e ? { id: e.id, title: e.title, source_kind: e.source_kind, confidence: e.confidence, date: e.date } : null;
};

/**
 * Oracle's reading of the reason, with the mock's two hooks: a reason with "keep asking"
 * is contradicted by the feature's evidence; one with "slow-check" runs out of time.
 */
function readReason(
  f: FeatureSeed,
  reason: string,
  cited: string[],
): { status: ReasonCheckRow["status"]; ms: number; message: PushbackMessage | null } {
  if (reason.trim().length < 10) return { status: "skipped", ms: 0, message: null };
  if (/slow-check/i.test(reason)) return { status: "timed_out", ms: 10000, message: null };
  if (/keep asking/i.test(reason)) {
    const ids = cited.length ? cited.slice(0, 1) : f.evidence.slice(0, 1).map((e) => e.id);
    const evidence = ids.map((id) => chipOf(f, id)).filter((x): x is Schemas["EvidenceChip"] => !!x);
    if (evidence.length) {
      return {
        status: "contradiction",
        ms: 4800,
        message: {
          code: "reason_contradicts_evidence",
          claim: "customers keep asking",
          message: "You wrote 'customers keep asking'; the evidence shows 1 request from 1 source in the last 90 days.",
          evidence,
        },
      };
    }
  }
  return { status: "no_contradiction", ms: 3100, message: null };
}

/** POST /v1/priorities/overrides: check, push back once, or store (replacing the feature's active one). */
function createOverride(st: LaneFState, me: string, input: Schemas["OverrideCreate"]): Response {
  st.overrides ??= [];
  st.reason_checks ??= [];
  const reason = (input.reason ?? "").trim();
  const f = featureById(input.feature_id);
  const above = input.above_feature_id ? featureById(input.above_feature_id) : undefined;
  if (!reason || reason.length > 500) return json(422, { detail: "a reason of 1-500 characters is required" });
  if (!f) return json(422, { detail: "feature_id must be a feature of the baseline that is not rejected" });
  if (input.kind === "move" && (!above || above.key === f.key)) {
    return json(422, { detail: "a move needs another feature to go above" });
  }
  if (input.kind === "pin" && !(input.position && input.position >= 1)) {
    return json(422, { detail: "a pin needs a rank of 1 or more" });
  }
  const cited = [...new Set(input.evidence_ids ?? [])];
  if (cited.length > 5 || cited.some((id) => !f.evidence.some((e) => e.id === id))) {
    return json(422, { detail: "evidence_ids must each be evidence of the feature, at most 5" });
  }
  if (input.snapshot_id) {
    return json(409, {
      detail: "Only a run's proposed priority order, while its stop is waiting, takes changes; this snapshot is saved",
    });
  }

  const base = ranking("goal_weighted");
  const inputs = overrideInputs(st.overrides);
  const before = applyOverrides(base, inputs);
  const change: OverrideInput = {
    id: "new",
    feature: f.key,
    kind: input.kind,
    above: above?.key ?? null,
    position: input.position ?? null,
    info: null,
  };
  const after = applyOverrides(base, [...inputs.filter((i) => i.feature !== f.key), change]);
  const row = after.features.find((x) => x.key === f.key)!;
  const messages = pushbackRules(before.features, after.features, f.key);
  let check: { status: ReasonCheckRow["status"]; ms: number | null };
  if (!input.confirm) {
    const read = readReason(f, reason, cited);
    if (read.status !== "skipped") {
      st.reason_checks.push({
        by: me,
        feature: f.key,
        reason,
        status: read.status,
        ms: read.ms,
        evidence: read.message?.evidence ?? [],
        at: now(),
      });
    }
    if (read.message) messages.push(read.message);
    check = { status: read.status, ms: read.status === "skipped" ? null : read.ms };
    if (messages.length) {
      return json(409, {
        detail: "Oracle disagrees with this change",
        pushback: messages,
        reason_check: check,
        preview_rank: row.rank,
        held_below: row.held_below ?? null,
      } satisfies Schemas["PushbackOut"]);
    }
  } else {
    // As the API: the check the person saw is the server's record, never the request's.
    const seen = [...st.reason_checks].reverse().find((c) => c.by === me && c.feature === f.key && c.reason === reason);
    check = seen ? { status: seen.status, ms: seen.ms } : { status: "skipped", ms: null };
    if (seen?.status === "contradiction") {
      messages.push({
        code: "reason_contradicts_evidence",
        message: "Oracle read your reason against the evidence and found that the evidence contradicts it.",
        evidence: seen.evidence,
      });
    }
  }
  const at = now();
  const id = uuid();
  const old = st.overrides.find((o) => o.feature.key === f.key && !o.removed_at && !o.snapshot_id);
  if (old) {
    Object.assign(old, {
      removed_at: at,
      removed_by: { id: me, name: me },
      removed_reason: "Replaced by a new change",
      replaced_by: id,
    });
  }
  const out: OverrideRow = {
    id,
    feature: { id: entityId(f.key), key: f.key, title: f.title },
    kind: input.kind,
    above: above ? { id: entityId(above.key), key: above.key, title: above.title } : null,
    position: input.kind === "pin" ? (input.position ?? null) : null,
    reason,
    evidence_ids: cited,
    evidence: cited.map((c) => chipOf(f, c)).filter((x): x is Schemas["EvidenceChip"] => !!x),
    pushback: messages,
    kept_after_pushback: !!input.confirm && messages.length > 0,
    reason_check: check,
    snapshot_id: null,
    created_by: { id: me, name: me },
    created_at: at,
    removed_at: null,
    removed_by: null,
    removed_reason: null,
    replaced_by: null,
    no_longer_applies: false,
  };
  st.overrides.push(out);
  return json(201, { ...out, preview_rank: row.rank, held_below: row.held_below ?? null });
}

/** Handles /v1/priorities/overrides[/{id}]. */
async function overridesRoute(st: LaneFState, me: string, req: Request, p: string[], m: string): Promise<Response> {
  st.overrides ??= [];
  const q = new URL(req.url).searchParams;
  if (p.length === 3 && m === "GET") {
    const all = q.get("include_removed") === "true";
    const limit = Math.min(Number(q.get("limit") ?? 50) || 50, 200);
    return json(
      200,
      st.overrides
        .filter((o) => all || !o.removed_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit),
    );
  }
  if (p.length === 3 && m === "POST") {
    return createOverride(st, me, JSON.parse((await req.text()) || "{}") as Schemas["OverrideCreate"]);
  }
  if (p.length === 4 && m === "DELETE") {
    const o = st.overrides.find((x) => x.id === p[3]);
    if (!o) return notFound("Priority override");
    if (o.removed_at) return json(409, { detail: "This change was already removed or replaced" });
    const input = JSON.parse((await req.text()) || "null") as Schemas["OverrideRemove"] | null;
    Object.assign(o, {
      removed_at: now(),
      removed_by: { id: me, name: me },
      removed_reason: input?.reason?.trim() || null,
    });
    return json(200, o);
  }
  return notFound("Route");
}

// ---------------------------------------------------------------- templates

type TemplateSeed = {
  key: string;
  kind: Kind | "vision" | "strategy";
  /** How many leading sections are the brief (default 2). */
  brief?: number;
  name: string;
  description: string;
  suggest_when: string;
  theme: string;
  sections: [id: string, heading: string, hint: string][];
};

const TEMPLATE_SEEDS: TemplateSeed[] = [
  {
    key: "oracle-default",
    kind: "prd",
    name: "Goal-traced PRD",
    description: "Goal trace, problem alignment, prioritized solution, requirements with ids, launch, recap",
    suggest_when: "Default for any cross-functional feature or product version",
    theme: "clean-document",
    sections: [
      ["goal-trace", "Goal trace", "The confirmed goal this moves and how."],
      ["problem", "Problem", "The customer problem, in the customer's terms."],
      ["solution", "Solution", "The prioritized solution."],
      ["requirements", "Requirements", "Numbered requirements with Given / When / Then criteria."],
      ["launch", "Launch", "Rollout, risks and the launch check."],
    ],
  },
  {
    key: "one-pager",
    kind: "prd",
    name: "One-pager",
    description: "Agree the problem, audience and success measure fast",
    suggest_when: 'Early idea, small team, single feature, or "should we spend more time on this"',
    theme: "one-page-brief",
    sections: [
      ["problem", "Problem", "The customer problem, in the customer's terms."],
      ["audience", "Who it is for", "Target segment or a job story."],
      ["success", "What success looks like", "One or two measurable outcomes."],
      ["next-step", "Next step", "The decision asked for."],
    ],
  },
  {
    key: "pr-faq",
    kind: "prd",
    name: "Working Backwards PR/FAQ",
    description: "Test a big new bet from the customer's view before building",
    suggest_when: "New product, new market, major bet; reviewers are leadership or investors",
    theme: "press-release",
    sections: [
      ["press-release", "Press release", "Dateline, headline, subheading, the customer quote."],
      ["customer-faq", "Customer FAQ", "What customers will ask."],
      ["internal-faq", "Internal FAQ", "What the company will ask."],
    ],
  },
  {
    key: "narrative-memo",
    kind: "prd",
    name: "Decision narrative",
    description: "Argue one strategic choice in prose",
    suggest_when: "Choosing between options, a strategy shift, a board or exec review",
    theme: "editorial-memo",
    sections: [
      ["context", "Context", "Where we are and why this decision now."],
      ["options", "Options", "The options side by side."],
      ["recommendation", "Recommendation", "The choice and why."],
    ],
  },
  {
    key: "shape-up-pitch",
    kind: "prd",
    name: "Shape Up pitch",
    description: "Bet a fixed time budget on a shaped solution",
    suggest_when: "Team works in fixed cycles; effort cap matters more than estimates",
    theme: "clean-document",
    sections: [
      ["problem", "Problem", "The raw idea and the problem behind it."],
      ["appetite", "Appetite", "How much time this is worth."],
      ["solution", "Solution", "The shaped solution, at fat-marker level."],
      ["rabbit-holes", "Rabbit holes", "Known risks and how they are avoided."],
      ["no-gos", "No-gos", "What is out."],
    ],
  },
  {
    key: "prd-rfc",
    kind: "prd",
    name: "Product spec + RFC",
    description: "Product requirements plus engineering's design, alternatives and trade-offs",
    suggest_when: 'Engineering-heavy, infra/API/platform work, or the "how" is the main risk',
    theme: "technical-spec",
    sections: [
      ["requirements", "Product requirements", "What it must do."],
      ["design", "Design", "How it will be built."],
      ["alternatives", "Alternatives considered", "And why they lost."],
      ["risks", "Risks and trade-offs", "What could go wrong."],
    ],
  },
  {
    key: "ai-feature",
    kind: "prd",
    name: "AI feature PRD",
    description: "Specify model behaviour, evals, fallbacks, cost and prompt ownership",
    suggest_when: "Any feature whose output comes from a model or agent",
    theme: "technical-spec",
    sections: [
      ["behaviour", "Model behaviour", "What good output looks like."],
      ["evals", "Evals", "How quality is measured, with thresholds."],
      ["fallbacks", "Fallbacks", "What happens when the model fails."],
      ["cost", "Cost", "Expected cost per use."],
    ],
  },
  {
    key: "now-next-later",
    kind: "roadmap",
    name: "Now / Next / Later",
    description: "Direction by confidence horizon. Dated milestones only in Now. Goal tag on every card.",
    suggest_when: "Always the default, especially early stage or when dates beyond the quarter are not credible",
    theme: "roadmap-board",
    sections: [
      ["now", "Now", "Committed work, with dates."],
      ["next", "Next", "Likely next, no dates."],
      ["later", "Later", "Direction only."],
    ],
  },
  {
    key: "outcome-roadmap",
    kind: "roadmap",
    name: "Outcome roadmap",
    description: "Rows = confirmed goals, columns = horizons. Flags items that serve no goal.",
    suggest_when: "Board or leadership audience; a goal-setting season",
    theme: "roadmap-board",
    sections: [
      ["goals", "Goals", "One row per confirmed goal: metric, current, target."],
      ["horizons", "Horizons", "What each goal gets now, next and later."],
      ["no-goal", "Serves no confirmed goal", "Items that trace to no goal."],
    ],
  },
  {
    key: "quarterly-timeline",
    kind: "roadmap",
    name: "Quarterly timeline",
    description: "Quarter axis, swimlanes by team, dated bars in Now, fuzzy bars beyond.",
    suggest_when: "External dates exist, or several teams with cross-dependencies",
    theme: "roadmap-board",
    sections: [
      ["timeline", "Timeline", "Quarters, swimlanes, milestones."],
      ["dependencies", "Dependencies", "What waits on what."],
      ["capacity", "Capacity", "Planned against available."],
    ],
  },
  {
    key: "release-plan",
    kind: "roadmap",
    name: "Release plan",
    description: "Releases with target dates, scoped items, readiness and estimate drift.",
    suggest_when: "Engineering audience; versioned releases; tracker connected",
    theme: "roadmap-board",
    sections: [
      ["releases", "Releases", "Each release with its target date and scope."],
      ["readiness", "Readiness", "What is left before each release."],
    ],
  },
  {
    key: "cycle-bets",
    kind: "roadmap",
    name: "Cycle bets (Shape Up)",
    description: "Current cycle bets with appetite and hill position, next-cycle pitches, cool-down.",
    suggest_when: "The team works in fixed cycles; horizon of one cycle",
    theme: "roadmap-board",
    sections: [
      ["bets", "This cycle's bets", "Each bet with its appetite and hill position."],
      ["pitches", "Pitches for the next cycle", "Shaped work waiting for the betting table."],
      ["cool-down", "Cool-down", "Fixes and exploration between cycles."],
    ],
  },
  // H4: the built-in vision and product strategy templates, started from Company › Strategy.
  {
    key: "vision-narrative",
    kind: "vision",
    name: "Vision narrative",
    description: "The future we see, for whom, what we believe and why now",
    suggest_when: "A product vision two to ten years out",
    theme: "editorial-memo",
    brief: 4,
    sections: [
      ["headline", "Headline", "One sentence."],
      ["future", "The future we see", "The narrative, about 300 words."],
      ["for-whom", "Who it is for", "Customers and segments."],
      ["beliefs", "What we believe", "Three to seven beliefs, each with evidence for and against."],
      ["why-now", "Why now", "What makes this the moment."],
      ["not", "What it is not", "What the vision leaves out."],
      ["horizon", "Horizon and review", "Years covered and a review date."],
    ],
  },
  {
    key: "product-strategy",
    kind: "strategy",
    name: "Product strategy",
    description: "The few problems that matter now, what we stop, and why",
    suggest_when: "A product strategy for the next one to two years",
    theme: "editorial-memo",
    brief: 3,
    sections: [
      ["summary", "Strategy in one paragraph", "The strategy in one paragraph."],
      ["focus", "Focus", "One subsection per focus choice: the problem, the insight, the goals it serves."],
      ["stop", "What we stop or won't do", "One subsection per stop choice: the work and why it stops."],
      ["insights", "Insights", "From data and customers."],
      ["company", "How this serves the company strategy", "The company strategy it serves."],
      ["tradeoffs", "Trade-offs and risks", "What we give up."],
      ["horizon", "Horizon and review", "Dates, and a quarterly check."],
    ],
  },
];

const TEMPLATE_TITLE: Record<TemplateSeed["kind"], string> = {
  prd: "<Feature> PRD",
  roadmap: "<Product> roadmap",
  vision: "Vision",
  strategy: "Product strategy",
};

function templateBody(t: TemplateSeed): string {
  const lines = [
    "---",
    `template: ${t.key}`,
    `theme: ${t.theme}`,
    `suggest_when: ${JSON.stringify(t.suggest_when)}`,
    `brief: [${t.sections.slice(0, t.brief ?? 2).map(([id]) => id).join(", ")}]`,
    "---",
    "",
    `# ${TEMPLATE_TITLE[t.kind]} {#title}`,
    "",
  ];
  for (const [id, heading, hint] of t.sections) lines.push(`## ${heading} {#${id}}`, `<!-- ${hint} -->`, "");
  lines.push(
    "## Sources and data points {#sources}",
    "<!-- The only place for sources, numbers and evidence. The body states conclusions only. -->",
    "",
  );
  return lines.join("\n");
}

/** Front matter (flat `key: value` lines) and the line count before the body. */
function frontMatter(text: string): { fm: Record<string, string> | null; rest: string; offset: number; open: boolean } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fm: null, rest: text, offset: 0, open: false };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") {
      const fm: Record<string, string> = {};
      for (const l of lines.slice(1, i)) {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
        if (m) {
          let v = m[2].trim();
          if (/^".*"$/.test(v)) {
            try {
              v = JSON.parse(v);
            } catch {
              v = v.slice(1, -1);
            }
          }
          fm[m[1]] = v;
        }
      }
      return { fm, rest: lines.slice(i + 1).join("\n"), offset: i + 1, open: false };
    }
  }
  return { fm: null, rest: text, offset: 0, open: true };
}

type Heading = { level: number; text: string; key: string | null; line: number };

function headings(rest: string, offset: number): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  rest.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,3})\s+(.*?)\s*$/.exec(line);
    if (!m) return;
    const id = /\s*\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}\s*$/.exec(m[2]);
    out.push({
      level: m[1].length,
      text: id ? m[2].slice(0, id.index).trim() : m[2],
      key: id ? id[1] : null,
      line: i + 1 + offset,
    });
  });
  return out;
}

export function checkTemplate(body: string, required?: string[] | null, themeKeys?: Set<string>) {
  const problems: Problem[] = [];
  const text = body.replace(/\r\n/g, "\n");
  const { fm, rest, offset, open } = frontMatter(text);
  if (open) problems.push({ code: "invalid_front_matter", message: "front matter starts with '---' but never ends", line: 1 });
  const theme = fm?.theme;
  if (theme && themeKeys && !themeKeys.has(theme)) {
    problems.push({ code: "unknown_theme", message: `suggested theme '${theme}' does not exist`, line: null });
  }
  const hs = headings(rest, offset);
  if (!hs.length) problems.push({ code: "no_sections", message: "the template has no level 1-3 headings", line: null });
  const seen = new Set<string>();
  for (const h of hs) {
    if (!h.key) {
      problems.push({
        code: "missing_section_id",
        message: `heading '${h.text}' (level ${h.level}) must end with {#section-id}`,
        line: h.line,
      });
    } else if (seen.has(h.key)) {
      problems.push({
        code: "duplicate_section_id",
        message: `section id '${h.key}' is used more than once`,
        line: h.line,
        section_key: h.key,
      });
    } else seen.add(h.key);
  }
  const sources = hs.find((h) => h.key === "sources");
  if (!sources) {
    problems.push({
      code: "missing_sources_section",
      message:
        "the template must end with a '## Sources and data points {#sources}' section: sources, data points and evidence live there, not in the body",
      line: null,
    });
  } else {
    if (sources.level > 2) {
      problems.push({
        code: "sources_section_level",
        message: "'Sources and data points' must be a level 1 or 2 heading",
        line: sources.line,
        section_key: "sources",
      });
    }
    const later = hs.find((h) => h.line > sources.line && h.level <= sources.level);
    if (later) {
      problems.push({
        code: "sources_section_not_last",
        message: `'Sources and data points' must be the final section; '${later.text}' comes after it`,
        line: later.line,
        section_key: later.key,
      });
    }
  }
  const lines = rest.split("\n");
  const stop = sources ? sources.line - offset : lines.length + 1;
  let current: string | null = null;
  for (let i = 1; i < stop && i <= lines.length; i++) {
    const h = hs.find((x) => x.line - offset === i);
    if (h) current = h.key;
    for (const m of lines[i - 1].matchAll(/\[c:([^\]\s]+)\]/g)) {
      problems.push({
        code: "citation_in_body",
        message: `citation [c:${m[1]}] is outside 'Sources and data points': the body states conclusions only`,
        line: i + offset,
        section_key: current,
      });
    }
  }
  const keys = hs.map((h) => h.key).filter((k): k is string => !!k);
  for (const k of required ?? []) {
    if (!keys.includes(k)) problems.push({ code: "unknown_required_section", message: `required section '${k}' is not in the body`, line: null });
  }
  // O1f: front matter `brief: [ids]`, else the sections before "# Full version {#full}".
  const marked = fm?.brief ? fm.brief.replace(/^\[|\]$/g, "").split(",").map((k) => k.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  for (const k of marked ?? []) {
    if (!keys.includes(k)) problems.push({ code: "unknown_brief_section", message: `brief section '${k}' is not a section id`, line: null, section_key: k });
  }
  const brief = [
    ...resolveBrief(
      hs.filter((h) => h.key).map((h) => ({ section_key: h.key!, level: h.level })),
      marked ?? undefined,
    ).brief,
  ];
  // O1g: a template without brief sections is refused, not saved with a warning.
  if (hs.length && !brief.length) {
    problems.push({
      code: "no_brief_sections",
      message:
        "the template marks no brief sections: add 'brief: [section ids]' to its front matter, or a level-1 '# Full version {#full}' heading after the brief sections",
      line: null,
    });
  }
  const warnings: Problem[] = [];
  return {
    brief,
    warnings,
    valid: problems.length === 0,
    problems,
    section_keys: keys,
    suggested_theme: fm?.theme || null,
    suggest_when: fm?.suggest_when || null,
    required: hs.filter((h) => h.key && h.level <= 2).map((h) => h.key!),
    headings: hs,
    rest,
    offset,
  };
}

function latest(t: TemplateRow) {
  return t.versions[t.versions.length - 1];
}

function templateSummary(t: TemplateRow): Schemas["TemplateSummary"] {
  const v = latest(t);
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    kind: t.kind,
    description: t.description,
    builtin: t.builtin,
    archived_at: t.archived_at,
    created_at: t.created_at,
    latest_version: v.version,
    suggested_theme: v.suggested_theme ?? null,
    suggest_when: v.suggest_when ?? null,
  };
}

function templateOut(t: TemplateRow): Schemas["TemplateOut"] {
  return { ...templateSummary(t), versions: t.versions };
}

function templateOption(t: TemplateRow): Schemas["TemplateOption"] {
  const s = templateSummary(t);
  return {
    key: s.key,
    name: s.name,
    description: s.description,
    latest_version: s.latest_version,
    suggested_theme: s.suggested_theme,
    suggest_when: s.suggest_when,
    builtin: s.builtin,
  };
}

function newVersion(n: number, body: string, required: string[] | null | undefined, by: string | null) {
  const check = checkTemplate(body);
  return {
    version: n,
    body,
    required_sections: required ?? check.required,
    created_by: by,
    created_at: now(),
    suggested_theme: check.suggested_theme,
    suggest_when: check.suggest_when,
    brief_sections: check.brief,
    // A version saved before O1g may have no brief; its next edit must add markers.
    warnings: [...check.warnings, ...check.problems.filter((p) => p.code === "no_brief_sections")],
  } satisfies Schemas["TemplateVersionOut"];
}

// ---------------------------------------------------------------- themes

type FullTokens = {
  fonts: Schemas["ThemeFonts"];
  colors: Record<string, string>;
  spacing: Schemas["ThemeSpacing"];
  page: Schemas["ThemePage"];
  features: Schemas["ThemeFeatures"];
};

const BASE_TOKENS: FullTokens = {
  fonts: {
    body: '"DejaVu Serif", Georgia, serif',
    heading: '"DejaVu Sans", Helvetica, Arial, sans-serif',
    mono: '"DejaVu Sans Mono", Menlo, Consolas, monospace',
  },
  colors: {
    text: "#1f2933",
    heading: "#111827",
    muted: "#5b6472",
    accent: "#2f5bd3",
    background: "#ffffff",
    rule: "#d9dde3",
    surface: "#f3f4f6",
  },
  spacing: { base_size_pt: 11, line_height: 1.5, page_margin_mm: 20, section_gap_rem: 1.6 },
  page: { size: "A4", orientation: "portrait" },
  features: {
    toc: false,
    status_header: true,
    page_fit: null,
    numbered_headings: false,
    legend: false,
    appendix_break: false,
  },
};

/** The base tokens with `over` merged in, group by group. */
function tokens(over: { [G in keyof FullTokens]?: Partial<FullTokens[G]> | null } = {}): FullTokens {
  return {
    fonts: { ...BASE_TOKENS.fonts, ...over.fonts },
    colors: { ...BASE_TOKENS.colors, ...(over.colors as Record<string, string> | undefined) },
    spacing: { ...BASE_TOKENS.spacing, ...over.spacing },
    page: { ...BASE_TOKENS.page, ...over.page },
    features: { ...BASE_TOKENS.features, ...over.features },
  };
}

const SANS = '"DejaVu Sans", Helvetica, Arial, sans-serif';

const THEME_SEEDS: { key: string; kind: ThemeKind; name: string; description: string; tokens: Tokens; css: string }[] = [
  {
    key: "clean-document",
    kind: "prd",
    name: "Clean document",
    description: "Long scrolling PRD: table of contents, status header block, styled tables.",
    tokens: tokens({ fonts: { body: SANS }, features: { toc: true } }),
    css: "table { border-collapse: collapse; }\nth, td { border: 1px solid var(--color-rule); padding: 4px 8px; }\n",
  },
  {
    key: "one-page-brief",
    kind: "prd",
    name: "One-page brief",
    description: "Dense, compact type for documents that must fit one printed page.",
    tokens: tokens({
      fonts: { body: SANS },
      spacing: { base_size_pt: 9, line_height: 1.3, page_margin_mm: 12, section_gap_rem: 0.6 },
      features: { page_fit: "one_page" },
    }),
    css: "h2 { font-size: 1.05em; margin-bottom: 0.2em; }\n",
  },
  {
    key: "editorial-memo",
    kind: "prd",
    name: "Editorial memo",
    description: "Print-first narrative: serif, generous line height and margins.",
    tokens: tokens({
      fonts: { body: '"DejaVu Serif", Georgia, "Times New Roman", serif', heading: '"DejaVu Serif", Georgia, serif' },
      colors: { accent: "#7a3e12", text: "#1c1917", heading: "#1c1917" },
      spacing: { base_size_pt: 11.5, line_height: 1.7, page_margin_mm: 28 },
      features: { appendix_break: true },
    }),
    css: "p { text-align: justify; }\n",
  },
  {
    key: "press-release",
    kind: "prd",
    name: "Press release",
    description: "Newspaper-like first page, then question-and-answer styling for the FAQs.",
    tokens: tokens({ fonts: { heading: '"DejaVu Serif", Georgia, serif' }, colors: { accent: "#9b1c1c" }, features: { appendix_break: true } }),
    css: "h1 { text-transform: uppercase; letter-spacing: 0.02em; }\n",
  },
  {
    key: "technical-spec",
    kind: "prd",
    name: "Technical spec",
    description: "Numbered headings, monospace blocks, wide tables.",
    tokens: tokens({
      fonts: { body: SANS },
      colors: { accent: "#0f5e8c" },
      spacing: { base_size_pt: 10.5, line_height: 1.45, page_margin_mm: 16 },
      features: { toc: true, numbered_headings: true },
    }),
    css: "code { background: var(--color-surface); padding: 0 2px; }\n",
  },
  {
    key: "roadmap-board",
    kind: "roadmap",
    name: "Roadmap board",
    description: "Landscape pages with an as-of header and a legend; items as cards.",
    tokens: tokens({
      fonts: { body: SANS },
      spacing: { base_size_pt: 9.5, line_height: 1.35, page_margin_mm: 12 },
      page: { size: "A4", orientation: "landscape" },
      features: { legend: true },
    }),
    css: ".card { border: 1px solid var(--color-rule); border-radius: 4px; padding: 6px; }\n",
  },
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONT = /^[A-Za-z0-9 ,'"_-]{1,200}$/;

function rgb(hex: string): [number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two hex colours, 1-21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The built-in themes' keys, names and page backgrounds (the Branding preview's note). */
export const builtinThemeBackgrounds = () =>
  THEME_SEEDS.map((t) => ({ key: t.key, name: t.name, background: t.tokens.colors?.background ?? "#ffffff" }));

export function checkTheme(t: Tokens | null | undefined, css: string, slideCss?: string | null): Problem[] {
  const problems: Problem[] = [];
  const colours = t?.colors ?? {};
  for (const [name, value] of Object.entries(colours)) {
    if (!HEX.test(value)) problems.push({ code: "invalid_color", message: `colors.${name} must be a hex colour like #1f2933`, line: null });
  }
  const bg = colours.background;
  if (bg && HEX.test(bg)) {
    for (const name of ["text", "muted", "accent", "heading"]) {
      const value = colours[name];
      if (!value || !HEX.test(value)) continue;
      const ratio = contrast(value, bg);
      if (ratio < 4.5) {
        problems.push({
          code: "insufficient_contrast",
          message: `colors.${name} ${value} on colors.background ${bg} has a contrast of ${ratio.toFixed(2)}:1; WCAG AA needs at least 4.5:1 for body text. Darken the text colour or lighten the background.`,
          line: null,
        });
      }
    }
  }
  for (const [name, value] of Object.entries(t?.fonts ?? {})) {
    if (value != null && !FONT.test(value)) {
      problems.push({ code: "invalid_font", message: `fonts.${name} must be a font stack (letters, digits, spaces, commas, quotes)`, line: null });
    }
  }
  const ranges: Record<string, [number, number]> = {
    base_size_pt: [6, 20],
    line_height: [1, 2.5],
    page_margin_mm: [5, 40],
    section_gap_rem: [0, 6],
  };
  for (const [name, [lo, hi]] of Object.entries(ranges)) {
    const v = (t?.spacing as Record<string, number | null | undefined> | undefined)?.[name];
    if (v == null) continue;
    if (typeof v !== "number" || Number.isNaN(v) || v < lo || v > hi) {
      problems.push({ code: "invalid_spacing", message: `spacing.${name} must be a number from ${lo} to ${hi}`, line: null });
    }
  }
  problems.push(...checkCss(css));
  // O1g: a theme's slide CSS passes the same checks, named as slide CSS.
  if (slideCss) problems.push(...checkCss(slideCss).map((p) => ({ ...p, message: `slide CSS: ${p.message}` })));
  return problems;
}

function checkCss(css: string): Problem[] {
  const problems: Problem[] = [];
  const forbidden: [RegExp, string][] = [
    [/@import/i, "@import is not allowed"],
    [/<\//, "'</' is not allowed in CSS"],
    [/expression\s*\(/i, "expression() is not allowed"],
    [/javascript:/i, "javascript: URLs are not allowed"],
    [/\\/, "backslash escapes are not allowed"],
  ];
  for (const [rx, msg] of forbidden) if (rx.test(css)) problems.push({ code: "unsafe_css", message: msg, line: null });
  for (const m of css.matchAll(/url\s*\(\s*(['"]?)\s*([^'")\s]*)/gi)) {
    if (!m[2].toLowerCase().startsWith("data:")) {
      problems.push({ code: "unsafe_css", message: "url() may only use data: URIs; the export loads nothing else", line: null });
      break;
    }
  }
  if ((css.match(/\{/g) ?? []).length !== (css.match(/\}/g) ?? []).length) {
    problems.push({ code: "invalid_css", message: "unbalanced braces in CSS", line: null });
  }
  return problems;
}

function rejectTheme(problems: Problem[], what: string): Response {
  const contrastProblem = problems.find((p) => p.code === "insufficient_contrast");
  return json(422, { detail: contrastProblem ? contrastProblem.message : `${what} rejected: ${problems[0].message}`, problems });
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** A sample document rendered with the tokens and CSS (stands in for the API's renderer). */
export function previewHtml(t: Tokens, css: string, kind: Kind): string {
  const c = { ...BASE_TOKENS.colors, ...t.colors };
  const f = { ...BASE_TOKENS.fonts, ...t.fonts };
  const s = { ...BASE_TOKENS.spacing, ...t.spacing };
  const feat = { ...BASE_TOKENS.features, ...t.features };
  const page = { ...BASE_TOKENS.page, ...t.page };
  const vars = Object.entries(c)
    .map(([k, v]) => `--color-${k}: ${v};`)
    .join(" ");
  const sections =
    kind === "prd"
      ? [
          ["Goal trace", "Moves G1: raise first-order completion by removing a late surprise in checkout."],
          ["Problem", "Buyers leave checkout when the total changes late in the flow."],
          ["Solution", "Show the shipping cost in the cart, before checkout starts."],
          ["Sources and data points", "c1: funnel export, September. c2: customer interview 07."],
        ]
      : [
          ["Now", "Shipping cost in the cart (G1) · Saved addresses (G1)"],
          ["Next", "Shared projects (G2) · Usage alerts (G2)"],
          ["Later", "Scheduled exports (G2)"],
          ["Sources and data points", "Baseline snapshot of 1 October."],
        ];
  const body = sections
    .map(([h, p], i) => {
      const n = feat.numbered_headings ? `${i + 1}. ` : "";
      const inner = kind === "roadmap" && i < 3 ? `<div class="card">${esc(p)}</div>` : `<p>${esc(p)}</p>`;
      return `<section><h2>${n}${esc(h)}</h2>${inner}</section>`;
    })
    .join("");
  const toc = feat.toc
    ? `<nav class="toc"><strong>Contents</strong><ol>${sections.map(([h]) => `<li>${esc(h)}</li>`).join("")}</ol></nav>`
    : "";
  const status = feat.status_header
    ? `<p class="status">Draft · version 1 · example document · ${page.size} ${page.orientation}</p>`
    : "";
  const legend = feat.legend ? `<p class="legend">Legend: G1 checkout · G2 retention</p>` : "";
  const fit = feat.page_fit === "one_page" ? `<p class="fit">Fits on one page</p>` : "";
  const title = kind === "prd" ? "Example feature PRD" : "Example product roadmap";
  const safeCss = checkTheme(t, css).some((p) => p.code === "unsafe_css") ? "" : css;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
:root { ${vars} }
body { margin: 0; padding: ${s.page_margin_mm}mm; background: var(--color-background); color: var(--color-text); font-family: ${f.body}; font-size: ${s.base_size_pt}pt; line-height: ${s.line_height}; }
h1, h2 { font-family: ${f.heading}; color: var(--color-heading); }
h1 { border-bottom: 2px solid var(--color-accent); padding-bottom: 4px; }
section { margin-top: ${s.section_gap_rem}rem; }
.status, .legend, .fit { color: var(--color-muted); font-size: 0.85em; }
.toc { background: var(--color-surface); padding: 6px 10px; border: 1px solid var(--color-rule); }
a { color: var(--color-accent); }
code { font-family: ${f.mono}; }
</style><style>${safeCss}</style></head><body>${status}<h1>${title}</h1>${legend}${fit}${toc}${body}<p><a href="#">Accent link</a> · <code>mono sample</code></p></body></html>`;
}

/** The sample's brief as slides with the tokens and slide CSS (stands in for the API's deck renderer). */
export function slidePreviewHtml(t: Tokens, slideCss: string | null | undefined, kind: Kind, variant?: string | null): string {
  const c = { ...BASE_TOKENS.colors, ...t.colors };
  const f = { ...BASE_TOKENS.fonts, ...t.fonts };
  const vars = Object.entries(c)
    .map(([k, v]) => `--color-${k}: ${v};`)
    .join(" ");
  const title = kind === "prd" ? "Saved carts PRD" : "Product roadmap";
  const brief =
    kind === "prd"
      ? [
          ["Summary", "Returning buyers keep their cart for 30 days."],
          ["Goal trace", "G1 Activation: high contribution."],
          ["Requirements", "R1 Carts persist for 30 days. R2 Prices refresh on return."],
        ]
      : [
          ["Now", "Saved carts · Faster checkout"],
          ["Next", "Bulk ordering"],
          ["Later", "Marketplace"],
        ];
  const builtin = !!variant && THEME_SEEDS.some((s) => s.key === variant);
  const theme = builtin ? variant! : "preview";
  const own = !builtin && slideCss && !checkCss(slideCss).length ? slideCss : "";
  const slide = (n: number, kindClass: string, inner: string) =>
    `<section class="slide slide--${kindClass}" data-slide="${n}"><div class="slide-inner">${inner}</div><footer class="slide-footer"><span class="slide-banner">${esc(title)} · Version 1</span><span class="slide-number">${n} / ${brief.length + 1}</span></footer></section>`;
  const slides = [
    slide(1, "title", `<p class="slide-kicker">Brief</p><h1 class="slide-title">${esc(title)}</h1>`),
    ...brief.map(([h, p], i) => slide(i + 2, "section", `<h2 class="slide-title">${esc(h)}</h2><div class="slide-body"><p>${esc(p)}</p></div>`)),
  ].join("");
  const variantCss = builtin ? `.theme-${theme} .slide-title { border-top: 4px solid var(--color-accent); padding-top: 14px; }` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} (Deck)</title><style>
.deck { ${vars} --font-body: ${f.body}; --font-heading: ${f.heading}; }
body.deck-preview { margin: 0; background: #e5e7eb; padding: 16px 0; }
.deck .slide { box-sizing: border-box; position: relative; width: 960px; height: 540px; margin: 0 auto 16px; overflow: hidden; background: var(--color-background); color: var(--color-text); font-family: var(--font-body); font-size: 21px; padding: 44px 60px 56px; }
.deck .slide-title { color: var(--color-heading); font-family: var(--font-heading); font-size: 34px; margin: 0 0 22px; }
.deck .slide-kicker { margin: 120px 0 10px; color: var(--color-accent); text-transform: uppercase; font-size: 15px; }
.deck .slide-footer { position: absolute; left: 60px; right: 60px; bottom: 18px; display: flex; justify-content: space-between; font-size: 12px; color: var(--color-muted); }
${variantCss}
${own}
</style></head><body class="deck deck-preview theme-${theme}">${slides}</body></html>`;
}

function themeOption(t: ThemeRow): Schemas["ThemeOption"] {
  return { key: t.key, name: t.name, description: t.description, kind: t.kind };
}

// ---------------------------------------------------------------- picker

type PrdAnswers = Schemas["PrdAnswers"];
type RoadmapAnswers = Schemas["RoadmapAnswers"];

export function recommendPrd(a: PrdAnswers): [string, string] {
  if (a.decision === "start_or_not") {
    return ["one-pager", "You want a go / no-go first: a one-pager agrees the problem, audience and success measure fast."];
  }
  if (a.decision === "technical_design") {
    return ["prd-rfc", "The decision is about how to build it: product requirements first, then engineering's design, alternatives and trade-offs."];
  }
  if (a.decision === "choose_between") {
    return ["narrative-memo", "You are choosing between options: a decision narrative argues one choice in prose, with the options side by side."];
  }
  if (a.decision === "bet_fixed_time") {
    if (a.size === "new_product") return ["pr-faq", "A big new bet: the PR/FAQ tests it from the customer's side before anyone builds."];
    return ["shape-up-pitch", "You are betting a fixed time budget: a pitch shapes the solution to fit the appetite."];
  }
  if (a.size === "new_product") {
    return ["pr-faq", "A new product or market: the PR/FAQ tests the bet from the customer's view before building."];
  }
  if (a.model_driven) {
    return ["ai-feature", "The output comes from a model: this template specifies behaviour, evals, fallbacks and cost."];
  }
  if (a.readers === "leadership") {
    return ["narrative-memo", "Leadership or the board reads it: a narrative memo argues the case in prose and is read in one sitting."];
  }
  if (a.decision == null && a.size === "small_change" && (a.readers == null || a.readers === "founder")) {
    return ["one-pager", "A small change for the founder: a one-pager is enough to decide."];
  }
  if (a.readers === "engineers_or_agents") {
    return ["oracle-default", "Engineers or coding agents build from it: the goal-traced PRD has numbered requirements with Given / When / Then criteria."];
  }
  return ["oracle-default", "A cross-functional build: the goal-traced PRD agrees the problem, then the prioritized solution, then launch."];
}

export function recommendRoadmap(a: RoadmapAnswers, confirmed: number) {
  const warnings: string[] = [];
  const variant = ({ board: "board", engineering: "engineering", public: "public" } as Record<string, string>)[a.audience ?? ""] ?? "team";
  const groupBy = (a.teams ?? 0) >= 2 ? "team" : null;
  let showCapacity: boolean | null = null;
  let key: string;
  let reason: string;
  if (a.horizon === "one_cycle" || a.planning_style === "cycles") {
    [key, reason] = ["cycle-bets", "The team plans in fixed cycles: show this cycle's bets, the next betting table and raw ideas."];
  } else if (a.audience === "engineering") {
    [key, reason] = ["release-plan", "Engineering reads it first: releases with target dates, scope, readiness and estimate drift."];
  } else if (a.external_dates) {
    [key, reason] = ["quarterly-timeline", "Real external dates exist: a quarterly timeline shows them, with dates only on committed work."];
  } else if (a.audience === "board") {
    [key, reason] = ["outcome-roadmap", 'The board reads it first: rows are confirmed goals, so it answers "are we working on the right things?"'];
  } else if (a.horizon === "one_two_quarters" && (a.teams ?? 0) >= 2) {
    [key, reason] = ["quarterly-timeline", "Several teams over one or two quarters: a timeline with swimlanes shows sequencing and dependencies."];
  } else {
    [key, reason] = ["now-next-later", "Direction by confidence horizon, with dated milestones only in Now: the default for most roadmaps."];
    if (a.audience === "public") reason = "A public roadmap: Now / Next / Later rendered as status columns, public text only, with a disclaimer.";
  }
  if (key === "outcome-roadmap" && confirmed < 2) {
    warnings.push(`Only ${confirmed} confirmed goal(s) in the baseline: the outcome roadmap will be thin. Confirm goals first (goals interview).`);
  }
  if (a.public_version || a.audience === "public") {
    if (key === "outcome-roadmap" || key === "cycle-bets") {
      warnings.push("This template has no public variant; the public version renders as Now / Next / Later.");
    }
    warnings.push("Each item's public text needs approval before the public version ships.");
  }
  if (a.tracker_connected === false) warnings.push("No engineering tracker estimates: the roadmap shows no dates, even in Now.");
  if (a.show_capacity) {
    showCapacity = !!a.tracker_connected;
    if (!a.tracker_connected) warnings.push("Capacity needs tracker estimates; it is hidden until a tracker is connected.");
  }
  if (groupBy) reason += " Swimlanes by team, with dependency arrows.";
  return { key, reason, warnings, variant, groupBy, showCapacity };
}

const CONFIRMED_GOALS = new Set(FEATURES.flatMap((f) => f.goals.map((g) => g.goal))).size;
const DEFAULT_TEMPLATE: Record<Kind, string> = { prd: "oracle-default", roadmap: "now-next-later" };
const DEFAULT_THEME: Record<Kind, string> = { prd: "clean-document", roadmap: "roadmap-board" };

function recommend(st: LaneFState, input: Schemas["RecommendIn"]): Response {
  const kind = input.kind;
  const templates = st.templates.filter((t) => t.kind === kind && !t.archived_at);
  const themes = st.themes.filter((t) => (t.kind === kind || t.kind === "any") && !t.archived_at);
  const company = st.defaults[kind] ?? null;
  const warnings: string[] = [];
  let key: string;
  let reason: string;
  let answered: boolean;
  let extra: { variant?: string | null; group_by?: string | null; show_capacity?: boolean | null; confirmed_goals?: number | null } = {};
  if (kind === "prd") {
    const a = input.prd ?? {};
    answered = Object.values(a).some((v) => v != null);
    [key, reason] = recommendPrd(a);
  } else {
    const a = input.roadmap ?? {};
    answered = Object.values(a).some((v) => v != null);
    const confirmed = a.confirmed_goals ?? CONFIRMED_GOALS;
    const r = recommendRoadmap(a, confirmed);
    [key, reason] = [r.key, r.reason];
    warnings.push(...r.warnings);
    extra = { variant: r.variant, group_by: r.groupBy, show_capacity: r.showCapacity, confirmed_goals: confirmed };
  }
  const byKey = new Map(templates.map((t) => [t.key, t]));
  if (!answered && company && byKey.has(company.template)) {
    [key, reason] = [company.template, "Your company's default template for new drafts."];
  }
  if (!byKey.has(key)) {
    const fallback = [company?.template, DEFAULT_TEMPLATE[kind]].find((k) => k && byKey.has(k)) ?? templates[0]?.key;
    if (!fallback) return notFound(`Live ${kind} template`);
    const archived = st.templates.find((t) => t.key === key);
    warnings.push(`'${archived?.name ?? key}' is archived; showing '${byKey.get(fallback)!.name}'.`);
    key = fallback;
  }
  const template = byKey.get(key)!;
  const suggested = latest(template).suggested_theme;
  const themeKeys = new Set(themes.map((t) => t.key));
  let themeKey: string | null = null;
  let themeReason = "";
  if (company && company.template === key && company.theme && themeKeys.has(company.theme)) {
    [themeKey, themeReason] = [company.theme, "Your company's default theme for this template."];
  } else if (suggested && themeKeys.has(suggested)) {
    [themeKey, themeReason] = [suggested, `Suggested by ${template.name}.`];
  } else if (company?.theme && themeKeys.has(company.theme)) {
    [themeKey, themeReason] = [company.theme, "Your company's default theme."];
  } else if (themeKeys.has(DEFAULT_THEME[kind])) {
    [themeKey, themeReason] = [DEFAULT_THEME[kind], `The default ${kind === "prd" ? "PRD" : kind} theme.`];
  } else if (themes.length) {
    [themeKey, themeReason] = [themes[0].key, "The first available theme."];
  }
  const theme = themes.find((t) => t.key === themeKey);
  return json(200, {
    kind,
    template: templateOption(template),
    reason,
    theme: theme ? themeOption(theme) : null,
    theme_reason: themeReason,
    variant: extra.variant ?? null,
    group_by: extra.group_by ?? null,
    show_capacity: extra.show_capacity ?? null,
    warnings,
    confirmed_goals: extra.confirmed_goals ?? null,
    company_default: company,
    templates: templates.map(templateOption),
    themes: themes.map(themeOption),
  } satisfies Schemas["Recommendation"]);
}

function slugify(text: string) {
  const s = text
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60).replace(/-+$/, "") || "draft";
}

/** One section per heading of a template body; its body is the text up to the next heading,
 * with the template's <!-- hints --> kept as italic prompts. */
function skeleton(body: string) {
  const check = checkTemplate(body);
  const lines = check.rest.split("\n");
  const offset = check.offset;
  return check.headings.map((h, i, all) => {
    const start = h.line - offset;
    const end = i + 1 < all.length ? all[i + 1].line - offset - 1 : lines.length;
    const raw = lines.slice(start, end).join("\n");
    const md = raw.replace(/<!--\s*([\s\S]*?)\s*-->/g, "_$1_").trim() || "_To write._";
    return { h, i, raw, md };
  });
}

export const NOTHING_WRITTEN = "Nothing is written yet: every section still holds only the template's text";

/** #254, as the API (oracle.docs.written): every section still reads as its template's. */
export function nothingWritten(db: Db, doc: { template?: string | null; template_version?: string | null }, sections: { section_key: string; body_md: string }[]): boolean {
  const t = state(db).templates.find((x) => x.key === doc.template);
  const tv = t?.versions.find((v) => String(v.version) === doc.template_version);
  if (!tv || !sections.length) return false;
  const bodies = new Map(skeleton(tv.body).map(({ h, i, md }) => [h.key ?? `s-${i + 1}`, md]));
  return sections.every((s) => !s.body_md.trim() || bodies.get(s.section_key) === s.body_md);
}

function startDraft(db: Db, st: LaneFState, input: Schemas["StartDraftIn"]): Response {
  const t = st.templates.find((x) => x.key === input.template);
  if (!t) return notFound("Template");
  if (t.kind !== input.kind) {
    return json(422, {
      detail: `template '${t.key}' is a ${t.kind} template, not ${input.kind}`,
      problems: [{ code: "kind_mismatch", message: `template kind is ${t.kind}` }],
    });
  }
  // O5: a roadmap's default audience (the picker's variant); other kinds have none.
  if (input.audience && input.kind !== "roadmap") {
    return json(422, {
      detail: `audience is for roadmaps only, not ${input.kind}`,
      problems: [{ code: "audience_not_roadmap", message: "audience is for roadmaps only" }],
    });
  }
  if (t.archived_at) {
    return json(422, {
      detail: `template '${t.key}' is archived; restore it to start new drafts`,
      problems: [{ code: "archived_template", message: "template is archived" }],
    });
  }
  const tv = input.template_version ? t.versions.find((v) => v.version === input.template_version) : latest(t);
  if (!tv) return notFound("Template version");
  if (input.theme && !st.themes.some((x) => x.key === input.theme)) return notFound("Theme");
  const title = input.title.trim();
  if (!title) return json(422, { detail: "title is required", problems: [{ code: "title", message: "title is required" }] });
  const base = input.slug ? slugify(input.slug) : slugify(title);
  if (input.slug && db.documents.some((d) => d.slug === base)) return json(409, { detail: `slug '${base}' is taken` });
  let slug = base;
  for (let n = 2; db.documents.some((d) => d.slug === slug); n++) slug = `${base}-${n}`;

  const created = now();
  const doc: DocumentRow = {
    id: uuid(),
    slug,
    title,
    status: "draft",
    kind: input.kind,
    template: t.key,
    template_version: String(tv.version),
    theme: input.theme ?? null,
    audience: input.audience ?? null,
    created_at: created,
    updated_at: created,
  };
  const check = checkTemplate(tv.body);
  const briefKeys = new Set(check.brief);
  const sections = skeleton(tv.body).map(({ h, i, raw, md }) => {
      const heading = h.level === 1 ? title : h.text;
      const key = h.key ?? `s-${i + 1}`;
      return {
        id: uuid(),
        section_key: key,
        ordinal: i,
        level: h.level,
        heading,
        body_md: md,
        body_text: plainText(md),
        content_hash: hash(heading + "\n" + md),
        citation_keys: [],
        layer: briefKeys.has(key) ? ("brief" as const) : ("detail" as const),
        notes: briefKeys.has(key) ? presenterNotes(raw) : null,
      };
    });
  const v: VersionRow = {
    id: uuid(),
    document_id: doc.id,
    number: 1,
    content_hash: hash(sections.map((s) => s.content_hash).join("")),
    snapshot: null,
    warnings: [],
    // #255: as the API, the skeleton has no content yet.
    notes: [{ code: "template_only", message: "the template's skeleton, with no content yet", section_keys: [], refs: {} }],
    imported_by: "4a1c8e6f-2d93-4b57-9e0a-c3f6d81b2a75",
    imported_by_name: "API token draft-picker",
    approved_at: null,
    approval_lapses: [],
    brief_source: briefKeys.size ? "draft" : "none",
    created_at: created,
    front_matter: { document: slug, title, template: t.key },
    sections,
    citations: [],
  };
  db.documents.push(doc);
  db.versions.push(v);
  return json(201, {
    document_id: doc.id,
    slug,
    title,
    kind: input.kind,
    template: t.key,
    template_version: tv.version,
    theme: input.theme ?? null,
    version: 1,
  } satisfies Schemas["StartDraftOut"]);
}

// ---------------------------------------------------------------- state + routing

function seedState(scenario?: string | null): LaneFState {
  const themes: ThemeRow[] = THEME_SEEDS.map((t) => ({
    id: uuid(),
    key: t.key,
    name: t.name,
    kind: t.kind,
    description: t.description,
    tokens: t.tokens,
    css: t.css,
    slide_css: null,
    builtin: true,
    archived_at: null,
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
  }));
  const templates: TemplateRow[] = TEMPLATE_SEEDS.map((t) => {
    const v = newVersion(1, templateBody(t), null, null);
    return {
      id: uuid(),
      key: t.key,
      name: t.name,
      kind: t.kind,
      description: t.description,
      builtin: true,
      archived_at: null,
      created_at: SEEDED_AT,
      versions: [{ ...v, created_at: SEEDED_AT }],
    };
  });
  return { templates, themes, snapshots: [], defaults: {}, overrides: scenario === LEGACY_OVERRIDE_SCENARIO ? [legacyOverride()] : [] };
}

/**
 * As the API (GET /v1/priorities/snapshots/{id}/compare): the snapshot's order next to the
 * live ranking of its method, restricted to the features it ranks, with the check's
 * problems per row, and the run and checkpoint that decide it.
 */
function compare(db: Db, snap: SnapshotRow): Schemas["CompareOut"] {
  const live = ranking(snap.method);
  const order = [...(snap.check_result?.order ?? snap.ranking.map((f) => ({ key: f.key, rank: f.rank, explanation: f.run_explanation ?? null })))].sort(
    (a, b) => a.rank - b.rank,
  );
  const keys = order.map((o) => o.key);
  const restricted = live.features.filter((f) => keys.includes(f.key)).map((f) => f.key);
  const problems = snap.check_result?.problems ?? [];
  const rows = order.map((o) => {
    const f = live.features.find((x) => x.key === o.key);
    const at = restricted.indexOf(o.key);
    const liveRank = at < 0 ? null : at + 1;
    return {
      key: o.key,
      title: f?.title ?? snap.ranking.find((x) => x.key === o.key)?.title ?? o.key,
      run_rank: o.rank,
      live_rank: liveRank,
      delta: liveRank == null ? null : liveRank - o.rank,
      run_explanation: o.explanation ?? null,
      live_explanation: f ? [f.explanation.formula, ...f.explanation.steps.slice(0, 3)].join(" ") : null,
      problems: problems.filter((p) => p.feature === o.key),
    };
  });
  const run = snap.run_id ? db.runs?.runs.find((r) => r.id === snap.run_id) : undefined;
  const cp = run?.checkpoints.find((c) => c.id === snap.checkpoint_id);
  return {
    snapshot: snap,
    rows,
    live_generated_at: live.generated_at,
    run: run ? { id: run.id, flow_title: run.flow_title, status: run.status, document_slug: run.document_slug ?? null } : null,
    checkpoint: cp
      ? { id: cp.id, status: cp.status, approver_role: cp.approver_role, cannot_approve: cannotApproveNow(db.runs, cp), can_decide: cp.status === "pending" }
      : null,
  };
}

function state(db: Db, scenario?: string | null): LaneFState {
  db.lane_f ??= seeded("lane-f", () => seedState(scenario));
  return db.lane_f;
}

const isMethod = (m: string | null): m is Method => !!m && (METHODS as string[]).includes(m);
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Each goal term titled as the baseline titles the goal now, as the API reads it. */
function goalTitles(db: Db, r: Schemas["PriorityRanking"]): Schemas["PriorityRanking"] {
  const titles = new Map((db.baseline.entities).filter((e) => e.type === "goal").map((e) => [e.key, e.title]));
  for (const f of r.features) for (const g of f.explanation.goals) g.title = titles.get(g.goal) ?? g.title;
  return r;
}

/**
 * Handles /v1/priorities, /v1/templates, /v1/themes and /v1/drafts; returns null for
 * any other route so server.ts carries on.
 */
export async function laneF(
  db: Db,
  req: Request,
  p: string[],
  m: string,
  role?: Schemas["Me"]["role"],
  scenario?: string | null,
): Promise<Response | null> {
  const area = p[1];
  if (!["priorities", "templates", "themes", "drafts"].includes(area)) return null;
  const st = state(db, scenario);
  const q = new URL(req.url).searchParams;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (area === "priorities") {
    if (p.length === 2 && m === "GET") {
      const method = q.get("method") ?? "goal_weighted";
      if (!isMethod(method)) return json(422, { detail: `unknown method '${method}'` });
      const people = q.get("overrides") !== "false";
      const goals = db.baseline.entities.filter((e) => e.type === "goal").map((e) => [e.id, e.title]);
      const track = calibration(db.quality, Object.fromEntries(goals));
      return json(200, goalTitles(db, applyOverrides(ranking(method, track), people ? overrideInputs(st.overrides ?? []) : [])));
    }
    if (p[2] === "overrides") return overridesRoute(st, db.session ?? "someone", req, p, m);
    if (p[2] === "snapshots") {
      // C8: people's snapshots and the runs' orders; readers see saved ones unless they ask.
      const all = () => [...st.snapshots, ...(db.runs?.priority_snapshots ?? [])];
      const status = q.get("status") ?? "saved";
      if (!["saved", "proposed", "discarded", "all"].includes(status)) return json(422, { detail: `unknown status '${status}'` });
      const shown = (s: SnapshotRow) => status === "all" || (s.status ?? "saved") === status;
      if (p.length === 3 && m === "GET") {
        return json(
          200,
          all()
            .filter(shown)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map(({ params, ranking, checkpoint_id, scope_id, check_result, ...s }) => (void params, void ranking, void checkpoint_id, void scope_id, void check_result, s)),
        );
      }
      if (p.length === 3 && m === "POST") {
        const input = (await body<Schemas["PrioritySnapshotCreate"]>()) ?? { method: "goal_weighted" };
        const method = input.method ?? "goal_weighted";
        if (!isMethod(method)) return json(422, { detail: `unknown method '${method}'` });
        const active = overrideInputs(st.overrides ?? []);
        const r = applyOverrides(ranking(method), active);
        const snap: SnapshotRow = {
          id: uuid(),
          method,
          created_by: db.user_id,
          created_at: now(),
          note: input.note ?? null,
          feature_count: r.features.length,
          top: r.features.slice(0, 5).map((f) => f.key),
          status: "saved",
          run_id: null,
          document: null,
          params: { overrides: r.features.flatMap((f) => (f.override ? [f.override.id] : [])) },
          ranking: r.features,
        };
        st.snapshots.push(snap);
        return json(201, snap);
      }
      if (p.length === 4 && m === "GET") {
        const snap = all().find((s) => s.id === p[3] && shown(s));
        return snap ? json(200, snap) : notFound("Snapshot");
      }
      if (p.length === 5 && p[4] === "compare" && m === "GET") {
        const snap = all().find((s) => s.id === p[3]);
        return snap ? json(200, compare(db, snap)) : notFound("priority snapshot");
      }
    }
    return notFound("Route");
  }

  if (area === "templates") {
    if (p.length === 2 && m === "GET") {
      const kind = q.get("kind");
      const archived = q.get("include_archived") === "true";
      return json(
        200,
        st.templates
          .filter((t) => (!kind || t.kind === kind) && (archived || !t.archived_at))
          .map(templateSummary),
      );
    }
    if (p.length === 2 && m === "POST") {
      const input = await body<Schemas["TemplateCreate"]>();
      if (!KEY_RE.test(input.key ?? "")) {
        return json(422, {
          detail: "key must be lowercase letters, digits and hyphens",
          problems: [{ code: "invalid_key", message: "key must be lowercase letters, digits and hyphens" }],
        });
      }
      if (st.templates.some((t) => t.key === input.key)) return json(409, { detail: `template '${input.key}' already exists` });
      const check = checkTemplate(input.body, input.required_sections, new Set(st.themes.map((t) => t.key)));
      if (!check.valid) return json(422, { detail: `template rejected: ${check.problems[0].message}`, problems: check.problems });
      const t: TemplateRow = {
        id: uuid(),
        key: input.key,
        name: input.name,
        kind: input.kind,
        description: input.description ?? null,
        builtin: false,
        archived_at: null,
        created_at: now(),
        versions: [newVersion(1, input.body, input.required_sections, db.user_id)],
      };
      st.templates.push(t);
      return json(201, templateOut(t));
    }
    if (p[2] === "validate" && m === "POST") {
      const input = await body<Schemas["TemplateValidateIn"]>();
      const c = checkTemplate(input.body ?? "", input.required_sections, new Set(st.themes.map((t) => t.key)));
      return json(200, {
        valid: c.valid,
        problems: c.problems,
        warnings: c.warnings,
        brief_sections: c.brief,
        section_keys: c.section_keys,
        suggested_theme: c.suggested_theme,
        suggest_when: c.suggest_when,
      } satisfies Schemas["TemplateValidateOut"]);
    }
    const t = st.templates.find((x) => x.key === p[2]);
    if (!t) return notFound("Template");
    if (p.length === 3 && m === "GET") return json(200, templateOut(t));
    if (p.length === 3 && m === "DELETE") {
      t.archived_at ??= now();
      return json(200, templateOut(t));
    }
    if (p[3] === "restore" && m === "POST") {
      t.archived_at = null;
      return json(200, templateOut(t));
    }
    if (p[3] === "versions" && p[4] && m === "GET") {
      const v = t.versions.find((x) => x.version === Number(p[4]));
      return v ? json(200, v) : notFound("Template version");
    }
    if (p.length === 3 && m === "PATCH") {
      const input = await body<Schemas["TemplateUpdate"]>();
      const last = latest(t);
      const nextBody = input.body ?? last.body;
      const required = input.required_sections;
      if (nextBody !== last.body || (required != null && required.join() !== last.required_sections.join())) {
        const check = checkTemplate(nextBody, required, new Set(st.themes.map((x) => x.key)));
        if (!check.valid) return json(422, { detail: `template rejected: ${check.problems[0].message}`, problems: check.problems });
        t.versions.push(newVersion(last.version + 1, nextBody, required, db.user_id));
      }
      if (input.name != null) t.name = input.name;
      if (input.description !== undefined) t.description = input.description;
      return json(200, templateOut(t));
    }
    return notFound("Route");
  }

  if (area === "themes") {
    if (p.length === 2 && m === "GET") {
      const kind = q.get("kind");
      const archived = q.get("include_archived") === "true";
      return json(
        200,
        st.themes.filter((t) => (!kind || t.kind === kind || t.kind === "any") && (archived || !t.archived_at)),
      );
    }
    if (p.length === 2 && m === "POST") {
      const input = await body<Schemas["ThemeCreate"]>();
      if (!KEY_RE.test(input.key ?? "")) {
        return json(422, {
          detail: "key must be lowercase letters, digits and hyphens",
          problems: [{ code: "invalid_key", message: "key must be lowercase letters, digits and hyphens" }],
        });
      }
      if (st.themes.some((t) => t.key === input.key)) return json(409, { detail: `theme '${input.key}' already exists` });
      const tk = tokens(input.tokens ?? {});
      const problems = checkTheme(tk, input.css ?? "", input.slide_css);
      if (problems.length) return rejectTheme(problems, "theme");
      const t: ThemeRow = {
        id: uuid(),
        key: input.key,
        name: input.name,
        kind: input.kind ?? "any",
        description: input.description ?? null,
        tokens: tk,
        css: input.css ?? "",
        slide_css: input.slide_css?.trim() ? input.slide_css : null,
        builtin: false,
        archived_at: null,
        created_at: now(),
        updated_at: now(),
      };
      st.themes.push(t);
      return json(201, t);
    }
    if (p[2] === "validate" && m === "POST") {
      const input = await body<Schemas["ThemeValidateIn"]>();
      const problems = checkTheme(input.tokens, input.css ?? "", input.slide_css);
      return json(200, { valid: problems.length === 0, problems } satisfies Schemas["ThemeValidateOut"]);
    }
    if (p[2] === "preview" && m === "POST") {
      const input = await body<Schemas["ThemePreviewIn"]>();
      if (input.view === "slides") {
        return new Response(slidePreviewHtml(input.tokens ?? {}, input.slide_css, input.kind ?? "prd", input.slide_variant), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(previewHtml(input.tokens ?? {}, input.css ?? "", input.kind ?? "prd"), {
        headers: { "content-type": "text/html" },
      });
    }
    const t = st.themes.find((x) => x.key === p[2]);
    if (!t) return notFound("Theme");
    if (p.length === 3 && m === "GET") return json(200, t);
    if (p.length === 3 && m === "DELETE") {
      t.archived_at ??= now();
      return json(200, t);
    }
    if (p[3] === "restore" && m === "POST") {
      t.archived_at = null;
      return json(200, t);
    }
    if (p.length === 3 && m === "PATCH") {
      const input = await body<Schemas["ThemeUpdate"]>();
      const nextTokens = input.tokens ?? t.tokens;
      const css = input.css ?? t.css;
      // Left out keeps the slide CSS; null or blank clears it (as the API does).
      const slideCss = "slide_css" in input ? (input.slide_css?.trim() ? input.slide_css! : null) : (t.slide_css ?? null);
      const problems = checkTheme(nextTokens, css, slideCss);
      if (t.builtin && "slide_css" in input && slideCss) {
        problems.push({
          code: "builtin_slide_css",
          message: "a built-in theme keeps its own slide design; create a company theme to write slide CSS",
          line: null,
        });
      }
      if (problems.length) return rejectTheme(problems, "theme");
      Object.assign(t, {
        tokens: nextTokens,
        css,
        slide_css: slideCss,
        name: input.name ?? t.name,
        kind: input.kind ?? t.kind,
        description: input.description !== undefined ? input.description : t.description,
        updated_at: now(),
      });
      return json(200, t);
    }
    return notFound("Route");
  }

  // drafts
  if (p[2] === "recommend" && m === "POST") return recommend(st, await body<Schemas["RecommendIn"]>());
  if (p[2] === "defaults") {
    if (m === "GET") return json(200, st.defaults);
    if (m === "PUT") {
      const input = await body<Schemas["DraftDefaults"]>();
      const problems: Problem[] = [];
      for (const kind of ["prd", "roadmap"] as const) {
        const c = input[kind];
        if (!c) continue;
        if (!st.templates.some((t) => t.key === c.template && t.kind === kind && !t.archived_at)) {
          problems.push({ code: "unknown_template", message: `${kind}: no live ${kind} template '${c.template}'` });
        }
        if (c.theme && !st.themes.some((t) => t.key === c.theme && !t.archived_at)) {
          problems.push({ code: "unknown_theme", message: `${kind}: no live theme '${c.theme}'` });
        }
      }
      if (problems.length) return json(422, { detail: "defaults rejected", problems });
      // As the API does: the body replaces the setting (send both kinds to keep both).
      st.defaults = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v != null));
      return json(200, st.defaults);
    }
  }
  if (p.length === 2 && m === "POST") {
    const input = await body<Schemas["StartDraftIn"]>();
    // As the API (MIN_STARTER_ROLE): a vision or a product strategy is an owner's to start.
    const words = input.kind === "vision" ? "a vision" : input.kind === "strategy" ? "a product strategy" : null;
    if (words && role !== "owner") return json(403, { detail: `Only an owner can start ${words}` });
    return startDraft(db, st, input);
  }
  return notFound("Route");
}
