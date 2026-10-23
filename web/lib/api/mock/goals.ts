/**
 * Typed goal fields (B5) for the mock: the checks of api/oracle/baseline/goals.py, its
 * goal_check, and the text reading Fill from text does (Home's parser, as
 * api/oracle/baseline/figures.py ports it). Generic, made-up data only.
 */
import { direction, parseFigure } from "@/app/home/_goals";
import type { Schemas } from "@/lib/api/client";

type Attrs = Record<string, unknown>;
export type GoalProblem = { code: string; message: string; where: string };
export type GoalCheck = Schemas["GoalCheck"];

const CURRENCIES = ["USD", "EUR", "GBP"];
const UNITS = ["%", ...CURRENCIES, "ms", "s", "min", "h", "days"];
const COMPARISONS = ["at_least", "above", "at_most", "below"];
const HORIZONS = ["short", "medium", "long"];
const MEASURABLE = ["metric", "unit", "comparison", "target", "horizon", "owner"] as const;
const NOUN = /^[a-z][a-z -]{0,23}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_DAYS = 45;

export const MESSAGES: Record<string, string> = {
  bad_metric: "The metric says what is counted, in 3 to 200 characters",
  bad_unit: "The unit is %, USD, EUR, GBP, ms, s, min, h, days or a counted noun",
  bad_comparison: "Which way is success: at_least, above, at_most or below",
  target_not_number: "The target is a number",
  start_not_number: "The start value is a number",
  current_not_number: "The current value is a number",
  percent_negative: "A percentage is 0 or more",
  target_needs_unit: "A target needs its unit and which way is success",
  current_needs_date: "A current value needs the day it was measured",
  current_date_future: "The current value cannot be measured in the future",
  bad_date: "A date is written YYYY-MM-DD",
  bad_horizon: "The horizon is short, medium or long",
  owner_not_member: "The owner must be a member of this Oracle",
  weight_out_of_range: "The weight is a number above 0 and at most 10",
};

const set = (a: Attrs, k: string) => a[k] != null;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export const unitOk = (v: unknown) => typeof v === "string" && (UNITS.includes(v) || NOUN.test(v));

/** The browser's day, YYYY-MM-DD (the company's day in the API). */
export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** goals.problems: every problem with the typed fields; `isMember` checks the owner. */
export function goalProblems(a: Attrs, isMember: (id: string) => boolean, on = todayIso()): GoalProblem[] {
  const out: [string, string][] = [];
  if (set(a, "metric")) {
    const m = a.metric;
    if (typeof m !== "string" || m.trim().length < 3 || m.trim().length > 200) out.push(["bad_metric", "metric"]);
  }
  if (set(a, "unit") && !unitOk(a.unit)) out.push(["bad_unit", "unit"]);
  if (set(a, "comparison") && !COMPARISONS.includes(a.comparison as string)) out.push(["bad_comparison", "comparison"]);
  for (const k of ["target", "start", "current"]) if (set(a, k) && !isNumber(a[k])) out.push([`${k}_not_number`, k]);
  if (a.unit === "%") for (const k of ["target", "start", "current"]) if (isNumber(a[k]) && a[k] < 0) out.push(["percent_negative", k]);
  const together = ["target", "unit", "comparison"].filter((k) => set(a, k));
  if (together.length && together.length < 3) out.push(["target_needs_unit", together[0]]);
  if (set(a, "current") && !set(a, "current_as_of")) out.push(["current_needs_date", "current"]);
  for (const k of ["current_as_of", "due"]) if (set(a, k) && !isDate(a[k])) out.push(["bad_date", k]);
  if (isDate(a.current_as_of) && (a.current_as_of as string) > on) out.push(["current_date_future", "current_as_of"]);
  if (set(a, "horizon") && !HORIZONS.includes(a.horizon as string)) out.push(["bad_horizon", "horizon"]);
  if (set(a, "owner") && !(typeof a.owner === "string" && UUID_RE.test(a.owner) && isMember(a.owner))) out.push(["owner_not_member", "owner"]);
  if (set(a, "weight") && !(isNumber(a.weight) && a.weight > 0 && a.weight <= 10)) out.push(["weight_out_of_range", "weight"]);
  return out.map(([code, k]) => ({ code, message: MESSAGES[code], where: `attrs.${k}` }));
}

/** The other fields a cross-field problem is about (goals._ALSO). */
const ALSO: Record<string, string[]> = {
  target_needs_unit: ["target", "unit", "comparison"],
  current_needs_date: ["current", "current_as_of"],
  current_date_future: ["current"],
  percent_negative: ["unit"],
};

/** goals.check: a person's write; a problem the goal already had is refused only when the write touches it. */
export function refusedProblems(after: Attrs, before: Attrs, isMember: (id: string) => boolean): GoalProblem[] {
  const found = goalProblems(after, isMember);
  const had = new Set(goalProblems(before, isMember).map((p) => `${p.code}:${p.where}`));
  const changed = new Set([...Object.keys(after), ...Object.keys(before)].filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])));
  return found.filter((p) => !had.has(`${p.code}:${p.where}`) || [p.where.slice(6), ...(ALSO[p.code] ?? [])].some((k) => changed.has(k)));
}

/** "2026-Q4" -> 2026-12-31, "2027-H1" -> 2027-06-30 (figures.period_end). */
function periodEnd(raw: unknown): string | null {
  const m = typeof raw === "string" ? /\b(\d{4})\s*-?\s*(Q[1-4]|H[12])\b/i.exec(raw) : null;
  if (!m) return null;
  const part = m[2].toUpperCase();
  const month = part[0] === "Q" ? Number(part[1]) * 3 : Number(part[1]) * 6;
  return `${m[1]}-${String(month).padStart(2, "0")}-${month === 6 || month === 9 ? 30 : 31}`;
}

function quarterEnd(on: Date, ahead = 0): string {
  const q = Math.floor(on.getMonth() / 3) + ahead;
  const year = on.getFullYear() + Math.floor(q / 4);
  const month = (q % 4) * 3 + 3;
  return `${year}-${String(month).padStart(2, "0")}-${month === 6 || month === 9 ? 30 : 31}`;
}

function addMonths(on: Date, months: number): string {
  return todayIso(new Date(on.getFullYear(), on.getMonth() + months, Math.min(on.getDate(), 28)));
}

/** Decision B2 Company goals: short = this quarter, medium = the next two, long = 12 to 24 months. */
function horizonWindow(h: string, on: Date): [string, string] {
  if (h === "short") return [todayIso(new Date(on.getFullYear(), Math.floor(on.getMonth() / 3) * 3, 1)), quarterEnd(on)];
  if (h === "medium") return [quarterEnd(on), quarterEnd(on, 2)];
  return [addMonths(on, 12), addMonths(on, 24)];
}

function horizonOf(due: string, on: Date): string {
  if (due <= quarterEnd(on)) return "short";
  return due < addMonths(on, 12) ? "medium" : "long";
}

const meets = (v: number, c: string, t: number) => ({ at_least: v >= t, above: v > t, at_most: v <= t, below: v < t })[c] ?? false;

/** goal_check: measurable, the missing fields in order, warnings and the problems it already has. */
export function goalCheck(a: Attrs, status: string, isMember: (id: string) => boolean, now = new Date()): GoalCheck {
  const on = todayIso(now);
  const found = goalProblems(a, isMember, todayIso(new Date(now.getTime() + 86_400_000)));
  const bad = new Set(found.map((p) => p.where.slice(6)));
  if (bad.has("target") || found.some((p) => p.code === "target_needs_unit")) ["target", "unit", "comparison"].forEach((k) => bad.add(k));
  const missing = MEASURABLE.filter((k) => !set(a, k) || bad.has(k));
  const warnings: string[] = [];
  const typed = !missing.some((k) => k === "target" || k === "unit" || k === "comparison");
  if (typed && ["start", "current"].some((k) => isNumber(a[k]) && !bad.has(k) && meets(a[k] as number, a.comparison as string, a.target as number))) {
    warnings.push("target_already_met");
  }
  if (isDate(a.due) && HORIZONS.includes(a.horizon as string)) {
    const [lo, hi] = horizonWindow(a.horizon as string, now);
    if ((a.due as string) < lo || (a.due as string) > hi) warnings.push("due_outside_horizon");
  }
  if (isDate(a.due) && (a.due as string) < on && status === "confirmed") warnings.push("due_past");
  if (isDate(a.current_as_of) && (now.getTime() - Date.parse(a.current_as_of as string)) / 86_400_000 > STALE_DAYS) warnings.push("stale_current");
  return { measurable: missing.length === 0, missing: [...missing], warnings, problems: found };
}

const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };
const comparisonOf = (d: ReturnType<typeof direction>) =>
  d == null ? "at_least" : d.way === "down" ? (d.strict ? "below" : "at_most") : d.strict ? "above" : "at_least";

/** goals.read_text: the typed values a goal's `*_text` keys read as, and the fields left as text. */
export function readText(a: Attrs, now = new Date()): { values: Attrs; left: string[] } {
  const read: Record<string, Attrs> = {};
  const left: string[] = [];
  if (a.target_text != null && !set(a, "target")) {
    const f = parseFigure(a.target_text);
    const unit = f && !f.range ? (f.currency ? CURRENCY[f.currency] : f.unit && unitOk(f.unit) ? f.unit : null) : null;
    if (f && unit) read.target = { target: f.value, unit, comparison: comparisonOf(direction(a.target_text)) };
    else left.push("target");
  }
  for (const k of ["start", "current"]) {
    if (a[`${k}_text`] == null || set(a, k)) continue;
    const f = parseFigure(a[`${k}_text`]);
    if (f && !f.range) read[k] = { [k]: f.value };
    else left.push(k);
  }
  if (a.horizon_text != null && !set(a, "horizon")) {
    const word = String(a.horizon_text).trim().toLowerCase();
    const due = periodEnd(a.horizon_text);
    if (HORIZONS.includes(word)) read.horizon = { horizon: word };
    else if (due) read.horizon = { horizon: horizonOf(due, now), ...(set(a, "due") ? {} : { due }) };
    else left.push("horizon");
  }
  if (a.weight_text != null && !set(a, "weight")) {
    const f = parseFigure(a.weight_text);
    if (f && !f.range && !f.unit && f.value > 0 && f.value <= 10) read.weight = { weight: f.value };
    else left.push("weight");
  }
  if (a.owner_text != null && !set(a, "owner")) left.push("owner");
  const values: Attrs = {};
  const codes = (x: Attrs) => new Set(goalProblems(x, () => true, todayIso(now)).map((p) => `${p.code}:${p.where}`));
  for (const [field, v] of Object.entries(read)) {
    const before = codes({ ...a, ...values });
    const after = codes({ ...a, ...values, ...v });
    if ([...after].every((c) => before.has(c))) Object.assign(values, v);
    else left.push(field);
  }
  return { values, left };
}
