import { goalTree, scoredConfidence } from "@/lib/goal-tree";
import type { EntityOut, Schemas } from "@/lib/api/client";

type RevisionOut = Schemas["RevisionOut"];

/**
 * A goal figure read from its attrs, anchored to the value rather than the first digit:
 * "45%" -> 45 "%", "400 clinics by 2027" -> 400 "clinics", "FY26 revenue $4M" -> 4000000 "$",
 * "p95 < 200ms" -> 200 "ms", "10-15%" -> the range 10 to 15 "%". `value` is in plain units
 * (k, M and B applied); `unit` is "%", a time unit, a counted noun or "".
 */
export type Figure = {
  value: number;
  unit: string;
  currency: string;
  /** The figure was written with k, M or B: distances read the same way ("300k"). */
  compact: boolean;
  /** A range ("10-15%"): its two bounds, low first. */
  range: [number, number] | null;
};

const SCALE: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  thousand: 1e3,
  M: 1e6,
  mn: 1e6,
  million: 1e6,
  B: 1e9,
  bn: 1e9,
  billion: 1e9,
};
/** Time units in milliseconds, by the spelling they are written in. */
const TIME: Record<string, { ms: number; unit: string }> = {
  ms: { ms: 1, unit: "ms" },
  s: { ms: 1e3, unit: "s" },
  sec: { ms: 1e3, unit: "s" },
  secs: { ms: 1e3, unit: "s" },
  second: { ms: 1e3, unit: "s" },
  seconds: { ms: 1e3, unit: "s" },
  min: { ms: 6e4, unit: "min" },
  mins: { ms: 6e4, unit: "min" },
  minute: { ms: 6e4, unit: "min" },
  minutes: { ms: 6e4, unit: "min" },
  h: { ms: 3.6e6, unit: "h" },
  hr: { ms: 3.6e6, unit: "h" },
  hrs: { ms: 3.6e6, unit: "h" },
  hour: { ms: 3.6e6, unit: "h" },
  hours: { ms: 3.6e6, unit: "h" },
  day: { ms: 8.64e7, unit: "days" },
  days: { ms: 8.64e7, unit: "days" },
};
/** Words after a number that are not its unit: "400 by 2027", "8% or less". */
const NOT_UNITS = new Set(["by", "in", "on", "at", "to", "from", "for", "and", "or", "of", "per", "within", "before", "after", "less", "more", "fewer"]);

const NUM = String.raw`\d+(?:\.\d+)?`;
// [1] currency, [2] number, [3] range currency, [4] range number, [5] scale, [6] what follows.
const CANDIDATE = new RegExp(
  String.raw`(?:([$€£])\s?)?(${NUM})(?:\s?(?:-|–|to)\s?([$€£])?(${NUM}))?(?:\s?(k|K|M|mn|B|bn|thousand|million|billion)(?![\p{L}\d]))?(\s*(?:%|[\p{L}][\p{L}-]*))?`,
  "gu",
);

type Candidate = Figure & { score: number };

function candidate(text: string, m: RegExpExecArray): Candidate | null {
  // A number glued to letters before it is a name, not a value: FY26, p95, v2.
  const before = text[m.index - 1];
  if (before && /[\p{L}\d.]/u.test(before)) return null;
  const scale = m[5] ? SCALE[m[5]] : 1;
  const low = Number(m[2]) * scale;
  const high = m[4] != null ? Number(m[4]) * scale : null;
  const currency = m[1] ?? m[3] ?? "";
  let unit = "";
  const after = m[6]?.trim() ?? "";
  if (after === "%") unit = "%";
  else if (after) {
    const word = after.toLowerCase();
    if (TIME[after] || TIME[word]) unit = (TIME[after] ?? TIME[word]).unit;
    else if (!NOT_UNITS.has(word)) unit = word;
  }
  const marked = currency !== "" || m[5] != null || unit === "%" || TIME[unit] != null;
  const year = !marked && !unit && high == null && /^(19|20|21)\d\d$/.test(m[2]);
  return {
    value: low,
    unit,
    currency,
    compact: m[5] != null,
    range: high != null ? [Math.min(low, high), Math.max(low, high)] : null,
    score: year ? -1 : marked ? 2 : unit ? 1 : 0,
  };
}

export function parseFigure(raw: unknown): Figure | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, unit: "", currency: "", compact: false, range: null } : null;
  if (typeof raw !== "string") return null;
  const text = raw.replace(/(\d),(?=\d{3}\b)/g, "$1");
  let best: Candidate | null = null;
  for (const m of text.matchAll(CANDIDATE)) {
    const c = candidate(text, m);
    if (c && (!best || c.score > best.score)) best = c;
  }
  if (!best) return null;
  return { value: best.value, unit: best.unit, currency: best.currency, compact: best.compact, range: best.range };
}

export type Direction = { way: "down" | "up"; strict: boolean };

const DOWN_STRICT = /\b(below|under|less than|fewer than)\b|<(?!=)/i;
const DOWN = /\b(reduce[sd]?|cut|lower|decrease[sd]?|drop|shrink|at most|no more than|max(imum)?)\b|≤|<=/i;
const UP_STRICT = /\b(above|over|more than|greater than)\b|>(?!=)/i;
const UP = /\b(raise[sd]?|grow|increase[sd]?|boost|at least|no less than|min(imum)?)\b|≥|>=/i;
/** Verbs in a goal's title that say which way it goes ("Cut early churn"). */
const TITLE_DOWN = /\b(reduce|cut|lower|decrease|shrink|drop)\b/i;
const TITLE_UP = /\b(raise|grow|increase|boost)\b/i;

/** The direction the target text says, earliest word first; null for a bare target. */
export function direction(raw: unknown): Direction | null {
  if (typeof raw !== "string") return null;
  const hits = (
    [
      [DOWN_STRICT, { way: "down", strict: true }],
      [DOWN, { way: "down", strict: false }],
      [UP_STRICT, { way: "up", strict: true }],
      [UP, { way: "up", strict: false }],
    ] as const
  )
    .map(([re, d]) => ({ at: raw.search(re), d }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);
  return hits[0] ? { ...hits[0].d } : null;
}

export type GoalView = {
  id: string;
  /** G1, G2… in the baseline's order (heaviest first): an order, never drawn (#304). */
  tag: string;
  title: string;
  /** The company's code ("G-B"), if it has one, and the name after it. */
  code: string | null;
  name: string;
  metric: string | null;
  proposed: boolean;
  /** 0-100, or null when the baseline has none. */
  confidence: number | null;
  current: Figure | null;
  /** The current value as written ("38%"), or null when the goal has none. */
  currentText: string | null;
  target: Figure | null;
  /** The target as written ("below 8%"). */
  targetText: string | null;
  /** The direction the words say (target first, then the title's verb); null when they say none. */
  said: Direction | null;
  /** B5: the goal has a typed target (unit, comparison and number); else Home reads its text. */
  typed: boolean;
  /** What the goal still needs to be measurable (goal_check.missing); null when not known. */
  missing: string[] | null;
  /** The current value is typed with its day: the goal may have dated measurements for its trend. */
  measured: boolean;
  /** #345: the parent goal's id for a subgoal; null for a goal. */
  parentId: string | null;
  /** #345: how many subgoals it has. */
  subgoals: number;
  /** #345: progress 0-1, its own measurement ("own") or rolled up from its subgoals ("subgoals"). */
  progress: { value: number | null; source: "own" | "subgoals" | null } | null;
};

/** B5 typed units as Home's figures: "%" and time units as is, currencies as a symbol, else a counted noun. */
const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
function typedFigure(value: unknown, unit: unknown): Figure | null {
  if (typeof value !== "number" || !Number.isFinite(value) || typeof unit !== "string" || !unit) return null;
  const currency = CURRENCY_SYMBOL[unit] ?? "";
  return { value, unit: currency ? "" : unit, currency, compact: !!currency && Math.abs(value) >= 1e3, range: null };
}
const COMPARISON_WAY: Record<string, Direction> = {
  at_least: { way: "up", strict: false },
  above: { way: "up", strict: true },
  at_most: { way: "down", strict: false },
  below: { way: "down", strict: true },
};

/** A typed figure as written: "45%", "$4M", "2 min", "400 teams". */
function typedText(f: Figure): string {
  if (f.currency) return `${f.currency}${amount(f.value, f.compact)}`;
  return f.unit === "%" ? `${f.value}%` : `${f.value} ${f.unit}`;
}

const text = (v: unknown) => (v == null || v === "" ? null : String(v));

/** Live goals, heaviest first, each followed by its subgoals, tagged G1, G1.1, G2… as the Baseline tags them. */
export function goalViews(entities: EntityOut[], numbered: EntityOut[] = entities): GoalView[] {
  return goalTree(entities, numbered).map(({ goal: g, tag, code, name, parentId, children }) => {
    const a = g.attrs ?? {};
    const titled = TITLE_DOWN.test(g.title) ? "down" : TITLE_UP.test(g.title) ? "up" : null;
    // B5: typed values first; the text parser is the fallback for goals still on `*_text`.
    const target = COMPARISON_WAY[a.comparison as string] ? typedFigure(a.target, a.unit) : null;
    const current = typedFigure(a.current, a.unit);
    const targetRaw = a.target_text ?? a.target;
    const currentRaw = a.current_text ?? a.current;
    // qa-plan-4: the Baseline's rule (no evidence, no score), so Plan's ring and the Baseline's Goals table agree.
    const scored = scoredConfidence(g.confidence, g.evidence_count);
    return {
      id: g.id,
      tag,
      parentId,
      subgoals: children,
      progress: g.progress ? { value: g.progress.value ?? null, source: g.progress.source ?? null } : null,
      title: g.title,
      code,
      name,
      metric: typeof a.metric === "string" ? a.metric : null,
      proposed: g.status === "proposed",
      confidence: scored == null ? null : Math.round(scored * 100),
      current: current ?? parseFigure(currentRaw),
      currentText: current ? typedText(current) : text(currentRaw),
      target: target ?? parseFigure(targetRaw),
      targetText: target ? typedText(target) : text(targetRaw),
      said: target
        ? COMPARISON_WAY[a.comparison as string]
        : (direction(targetRaw) ?? (titled ? { way: titled, strict: false } : null)),
      typed: !!target,
      missing: g.goal_check?.missing ?? null,
      measured: !!current && typeof a.current_as_of === "string",
    };
  });
}

/** A noun's one spelling for comparing units: "clinics" and "clinic" match. */
const noun = (u: string) => (u.length > 3 && u.endsWith("s") ? u.slice(0, -1) : u);

/** Both figures measure the same thing; a bare current number counts in the target's noun or currency. */
function sameUnit(c: Figure, t: Figure): boolean {
  if (c.currency && t.currency && c.currency !== t.currency) return false;
  if (c.currency && !t.currency) return false;
  const ct = TIME[c.unit];
  const tt = TIME[t.unit];
  if (ct || tt) return !!ct && !!tt;
  if (c.unit === "%" || t.unit === "%") return c.unit === t.unit;
  return c.unit === "" || noun(c.unit) === noun(t.unit);
}

/** A figure in a comparable base: time in milliseconds, everything else as is. */
const base = (f: Figure, v = f.value) => v * (TIME[f.unit]?.ms ?? 1);

export type Progress = {
  /**
   * met; to go; short (equal to a strict below/above bound); raw (no distance can be given);
   * none (no current value); notarget (a confirmed goal with no typed target to measure against, B5).
   */
  state: "met" | "togo" | "short" | "raw" | "none" | "notarget";
  /** What Home shows under the goal: "5 pts to go", "Target met", "Not below", "" or "No current value yet". */
  text: string;
  /** The distance in the target's unit, when there is one. */
  distance?: number;
  /** "pts", "min", "clinics"…: the distance's unit, "" for a plain count. */
  unit?: string;
  /** The distance as shown, with its currency and k/M/B: "300k", "$900k", "1.6". */
  amount?: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 900000 -> "900k", 1200000 -> "1.2M" when the goal is written that way; else the plain figure. */
export function amount(n: number, compact: boolean): string {
  if (compact) {
    for (const [s, v] of [["B", 1e9], ["M", 1e6], ["k", 1e3]] as const) {
      if (Math.abs(n) >= v) return `${round1(n / v)}${s}`;
    }
  }
  return `${round1(n)}`;
}

/**
 * Where a goal stands against its target. The direction comes from the words ("reduce",
 * "below", "at least", a verb in the title), else from where the metric started in its
 * history, else reaching or passing the target meets it. A strict bound ("below 8%") is
 * not met at 8. Units that do not match, or a side that cannot be read, give no distance:
 * Home then shows both strings, never a wrong number.
 */
export function assess(g: GoalView, history?: Point[]): Progress {
  // Decided 2026-10-21, B5 "Vague goals": confirmed, but nothing to measure it against.
  // qa-plan-14: a target written in words ("below 8%") is shown, so the goal never says "No
  // target" beside it: what is missing to the reader is the current value.
  if (!g.proposed && !g.typed && g.missing?.includes("target") && (!g.currentText || !g.targetText)) {
    return { state: "notarget", text: g.targetText ? "No current value yet" : "No target" };
  }
  if (!g.currentText) return { state: "none", text: "No current value yet" };
  const c = g.current;
  const t = g.target;
  if (!c || !t || c.range || !sameUnit(c, t)) return { state: "raw", text: "" };
  const first = history?.[0]?.value;
  const [lo, hi] = t.range ?? [t.value, t.value];
  const dir: Direction = g.said ?? {
    way: first != null && first > hi ? "down" : "up",
    strict: false,
  };
  // A range is met on entering it: the bound the metric reaches first moving the goal's way.
  const bound = base(t, dir.way === "up" ? lo : hi);
  const now = base(c);
  const left = dir.way === "up" ? bound - now : now - bound;
  if (left === 0 && dir.strict) return { state: "short", text: dir.way === "down" ? "Not below" : "Not above" };
  if (left <= 0) return { state: "met", text: "Target met" };
  const distance = left / (TIME[t.unit]?.ms ?? 1);
  const unit = t.unit === "%" ? "pts" : t.unit;
  let shown = `${t.currency || c.currency}${amount(distance, t.compact || c.compact)}`;
  // Not met yet, however small the gap: a gap that rounds to 0 is shown to one significant digit.
  if (Number(shown.replace(/^\D+/, "").replace(/[kMB]$/, "")) === 0) {
    shown = `${t.currency || c.currency}${Number(distance.toPrecision(1))}`;
  }
  return { state: "togo", text: `${shown}${unit ? ` ${unit}` : ""} to go`, distance, unit, amount: shown };
}

export type Point = { at: string; value: number };

const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;

/**
 * The goal's `current` over time, from the revisions the baseline records whenever attrs
 * change: one point per revision that set a readable value, the six months up to the latest.
 */
export function historyOf(revisions: RevisionOut[]): Point[] {
  const points = revisions
    .map((r) => {
      const attrs = (r.after?.attrs ?? null) as Record<string, unknown> | null;
      const f = attrs ? parseFigure(attrs.current) : null;
      return f ? { at: r.created_at, value: f.value } : null;
    })
    .filter((p): p is Point => p !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  // Drop repeats: a revision that changed something else carries the same value.
  const series = points.filter((p, i) => i === 0 || p.value !== points[i - 1].value || i === points.length - 1);
  const last = series.at(-1);
  if (!last) return [];
  const from = Date.parse(last.at) - SIX_MONTHS_MS;
  return series.filter((p) => Date.parse(p.at) >= from);
}

/** B5: a goal's dated measurements as trend points, oldest first (the last 12). */
export function measurementPoints(rows: { measured_on: string; value: number }[]): Point[] {
  return rows
    .map((r) => ({ at: `${r.measured_on}T00:00:00Z`, value: r.value }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-12);
}

/**
 * A trend's change in words (qa-company-44): "+7 pts in 6 months", "−1.2k sign-ups in 1 month",
 * "+$300k in 3 months"; points for a percentage, the goal's unit otherwise.
 */
export function changeText(change: number, f: Figure | null, months: number): string {
  const sign = change > 0 ? "+" : "−";
  const n = `${f?.currency ?? ""}${amount(Math.abs(change), !!f?.compact)}`;
  const unit = !f ? "" : f.unit === "%" ? "pts" : f.unit;
  return `${sign}${n}${unit ? ` ${unit}` : ""} in ${months} ${months === 1 ? "month" : "months"}`;
}

/** Whole months the series spans, at least one: the months after a change. */
export function spanMonths(points: Point[]): number {
  if (points.length < 2) return 0;
  const ms = Date.parse(points.at(-1)!.at) - Date.parse(points[0].at);
  return Math.max(1, Math.round(ms / (30.4 * 24 * 3600 * 1000)));
}

/** The current value in its own terms: "38%", "900k", "$3.1M", "260 ms", "236" (a counted noun goes after the target). */
export function formatFigure(f: Figure): string {
  const n = `${f.currency}${amount(f.value, f.compact)}`;
  if (f.unit === "%") return `${n}%`;
  if (TIME[f.unit]) return `${n} ${f.unit}`;
  return n;
}

/** Home shows this many goals, one row on a desktop; the rest are in the Baseline. */
export const MAX_GOALS = 4;

/** The goals Home shows: confirmed first, then proposed, each in baseline order; subgoals show inside their goal's card. Only these load a trend. */
export function shownGoals(goals: GoalView[]): GoalView[] {
  const top = goals.filter((g) => !g.parentId);
  return [...top.filter((g) => !g.proposed), ...top.filter((g) => g.proposed)].slice(0, MAX_GOALS);
}
