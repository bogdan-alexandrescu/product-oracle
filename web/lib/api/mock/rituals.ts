/**
 * Mock of the cadence engine (H2, /v1/rituals and /v1/ritual-occurrences) and its Inbox
 * rows. Synthetic data only. The built-in rituals are seeded in every company (the API's
 * first tick does that); the "rituals" scenario adds a Monthly roadmap refresh pre-read an
 * owner prepared early (still Next on Company › Rituals until its time) and last week's
 * goals check-in, held, whose summary run failed. No
 * other scenario has occurrences, so other specs' Inbox counts stay as they were.
 *
 * The schedule maths is the API's (api/oracle/rituals/schedule.py): wall-clock times in the
 * schedule's IANA zone, stored in UTC.
 */
import { assess, goalViews } from "@/app/home/_goals";
import type { EntityOut, Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

import { companyStamp } from "./connections";
import { newCompany } from "./ids";

type RitualOut = Schemas["RitualOut"];
type OccurrenceOut = Schemas["OccurrenceOut"];
type Schedule = Schemas["RitualSchedule"] & { timezone: string };
type Role = "viewer" | "commenter" | "approver" | "owner";
type Member = { id: string; email: string; role: Role; status?: string };

/** A stored ritual: the API's record without what is derived on the way out. */
/** `attendees_edited_at`: when an owner last edited the attendees (the API's column; not on the way out). */
type Ritual = Omit<RitualOut, "last_pre_read" | "schedule"> & { schedule: Schedule; created_at: string; attendees_edited_at?: string | null };
/** A stored occurrence; the summary run finishes on its owner's `summary_reads`-th read. */
type Occurrence = Omit<OccurrenceOut, "kind" | "title" | "duration_min" | "owner_id" | "attendee_ids" | "timezone" | "read_by_me" | "decisions" | "summary_offered"> & {
  summary_reads?: number;
  read_by: string[];
};

export interface RitualsDb {
  rituals: Ritual[];
  occurrences: Occurrence[];
  mode: "on_demand" | "always";
  /** The Company time zone the rituals last followed (the API moves them on a change). */
  zone?: string;
}

/** A decision as the rituals mock reads it from the decision log (./decisions.ts). */
type LoggedDecision = { id: string; number: number; title: string; subjects: { [key: string]: unknown }[] };

export interface RitualsContext {
  me: Member;
  members: Member[];
  uuid: () => string;
  /** The Company time zone (Settings › Company). */
  companyTimezone: () => string;
  /** The decision log, for the decisions recorded with an occurrence. */
  decisions: () => LoggedDecision[];
  /** The baseline's goals (./baseline.ts), which the goals block reads as Home does (qa-company-6). */
  goals?: () => EntityOut[];
  /** H5: how many of a metrics review's variances are open (./metrics.ts). */
  openVariances?: (occurrenceId: string) => number;
  /** H11 "Watch the market" above Observe: Oracle writes the competitive digest. */
  marketWrites: () => boolean;
  /** H11 "Run rituals" at Act within limits: its max_run_usd (summaries._oracle_acts), else null. */
  ritualsActCap?: () => number | null;
  /** The Baseline rebuild (rebuild.py): H11 "Keep the baseline current" is at Draft or above. */
  baselineStarts?: () => boolean;
  /** B1's build at the ritual's knobs (rebuild.estimate_usd): $7.00, unless a scenario prices it otherwise. */
  rebuildUsd?: () => number;
  /** B1's Build the baseline, started as the API's create, estimate and start: the run's id, or the refusal. */
  startBaselineBuild?: () => Promise<{ id: string } | { error: string }>;
  /** A run's status in the runs mock, or null. */
  runStatus?: (id: string) => string | null;
  /** The last Build the baseline run that succeeded (the latest created), or null. */
  lastBaselineRun?: () => { id: string; created_at: string } | null;
  /** Record what Oracle did on its own ("Oracle did" Inbox row, ./autonomy.ts). */
  oracleDid?: (row: { responsibility: string; responsibility_title: string; summary: string; subject: Record<string, string>; undo: Schemas["InboxOracleAction"]["undo"]; notify_ids: string[] }) => void;
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, detail: string) => json(status, { detail });
const now = () => new Date();

// --- schedule maths (schedule.py) -----------------------------------------------------------

const DAY_MS = 86_400_000;
/** A Monday: week 0 of every every_n_weeks series. */
const EPOCH = Date.UTC(2024, 0, 1);
const PER_SUMMARY_USD = 3;
/** Kinds whose pre-read is figures and lists (summaries.py COVERED). */
const COVERED = new Set(["goals_checkin", "roadmap_refresh", "goals_review", "decision_review", "strategy_review", "alignment_report", "custom", "metrics_review"]);
/** Kinds whose summary is another flow's run (summaries.py FLOW_FOR_KIND), and its price: H5's "Explain with Oracle", H7's digest. */
const FLOW_FOR_KIND: Record<string, { flow: "metrics_variance" | "competitive_digest"; usd: number }> = {
  metrics_review: { flow: "metrics_variance", usd: 1.5 },
  // H7: the competitive digest is the competitive_digest run, $7.00.
  competitive_digest: { flow: "competitive_digest", usd: 7 },
};
const priceOf = (kind: string) => FLOW_FOR_KIND[kind]?.usd ?? PER_SUMMARY_USD;
const MISSED_AFTER_MS = 7 * DAY_MS;

/** The calendar day (as a UTC-midnight number) of `at` in `tz`. */
function localDay(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"));
}

/** `tz`'s offset from UTC at `at`, in ms. */
function offset(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}

/** The UTC instant of `time` on `day` in the schedule's zone. */
function at(day: number, s: Schedule): number {
  const [h, m] = s.time.split(":").map(Number);
  const wall = day + (h * 60 + m) * 60_000;
  let utc = wall - offset(wall, s.timezone);
  utc = wall - offset(utc, s.timezone);
  return utc;
}

const weekday = (day: number) => (new Date(day).getUTCDay() + 6) % 7;

function nthWeekday(year: number, month: number, wd: number, nth: number): number {
  if (nth === -1) {
    const last = Date.UTC(year, month, 0);
    return last - ((weekday(last) - wd + 7) % 7) * DAY_MS;
  }
  const first = Date.UTC(year, month - 1, 1);
  return first + (((wd - weekday(first) + 7) % 7) + 7 * (nth - 1)) * DAY_MS;
}

/** The first due time of `s` strictly after `after`. */
export function nextOccurrence(s: Schedule, after: Date): Date {
  const local = localDay(after, s.timezone);
  if (s.freq === "weekly" || s.freq === "every_n_weeks") {
    const step = s.freq === "every_n_weeks" ? s.interval : 1;
    let day = local - DAY_MS;
    for (let i = 0; i < 7 * step + 8; i++, day += DAY_MS) {
      if (weekday(day) === s.weekday && Math.floor((day - EPOCH) / DAY_MS / 7) % step === 0) {
        const t = at(day, s);
        if (t > after.getTime()) return new Date(t);
      }
    }
  } else {
    const months = s.freq === "monthly" ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : s.freq === "quarterly" ? [0, 1, 2, 3].map((q) => s.month + 3 * q) : [s.month];
    const d = new Date(local);
    let year = d.getUTCFullYear();
    let month = d.getUTCMonth();
    if (month === 0) [year, month] = [year - 1, 12];
    for (let i = 0; i < 26; i++) {
      if (months.includes(month)) {
        const t = at(nthWeekday(year, month, s.weekday, s.week_of_month), s);
        if (t > after.getTime()) return new Date(t);
      }
      [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
    }
  }
  throw new Error("no next occurrence");
}

function runsPerMonth(s: Schedule): number {
  if (s.freq === "every_n_weeks") return Math.round((4.33 / s.interval) * 100) / 100;
  return { weekly: 4.33, monthly: 1, quarterly: 0.33, yearly: 0.08 }[s.freq];
}

/** The API's 422s for a schedule (Schedule's validators), or null. */
function scheduleError(s: Schedule): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return "schedule.time: time must be HH:MM (00:00 to 23:59)";
  if (![-1, 1, 2, 3, 4].includes(s.week_of_month)) return "schedule.week_of_month: week_of_month must be 1 to 4, or -1 for the last";
  if (s.freq === "every_n_weeks" && !(s.interval >= 2 && s.interval <= 12)) return "schedule.interval: every_n_weeks repeats every 2 to 12 weeks";
  if (s.freq === "quarterly" && s.month > 3) return "schedule.month: a quarter starts in its month 1, 2 or 3";
  return null;
}

// --- kinds and seed ----------------------------------------------------------------------

const sched = (freq: Schedule["freq"], fields: Partial<Schedule>): Schedule => ({
  freq,
  interval: 1,
  weekday: 0,
  week_of_month: 1,
  month: 1,
  time: "09:00",
  timezone: "America/Los_Angeles",
  ...fields,
});

/** The built-in kinds the mock company has (kinds.py), in the API's order. */
const BUILTINS = [
  { kind: "goals_checkin", title: "Weekly goals check-in", schedule: sched("weekly", { weekday: 0, time: "09:00" }), duration_min: 30, prep_hours: 12, on: true },
  { kind: "roadmap_refresh", title: "Monthly roadmap refresh", schedule: sched("monthly", { week_of_month: 1, weekday: 1, time: "10:00" }), duration_min: 60, prep_hours: 24, on: true },
  { kind: "goals_review", title: "Quarterly goals review", schedule: sched("quarterly", { month: 1, week_of_month: 1, weekday: 2, time: "10:00" }), duration_min: 90, prep_hours: 48, on: true },
  { kind: "investor_update", title: "Investor update", schedule: sched("monthly", { week_of_month: 1, weekday: 0, time: "09:00" }), duration_min: 30, prep_hours: 72, on: false },
  // B1's Build the baseline on the ritual clock, seeded paused (rebuild.py).
  { kind: "baseline_rebuild", title: "Baseline rebuild", schedule: sched("monthly", { week_of_month: 1, weekday: 0, time: "09:00" }), duration_min: 30, prep_hours: 0, on: false },
];

const BLOCK_TITLES: Record<string, string> = {
  goals: "Goals",
  since_last: "Since last time",
  outcomes_due: "Outcomes due for a check",
  needs_decision: "Needs a decision",
  tracks: "Tracks",
  slips: "Date slips",
  stale_items: "Potentially stale items",
  done_items: "Done in the window",
  priority_changes: "Priority changes",
  suggested_next: "Suggested next",
  baseline_rebuild: "Baseline rebuild",
};

type Row = { text: string; href?: string | null; method?: string; label?: string };

function block(key: string, asOf: string, rows: Row[]) {
  return { key, title: BLOCK_TITLES[key] ?? key, as_of: asOf, rows };
}

/** The pre-read the roadmap refresh's builders make from the mock company's roadmap. */
function roadmapBlocks(asOf: string, trackId: string) {
  return [
    block("tracks", asOf, [
      { text: "Usage alerts PRD: at risk, 2 at risk", href: `/roadmap?track=${trackId}` },
      { text: "Team onboarding PRD: on track, 0 at risk", href: "/roadmap" },
    ]),
    block("slips", asOf, [{ text: `Threshold alerts beta: ${formatDate("2026-11-10")} → ${formatDate("2026-11-24")}`, href: `/roadmap?track=${trackId}` }]),
    block("stale_items", asOf, [{ text: "Digest emails", href: "/roadmap?item=usage-alerts:digest-emails" }]),
    block("done_items", asOf, [{ text: "ENG-401 Alert settings page", href: `/roadmap?track=${trackId}` }]),
    block("priority_changes", asOf, [{ text: "Usage alerts: #5 → #2", href: "/priorities" }]),
    block("suggested_next", asOf, [
      { label: "Start a roadmap run from Usage alerts PRD", method: "POST", href: `/v1/tracks/${trackId}/roadmap-run`, text: "Start a roadmap run from Usage alerts PRD" },
      { label: "Review goals", href: "/baseline", text: "Review goals" },
      { label: "Open priorities", href: "/priorities", text: "Open priorities" },
    ]),
  ];
}

/**
 * The goals block (blocks.goals): the confirmed goals by title, each with Home's current,
 * target and distance (qa-company-6: the same figures Home shows, from the same goals).
 */
function goalRows(ctx: RitualsContext): Row[] {
  const confirmed = (ctx.goals?.() ?? []).filter((e) => e.type === "goal" && e.status === "confirmed");
  return goalViews(confirmed)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((g) => {
      const distance = assess(g).text;
      return { text: `${g.title}: ${g.currentText ?? "-"} of ${g.targetText ?? "-"}${distance ? ` · ${distance}` : ""}`, href: `/baseline?entity=${g.id}` };
    });
}

function goalsBlocks(asOf: string, ctx: RitualsContext) {
  return [
    block("goals", asOf, goalRows(ctx)),
    block("since_last", asOf, [
      { text: "PRD versions approved: 1", href: "/plan" },
      { text: "Runs finished: 3", href: "/runs" },
    ]),
    block("outcomes_due", asOf, []),
    block("needs_decision", asOf, [{ text: "D-5 Ship usage caps before anomaly detection", href: "/company/decisions?d=5" }]),
  ];
}

// --- the Baseline rebuild (rebuild.py) -------------------------------------------------------

const REBUILD = "baseline_rebuild";
/** B1's build at the ritual's knobs: standard depth, default roles. */
const REBUILD_USD = 7;
/** P3: a run over this waits for an owner's approval. */
const APPROVAL_USD = 50;
const WAITS = " · Waits for an owner's approval";
const approvalNote = (usd: number) => `Waiting for an owner's approval: the estimate ${usd2(usd)} is over $${APPROVAL_USD}`;
const rebuildUsd = (ctx: RitualsContext) => ctx.rebuildUsd?.() ?? REBUILD_USD;
const BUILD_HERE = "Build it from the Baseline page.";
const REBUILD_FAILED = "The baseline build did not finish · Build it from the Baseline page";
const UNDER_WAY = ["draft", "awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun"];
const usd2 = (n: number) => `$${n.toFixed(2)}`;
/** Why Oracle starts no build now (rebuild.blocked), or null: Observe. No ritual cost cap; over $50 the run waits (P3). */
function rebuildBlocked(ctx: RitualsContext): string | null {
  if (!(ctx.baselineStarts?.() ?? true)) return `Not started: Oracle is set to observe the baseline. ${BUILD_HERE}`;
  return null;
}

function rebuildBlocks(ctx: RitualsContext, asOf: string) {
  const last = ctx.lastBaselineRun?.() ?? null;
  const usd = rebuildUsd(ctx);
  const rows: Row[] = [
    last ? { text: `Last built ${companyStamp(last.created_at)}`, href: `/runs/${last.id}` } : { text: "No baseline build yet", href: null },
    { text: `Estimate ${usd2(usd)} at standard depth`, href: null },
  ];
  const why = rebuildBlocked(ctx);
  if (why) rows.push({ text: why, href: null }, { text: "Build the baseline", label: "Build the baseline", href: "/baseline?build=1" });
  else if (usd > APPROVAL_USD) rows.push({ text: `Oracle starts the build; over $${APPROVAL_USD} it waits for an owner's approval`, href: "/baseline" });
  else rows.push({ text: "Oracle starts the build; its proposals wait for review", href: "/baseline" });
  return [block(REBUILD, asOf, rows)];
}

/** An occurrence that just became ready starts B1's build (rebuild.after_ready). */
async function rebuildAfterReady(ctx: RitualsContext, r: Ritual, o: Occurrence) {
  if (o.summary_state !== "none" || o.summary_run_id) return;
  const why = rebuildBlocked(ctx);
  const owner = ctx.members.find((m) => m.id === r.owner_id);
  const note = (summary_note: string) => Object.assign(o, { summary_state: "not_started", summary_note });
  if (why) return note(why);
  if (!owner || owner.status === "disabled" || !atLeast(owner.role, "approver")) return note("Not started: the ritual's owner can no longer start runs");
  const started = (await ctx.startBaselineBuild?.()) ?? { error: "The mock cannot start runs" };
  if ("error" in started) return note(`Not started: ${started.error.charAt(0).toLowerCase()}${started.error.slice(1)}`);
  const waits = ctx.runStatus?.(started.id) === "awaiting_approval";
  const usd = rebuildUsd(ctx);
  Object.assign(o, { summary_state: "running", summary_run_id: started.id, summary_note: waits ? approvalNote(usd) : null, summary: null });
  ctx.oracleDid?.({
    responsibility: "baseline",
    responsibility_title: "Keep the baseline current",
    summary: `Started the baseline rebuild · Estimate ${usd2(usd)}${waits ? WAITS : ""}`,
    subject: { kind: "ritual", key: r.id, href: `/company/rituals/${o.id}` },
    undo: { method: "POST", path: `/v1/runs/${started.id}/cancel`, body: null },
    notify_ids: [r.owner_id],
  });
}

/** A build that ended: ready once it succeeded, else failed; under way, it says it waits for an owner's approval only while it does (rebuild.sync_state). */
function syncRebuild(ctx: RitualsContext, o: Occurrence) {
  if (o.summary_state !== "running" || !o.summary_run_id) return;
  const status = ctx.runStatus?.(o.summary_run_id) ?? "running";
  if (status === "succeeded") Object.assign(o, { summary_state: "ready", summary_note: null });
  else if (!UNDER_WAY.includes(status)) Object.assign(o, { summary_state: "failed", summary_note: REBUILD_FAILED });
  else o.summary_note = status === "awaiting_approval" ? approvalNote(rebuildUsd(ctx)) : null;
}

function blocksFor(kind: string, asOf: string, trackId: string, ctx?: RitualsContext) {
  if (kind === REBUILD && ctx) return rebuildBlocks(ctx, asOf);
  if (kind === "roadmap_refresh") return roadmapBlocks(asOf, trackId);
  if ((kind === "goals_checkin" || kind === "goals_review") && ctx) return goalsBlocks(asOf, ctx);
  return [block("since_last", asOf, [{ text: "Runs finished: 3", href: "/runs" }]), block("needs_decision", asOf, [])];
}

const TRACK_ID = "5b0c1a7e-3d2f-4e8a-9c61-2f7d8e4b1a90";

/** The company's built-in rituals; with `scenario`, the two occurrences described above. */
export function seedRituals(ctx: RitualsContext, scenario: boolean): RitualsDb {
  const owner = ctx.members.find((m) => m.role === "owner" && m.status !== "disabled")!;
  const attendees = ctx.members.filter((m) => (m.role === "owner" || m.role === "approver") && m.status !== "disabled").map((m) => m.id);
  const t = now();
  const zone = ctx.companyTimezone();
  const db: RitualsDb = { rituals: [], occurrences: [], mode: "on_demand", zone };
  // A new company's built-ins wait paused (nothing to review yet): Simple's Home lists no
  // meeting and its rail counts none, as Detailed's Home says no goals.
  const fresh = newCompany();
  for (const b of BUILTINS) {
    db.rituals.push({
      id: ctx.uuid(),
      kind: b.kind,
      title: b.title,
      builtin: true,
      schedule: { ...b.schedule, timezone: zone },
      duration_min: b.duration_min,
      prep_hours: b.prep_hours,
      owner_id: owner.id,
      attendee_ids: attendees,
      status: b.on && !fresh ? "active" : "paused",
      next_due_at: nextOccurrence({ ...b.schedule, timezone: zone }, t).toISOString(),
      lock_version: 1,
      created_at: t.toISOString(),
    });
  }
  if (!scenario) return db;
  const asOf = t.toISOString();
  // Prepare now on the roadmap refresh: its next occurrence is ready, the ritual moves on.
  const refresh = db.rituals.find((r) => r.kind === "roadmap_refresh")!;
  const due = new Date(refresh.next_due_at!);
  db.occurrences.push(occurrence(ctx, refresh, due, { status: "ready", pre_read: { built_at: asOf, blocks: roadmapBlocks(asOf, TRACK_ID) } }));
  refresh.next_due_at = nextOccurrence(refresh.schedule, due).toISOString();
  // Last week's goals check-in: held with a decision named, and its Every pre-read summary failed.
  const named = ctx.decisions().find((d) => d.title === "Ship usage caps before anomaly detection");
  const checkin = db.rituals.find((r) => r.kind === "goals_checkin")!;
  const last = nextOccurrence(checkin.schedule, new Date(t.getTime() - 8 * DAY_MS));
  db.occurrences.push(
    occurrence(ctx, checkin, last, {
      status: "held",
      notes: "Activation is on pace; paid conversion is still short of its target.",
      decision_ids: named ? [named.id] : [],
      pre_read: { built_at: new Date(last.getTime() - 12 * 3_600_000).toISOString(), blocks: goalsBlocks(asOf, ctx) },
      summary_state: "failed",
      summary_note: "Summary failed · Summarize with Oracle to retry",
    }),
  );
  return db;
}

/** H7: the Monthly competitive digest (kinds.py), seeded paused; the first alternative resumes it. */
const DIGEST = { kind: "competitive_digest", title: "Monthly competitive digest", schedule: sched("monthly", { week_of_month: 1, weekday: 3, time: "10:00" }), duration_min: 30, prep_hours: 72 };

/**
 * The "market" scenario (H7, ./market.ts): the Monthly competitive digest, resumed by the
 * company's alternatives, with its next pre-read prepared early (`blocks`, the market's four)
 * under the occurrence id `occurrenceId` the web findings name.
 */
export function addDigest(ctx: RitualsContext, db: RitualsDb, occurrenceId: string, blocks: (asOf: string) => unknown[]) {
  const owner = ctx.members.find((m) => m.role === "owner" && m.status !== "disabled")!;
  const attendees = ctx.members.filter((m) => (m.role === "owner" || m.role === "approver") && m.status !== "disabled").map((m) => m.id);
  const t = now();
  const schedule = { ...DIGEST.schedule, timezone: ctx.companyTimezone() };
  const r: Ritual = {
    id: ctx.uuid(),
    kind: DIGEST.kind,
    title: DIGEST.title,
    builtin: true,
    schedule,
    duration_min: DIGEST.duration_min,
    prep_hours: DIGEST.prep_hours,
    owner_id: owner.id,
    attendee_ids: attendees,
    status: "active",
    next_due_at: null,
    lock_version: 1,
    created_at: t.toISOString(),
  };
  const due = nextOccurrence(schedule, t);
  const asOf = t.toISOString();
  db.rituals.push(r);
  db.occurrences.push({ ...occurrence(ctx, r, due, { status: "ready", pre_read: { built_at: asOf, blocks: blocks(asOf) as Occurrence["pre_read"]["blocks"] } }), id: occurrenceId });
  r.next_due_at = nextOccurrence(schedule, due).toISOString();
}

function occurrence(ctx: RitualsContext, r: Ritual, due: Date, fields: Partial<Occurrence>): Occurrence {
  return {
    id: ctx.uuid(),
    ritual_id: r.id,
    due_at: due.toISOString(),
    ends_at: new Date(due.getTime() + r.duration_min * 60_000).toISOString(),
    status: "scheduled",
    period: { from: null, to: due.toISOString() },
    pre_read: { built_at: null, blocks: [] },
    attempts: 0,
    error: null,
    notes: null,
    skip_reason: null,
    decision_ids: [],
    summary_run_id: null,
    summary: null,
    summary_state: "none",
    summary_note: null,
    read_by: [],
    ...fields,
  };
}

// --- derived ------------------------------------------------------------------------------

/** Marks ready occurrences missed 7 days after their end (the ticker's step 2). */
function tick(db: RitualsDb) {
  const t = now().getTime();
  for (const o of db.occurrences) {
    if (o.status === "ready" && Date.parse(o.ends_at) + MISSED_AFTER_MS <= t) o.status = "missed";
  }
}

/** The Company time zone changed: every ritual takes the new one and its next date in it (one zone). */
function followZone(ctx: RitualsContext, db: RitualsDb) {
  const zone = ctx.companyTimezone();
  if (zone === db.zone) return;
  for (const r of db.rituals) {
    if (r.schedule.timezone === zone) continue;
    r.schedule = { ...r.schedule, timezone: zone };
    if (r.status === "active") r.next_due_at = nextOccurrence(r.schedule, now()).toISOString();
    r.lock_version += 1;
  }
  db.zone = zone;
}

/** The decisions recorded with an occurrence: those it names (and `extra`), and those whose subject it is. */
function decisionsOf(ctx: RitualsContext, o: Occurrence, extra: string[] = []): LoggedDecision[] {
  const named = new Set([...o.decision_ids, ...extra]);
  return ctx
    .decisions()
    .filter((d) => named.has(d.id) || d.subjects.some((s) => s.kind === "ritual_occurrence" && s.id === o.id))
    .sort((a, b) => a.number - b.number);
}

function summaryOf(o: Occurrence): Schemas["OccurrenceSummary"] {
  return { id: o.id, ritual_id: o.ritual_id, due_at: o.due_at, ends_at: o.ends_at, status: o.status };
}

/** What Prepare now would spend (summaries.prepare_usd, qa-company-1): the baseline build's estimate unless Oracle only observes it, one summary on Every pre-read, else nothing. */
function prepareUsd(ctx: RitualsContext | undefined, db: RitualsDb, r: Ritual): number | null {
  if (r.kind === REBUILD) return ctx && rebuildBlocked(ctx) ? null : ctx ? rebuildUsd(ctx) : REBUILD_USD;
  if (r.kind === DIGEST.kind && ctx && !ctx.marketWrites()) return null;
  if (!(COVERED.has(r.kind) || r.kind in FLOW_FOR_KIND)) return null;
  // As summaries.prepare_usd: on Every pre-read, or when Oracle writes it within its limit.
  const cap = ctx?.ritualsActCap?.() ?? null;
  if (db.mode !== "always" && !(cap != null && priceOf(r.kind) <= cap)) return null;
  return priceOf(r.kind);
}

/**
 * The ritual on the way out (service.ritual_out): a meeting made early (Prepare now, or the
 * lead time) and still ahead stays Next, with its ready pre-read, until its time
 * (qa-company-7); Last pre-read is the newest of a meeting whose time has come, or on a paused
 * ritual (no Next) the newest at all, so a pre-read prepared now is its Last (qa-company-2).
 */
function ritualOut(db: RitualsDb, r: Ritual, ctx?: RitualsContext): RitualOut {
  const t = now().getTime();
  const mine = db.occurrences.filter((o) => o.ritual_id === r.id);
  const upcoming = mine
    .filter((o) => Date.parse(o.due_at) > t && ["scheduled", "ready", "failed"].includes(o.status))
    .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  let next = r.next_due_at;
  if (upcoming && next && Date.parse(upcoming.due_at) < Date.parse(next)) next = upcoming.due_at;
  const ready = r.status === "active" && !!upcoming && upcoming.status === "ready" && !!next && Date.parse(upcoming.due_at) === Date.parse(next);
  const last = mine.filter((o) => o.pre_read.built_at && (r.status !== "active" || Date.parse(o.due_at) <= t)).sort((a, b) => b.due_at.localeCompare(a.due_at))[0];
  const out: RitualOut & { created_at?: string } = {
    ...r,
    next_due_at: next,
    last_pre_read: last ? summaryOf(last) : null,
    next_pre_read: ready ? summaryOf(upcoming) : null,
    prepare_usd: prepareUsd(ctx, db, r),
  };
  delete out.created_at;
  return out;
}

function occurrenceOut(ctx: RitualsContext, r: Ritual, o: Occurrence): OccurrenceOut {
  const out: Partial<Occurrence> = { ...o };
  delete out.read_by;
  delete out.summary_reads;
  return {
    ...(out as Omit<Occurrence, "read_by" | "summary_reads">),
    kind: r.kind,
    title: r.title,
    duration_min: r.duration_min,
    owner_id: r.owner_id,
    attendee_ids: r.attendee_ids,
    timezone: r.schedule.timezone,
    read_by_me: o.read_by.includes(ctx.me.id),
    summary_offered: r.kind !== REBUILD && (r.kind !== DIGEST.kind || ctx.marketWrites()),
    decisions: decisionsOf(ctx, o).map((d) => ({ id: d.id, number: d.number, title: d.title, href: `/company/decisions?d=${d.number}` })),
  };
}

function estimate(db: RitualsDb): Schemas["Estimate"] {
  const rows = db.rituals
    .filter((r) => r.status === "active" && (COVERED.has(r.kind) || r.kind in FLOW_FOR_KIND))
    .map((r) => ({ ritual_id: r.id, title: r.title, runs_per_month: runsPerMonth(r.schedule), per_summary_usd: priceOf(r.kind) }));
  const runs = Math.round(rows.reduce((n, r) => n + r.runs_per_month, 0) * 100) / 100;
  const usd = rows.reduce((n, r) => n + r.runs_per_month * r.per_summary_usd, 0);
  return { per_summary_usd: PER_SUMMARY_USD, runs_per_month: runs, usd_per_month: Math.round(usd * 100) / 100, rituals: rows };
}

/** The signed-in member's ritual rows of the Inbox (service.inbox_rows). */
export function ritualInbox(ctx: RitualsContext, db: RitualsDb): Schemas["InboxRitual"][] {
  tick(db);
  const t = now().getTime();
  const rows: Schemas["InboxRitual"][] = [];
  const me = ctx.me.id;
  for (const o of [...db.occurrences].sort((a, b) => a.due_at.localeCompare(b.due_at))) {
    const r = db.rituals.find((x) => x.id === o.ritual_id)!;
    const row = (reason: Schemas["InboxRitual"]["reason"], state: Schemas["InboxRitual"]["state"], counts: boolean) =>
      rows.push({ occurrence_id: o.id, ritual_id: r.id, title: r.title, due_at: o.due_at, reason, state, counts });
    if (o.status === "failed") {
      if (r.status === "active" && atLeast(ctx.me.role, "owner")) row("failed", "open", true);
    } else if (o.status !== "ready") continue;
    else if (t < Date.parse(o.ends_at)) {
      if (me === r.owner_id || r.attendee_ids.includes(me)) {
        const done = o.read_by.includes(me);
        row("pre_read", done ? "done" : "new", !done);
      }
    } else if (me === r.owner_id) row("record_notes", "open", true);
  }
  return rows;
}

// --- routes -------------------------------------------------------------------------------

const SUMMARY_TEXT = [
  "# Monthly roadmap refresh — summary",
  "",
  "## What to discuss first",
  "",
  "One track is at risk: **Usage alerts PRD**, whose Threshold alerts beta slipped two weeks to Nov 24.",
  "",
  "- Digest emails may be stale.",
  "- Usage alerts rose from fifth to second in the priorities; a [roadmap run](/runs) from that track is the suggested next step.",
  "- Links a run must not draw: [another site](/\\evil.example/a) and [a script](javascript:alert).",
].join("\n");

const METRICS_SUMMARY_TEXT = [
  "## Weekly metrics review",
  "",
  "**Weekly active teams** rose 37 to 412, above its normal range: the Team invites launch on Oct 14 is the likely cause.",
  "",
  "- Invites sent per team fell to 3.9; nothing Oracle can read explains it yet.",
  "- Links a run must not draw: [another site](/\\evil.example/b) and [a script](javascript:alert).",
].join("\n");

/**
 * H5: the "metrics" scenario's Weekly metrics review, as metrics.activate_review leaves it:
 * on, with the goals check-in's schedule, owner and attendees; the goals check-in paused and
 * marked replaced. This Monday's occurrence is ready, its pre-read built by `blocks`.
 */
export function addMetricsReview(ctx: RitualsContext, db: RitualsDb, blocks: (occurrenceId: string, asOf: string) => OccurrenceOut["pre_read"]["blocks"]) {
  const checkin = db.rituals.find((r) => r.kind === "goals_checkin")!;
  const t = now();
  const review: Ritual = {
    ...checkin,
    id: ctx.uuid(),
    kind: "metrics_review",
    title: "Weekly metrics review",
    duration_min: 45,
    prep_hours: 6,
    status: "active",
    lock_version: 1,
    created_at: t.toISOString(),
  };
  Object.assign(checkin, { status: "paused", next_due_at: null, replaced_by: "Weekly metrics review" });
  db.rituals.push(review);
  // This week's: the first due after a day ago (Monday 09:00 in the Company time zone), prepared 6 hours before.
  const week = nextOccurrence(review.schedule, new Date(t.getTime() - DAY_MS));
  const asOf = new Date(week.getTime() - 6 * 3_600_000).toISOString();
  const o = occurrence(ctx, review, week, { status: "ready", period: { from: new Date(week.getTime() - 7 * DAY_MS).toISOString(), to: week.toISOString() } });
  o.pre_read = { built_at: asOf, blocks: blocks(o.id, asOf) };
  db.occurrences.push(o);
  review.next_due_at = nextOccurrence(review.schedule, week).toISOString();
}

/** The mock digest run's digest.md (H7): per alternative, then Battlecard inputs; made-up names. */
const DIGEST_TEXT = [
  "## Competitor A",
  "",
  "Competitor A replaced its per-seat plan with a $400 team plan (Pricing, Oct 14). A review site says setup takes two weeks (from the web, not vetted). One request asks for roadmap sharing because Competitor A has it.",
  "",
  "## Competitor B",
  "",
  "A news site reports a 20% price rise (from the web, not vetted). Its docs page is blocked by robots.txt.",
  "",
  "## Battlecard inputs",
  "",
  "- **Where we win:** set up in an afternoon; reads the company's own sources.",
  "- **Where they win:** a free plan for small teams.",
  "- **Traps to avoid:** matching the team plan feature for feature.",
  "- **Proof points:** time to first roadmap.",
].join("\n");

/** Handles /v1/rituals* and /v1/ritual-occurrences*; null for any other path. */
export async function routeRituals(ctx: RitualsContext, db: RitualsDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "rituals" && p[1] !== "ritual-occurrences") return null;
  tick(db);
  followZone(ctx, db);
  const m = req.method;
  const role = ctx.me.role;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const owner = atLeast(role, "owner");
  const notOwner = () => fail(403, "Requires the owner role");
  const memberIds = new Set(ctx.members.filter((x) => x.status !== "disabled").map((x) => x.id));

  if (p[1] === "rituals") {
    if (p[2] === "summaries" && p.length === 3) {
      if (m === "PUT") {
        if (!owner) return notOwner();
        const { mode } = await body<{ mode: string }>();
        if (mode !== "on_demand" && mode !== "always") return fail(422, "mode is on_demand or always");
        db.mode = mode;
      }
      return json(200, { mode: db.mode, estimate: estimate(db) });
    }
    if (p.length === 2) {
      if (m === "GET") {
        const order = (r: Ritual) => (r.builtin ? 0 : 1);
        return json(200, [...db.rituals].sort((a, b) => order(a) - order(b)).map((r) => ritualOut(db, r, ctx)));
      }
      if (m === "POST") {
        if (!owner) return notOwner();
        const input = await body<Schemas["RitualCreate"]>();
        if (input.kind !== "custom") return fail(422, "kind: the mock adds custom rituals only");
        if (!input.title?.trim()) return fail(422, "title: give the ritual a title");
        // A zone sent with the rule is not read: every ritual is in the Company time zone.
        const schedule = sched("weekly", { ...input.schedule, timezone: ctx.companyTimezone() });
        const bad = scheduleError(schedule);
        if (bad) return fail(422, bad);
        const r: Ritual = {
          id: ctx.uuid(),
          kind: "custom",
          title: input.title.trim(),
          builtin: false,
          schedule,
          duration_min: input.duration_min ?? 30,
          prep_hours: input.prep_hours ?? 12,
          owner_id: input.owner_id ?? ctx.me.id,
          attendee_ids: input.attendee_ids ?? [],
          status: "active",
          next_due_at: nextOccurrence(schedule, now()).toISOString(),
          lock_version: 1,
          created_at: now().toISOString(),
        };
        db.rituals.push(r);
        return json(201, ritualOut(db, r, ctx));
      }
    }
    const r = db.rituals.find((x) => x.id === p[2]);
    if (!r) return fail(404, "Ritual not found");
    if (p.length === 3) {
      if (m === "GET") return json(200, ritualOut(db, r, ctx));
      if (m === "DELETE") {
        if (!owner) return notOwner();
        if (r.builtin) return fail(409, "Built-in rituals pause; they are not deleted");
        db.rituals = db.rituals.filter((x) => x !== r);
        db.occurrences = db.occurrences.filter((o) => o.ritual_id !== r.id);
        return new Response(null, { status: 204 });
      }
      if (m === "PATCH") {
        if (!owner) return notOwner();
        const input = await body<Schemas["RitualPatch"]>();
        if (input.lock_version !== r.lock_version) return fail(409, "This ritual changed since you opened it. Reload to see the change.");
        if (input.duration_min != null && (input.duration_min < 5 || input.duration_min > 480)) return fail(422, "duration_min: between 5 and 480 minutes");
        if (input.prep_hours != null && (input.prep_hours < 0 || input.prep_hours > 168)) return fail(422, "prep_hours: between 0 and 168 hours");
        if (input.attendee_ids?.some((id) => !memberIds.has(id))) return fail(422, "attendee_ids: every attendee is a member");
        if (input.owner_id && !memberIds.has(input.owner_id)) return fail(422, "owner_id: the owner is a member");
        if (input.schedule) {
          const schedule = sched(input.schedule.freq, { ...input.schedule, timezone: ctx.companyTimezone() });
          const bad = scheduleError(schedule);
          if (bad) return fail(422, bad);
          r.schedule = schedule;
          r.next_due_at = nextOccurrence(schedule, now()).toISOString();
        }
        if (input.title) r.title = input.title;
        if (input.duration_min != null) r.duration_min = input.duration_min;
        if (input.prep_hours != null) r.prep_hours = input.prep_hours;
        if (input.owner_id) r.owner_id = input.owner_id;
        if (input.attendee_ids) {
          if (input.attendee_ids.join() !== r.attendee_ids.join()) r.attendees_edited_at = now().toISOString();
          r.attendee_ids = input.attendee_ids;
        }
        r.lock_version += 1;
        return json(200, ritualOut(db, r, ctx));
      }
    }
    if (p.length === 4 && m === "POST" && (p[3] === "pause" || p[3] === "resume")) {
      if (!owner) return notOwner();
      r.status = p[3] === "pause" ? "paused" : "active";
      if (r.status === "active") r.next_due_at = nextOccurrence(r.schedule, now()).toISOString();
      r.lock_version += 1;
      return json(200, ritualOut(db, r, ctx));
    }
    if (p.length === 4 && m === "POST" && p[3] === "prepare") {
      if (!owner) return notOwner();
      // Retry a failed one, or build the next occurrence's pre-read now.
      const failed = db.occurrences.find((o) => o.ritual_id === r.id && o.status === "failed");
      const due = failed ? new Date(failed.due_at) : new Date(r.next_due_at ?? nextOccurrence(r.schedule, now()).toISOString());
      const asOf = now().toISOString();
      let o = failed ?? db.occurrences.find((x) => x.ritual_id === r.id && x.due_at === due.toISOString());
      if (!o) {
        o = occurrence(ctx, r, due, {});
        db.occurrences.push(o);
      }
      Object.assign(o, { status: "ready", error: null, pre_read: { built_at: asOf, blocks: blocksFor(r.kind, asOf, TRACK_ID, ctx) } });
      // As service.prepare: a paused ritual's next meeting does not move on.
      if (!failed && r.status === "active") r.next_due_at = nextOccurrence(r.schedule, due).toISOString();
      if (r.kind === REBUILD) await rebuildAfterReady(ctx, r, o);
      return json(200, occurrenceOut(ctx, r, o));
    }
    if (p.length === 4 && m === "GET" && p[3] === "occurrences") {
      const limit = Number(q.get("limit") ?? 20);
      return json(
        200,
        db.occurrences
          .filter((o) => o.ritual_id === r.id)
          .sort((a, b) => b.due_at.localeCompare(a.due_at))
          .slice(0, limit)
          .map(summaryOf),
      );
    }
    return fail(404, "Route not found");
  }

  const o = db.occurrences.find((x) => x.id === p[2]);
  if (!o) return fail(404, "Occurrence not found");
  const r = db.rituals.find((x) => x.id === o.ritual_id)!;
  if (p.length === 3 && m === "GET") {
    if (r.kind === REBUILD) {
      syncRebuild(ctx, o);
      return json(200, occurrenceOut(ctx, r, o));
    }
    // The mock summary run finishes on the second read after it starts.
    if (o.summary_state === "running" && (o.summary_reads = (o.summary_reads ?? 0) + 1) >= 2) {
      Object.assign(o, { summary_state: "ready", summary: r.kind === "metrics_review" ? METRICS_SUMMARY_TEXT : r.kind === DIGEST.kind ? DIGEST_TEXT : SUMMARY_TEXT, summary_note: null });
    }
    return json(200, occurrenceOut(ctx, r, o));
  }
  if (p.length === 4 && m === "GET" && p[3] === "pre-read.md") {
    const lines = [`# ${r.title}`, ""];
    for (const b of o.pre_read.blocks as { title: string; rows: Row[] }[]) {
      lines.push(`## ${b.title}`, "", ...(b.rows.length ? b.rows.map((x) => (x.href ? `- [${x.text}](${x.href})` : `- ${x.text}`)) : ["- None"]), "");
    }
    return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  if (p.length === 4 && m === "POST" && p[3] === "read") {
    if (!o.read_by.includes(ctx.me.id)) o.read_by.push(ctx.me.id);
    return new Response(null, { status: 204 });
  }
  if (p.length === 4 && m === "POST" && (p[3] === "held" || p[3] === "skip")) {
    if (ctx.me.id !== r.owner_id) return fail(403, "Only the ritual's owner records it");
    // As the API (rituals.service.hold): held when its Simple review ended, nothing recorded yet, the owner records it.
    const heldByMeeting = p[3] === "held" && o.status === "held" && !o.notes && !(o.decision_ids ?? []).length;
    if (o.status !== "ready" && o.status !== "missed" && !heldByMeeting) return fail(409, `This occurrence is ${o.status}`);
    if (p[3] === "held") {
      const input = await body<Schemas["HeldIn"]>();
      if ((input.notes ?? "").length > 10_000) return fail(422, "notes: at most 10,000 characters");
      const decisions = decisionsOf(ctx, o, input.decision_ids ?? []);
      const unknown = (input.decision_ids ?? []).filter((id) => !decisions.some((d) => d.id === id));
      if (unknown.length) return fail(422, `decision_ids: no such decision: ${unknown.join(", ")}`);
      Object.assign(o, { status: "held", notes: input.notes || null, decision_ids: decisions.map((d) => d.id) });
    } else {
      const input = await body<Schemas["SkipIn"]>();
      if (!input?.reason?.trim()) return fail(422, "reason: say why it was skipped");
      Object.assign(o, { status: "skipped", skip_reason: input.reason });
    }
    return json(200, occurrenceOut(ctx, r, o));
  }
  if (p.length === 4 && m === "POST" && p[3] === "summary") {
    if (!atLeast(role, "approver")) return fail(403, "Requires the approver role");
    // The API's order (oracle.rituals.summaries.on_demand): readiness, a run under way, a
    // Baseline rebuild, then Observe.
    if (!["ready", "held", "missed", "skipped"].includes(o.status) || !o.pre_read) return fail(409, "The pre-read is not ready yet");
    if (o.summary_state === "running") return fail(409, "Oracle is already writing this summary");
    if (r.kind === REBUILD) return fail(409, "Start the baseline rebuild from the Baseline page");
    if (r.kind === DIGEST.kind && !ctx.marketWrites()) return fail(409, "Oracle does not write the digest at Observe");
    const special = FLOW_FOR_KIND[r.kind];
    if (special?.flow === "metrics_variance" && !ctx.openVariances?.(o.id)) return fail(409, "No open variance to explain");
    const id = ctx.uuid();
    Object.assign(o, { summary_state: "running", summary_run_id: id, summary_reads: 0, summary_note: null });
    return json(201, { id, flow: special?.flow ?? "ritual_summary", status: "running", estimate_usd: priceOf(r.kind) });
  }
  return fail(404, "Route not found");
}
