/**
 * Mock of H5 Metrics review (/v1/metrics, /v1/metric-variances and
 * /v1/company-integrations/analytics) and its Inbox rows. Synthetic data only. Every company
 * starts with no metrics and PostHog not connected; the "metrics" scenario seeds three
 * metrics, two open variances in the last complete week, PostHog connected and the Weekly
 * metrics review that replaced the goals check-in (./rituals.ts addMetricsReview).
 *
 * Weeks run Monday to Sunday in the Company time zone, as the API's (oracle.metrics.pull).
 * The variance rule is the API's (oracle.metrics.variance); the mock flags only what it seeds.
 */
import type { Schemas } from "@/lib/api/client";
import { addDays, calendarDay, dayIn } from "@/lib/dates";
import { displayName } from "@/lib/names";

type MetricOut = Schemas["MetricOut"];
type VarianceOut = Schemas["VarianceOut"];
type Role = "viewer" | "commenter" | "approver" | "owner";
type Member = { id: string; email: string; name?: string | null; role: Role; status?: string };
type Goal = { id: string; title: string; unit: string | null; confirmed: boolean };

/** A stored metric: the API's record without what is read off its values. */
type Metric = Omit<MetricOut, "owner_name" | "last_week" | "change" | "spark"> & { definitions: Schemas["Definition"][] };
type Value = Schemas["MetricValueOut"] & { metric_id: string };
type Variance = Omit<VarianceOut, "metric_title" | "owner_id" | "explained_by_name"> & { explained_by: string | null; occurrence_id: string | null };

export interface MetricsDb {
  metrics: Metric[];
  values: Value[];
  variances: Variance[];
  analytics: { host: string; project_id: string; connected_by: string; connected_at: string } | null;
}

export interface MetricsContext {
  me: Member;
  members: Member[];
  uuid: () => string;
  companyTimezone: () => string;
  goals: () => Goal[];
  /** A linked output's weekly value written to its goal as a measurement on the week's Sunday (null removes it); the goal's current follows its latest. */
  readIntoGoal?: (goalId: string, day: string, value: number | null, note: string, metricId: string) => void;
}

/** qa4-company-4: an output linked to a goal writes each weekly value to it (oracle.metrics.pull._goal_measurement, link_goal). */
function toGoal(ctx: MetricsContext, m: Metric, week: string, value: number | null) {
  if (m.goal_id && m.kind === "output") ctx.readIntoGoal?.(m.goal_id, addDays(week, 6), value, `Weekly value from ${m.title}`, m.id);
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, detail: string) => json(status, { detail });
const now = () => new Date();
const SPARK_WEEKS = 12;
const MAX_QUERY = 4000;

// --- weeks -------------------------------------------------------------------------------

/** The Monday (YYYY-MM-DD) of the last week complete now, in the Company time zone. */
export function lastCompleteWeek(zone: string, at: Date = now()): string {
  const today = dayIn(at, zone);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, -weekday - 7);
}

const isMonday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 1;
const round = (n: number) => Math.round(n * 10) / 10;

// --- read -------------------------------------------------------------------------------

function nameOf(ctx: MetricsContext, id: string | null): string | null {
  const m = ctx.members.find((x) => x.id === id);
  return m ? displayName(m.email, m.name) : null;
}

function valuesOf(db: MetricsDb, id: string): Map<string, Value> {
  return new Map(db.values.filter((v) => v.metric_id === id).map((v) => [v.week_start, v]));
}

/** A stored value as the API returns it (without its metric). */
function valueOut(v: Value): Schemas["MetricValueOut"] {
  const out: Partial<Value> = { ...v };
  delete out.metric_id;
  return out as Schemas["MetricValueOut"];
}

function metricOut(ctx: MetricsContext, db: MetricsDb, m: Metric): MetricOut {
  const week = lastCompleteWeek(ctx.companyTimezone());
  const by = valuesOf(db, m.id);
  const last = by.get(week);
  const prev = by.get(addDays(week, -7));
  const flag = db.variances.find((v) => v.metric_id === m.id && v.week_start === week);
  const change = last && prev ? round(last.value - prev.value) : null;
  const out: MetricOut & { definitions?: unknown } = {
    ...m,
    owner_name: nameOf(ctx, m.owner_id),
    last_week: last ? { week_start: week, value: last.value } : null,
    change:
      change === null ? null : { value: change, pct: prev!.value ? round((change / prev!.value) * 100) : null, variance: flag?.direction ?? null },
    spark: Array.from({ length: SPARK_WEEKS }, (_, i) => by.get(addDays(week, -7 * (SPARK_WEEKS - 1 - i)))?.value ?? null),
  };
  delete out.definitions;
  return out;
}

function varianceOut(ctx: MetricsContext, db: MetricsDb, v: Variance): VarianceOut {
  const m = db.metrics.find((x) => x.id === v.metric_id)!;
  const out: VarianceOut & { explained_by?: unknown; occurrence_id?: unknown } = { ...v, metric_title: m.title, owner_id: m.owner_id, explained_by_name: nameOf(ctx, v.explained_by) };
  delete out.explained_by;
  delete out.occurrence_id;
  return out;
}

/** Outputs first, each followed by the inputs that drive it (service.ordered). */
function ordered(metrics: Metric[]): Metric[] {
  const outputs = metrics.filter((m) => m.kind === "output").sort((a, b) => a.title.localeCompare(b.title));
  const out: Metric[] = [];
  for (const o of outputs) out.push(o, ...metrics.filter((m) => m.drives_metric_id === o.id).sort((a, b) => a.title.localeCompare(b.title)));
  return [...out, ...metrics.filter((m) => !out.includes(m))];
}

// --- the pre-read (oracle.metrics.review) -----------------------------------------------

const signed = (n: number | null) => (n === null ? "" : `${n > 0 ? "+" : ""}${n}`);

/** The metrics review's two blocks for the week the review reads. */
export function reviewBlocks(ctx: MetricsContext, db: MetricsDb, occurrenceId: string, asOf: string) {
  const week = lastCompleteWeek(ctx.companyTimezone());
  const table = ordered(db.metrics.filter((m) => m.status !== "archived")).map((m) => {
    const out = metricOut(ctx, db, m);
    const by = valuesOf(db, m.id);
    const avg = [1, 2, 3, 4, 5, 6].map((i) => by.get(addDays(week, -7 * i))?.value).filter((x): x is number => x != null);
    const average = avg.length ? avg.reduce((a, b) => a + b, 0) / avg.length : null;
    const value = out.last_week?.value ?? null;
    const vsAvg = value !== null && average !== null ? round(value - average) : null;
    return {
      metric_id: m.id, title: m.title, kind: m.kind, unit: m.unit, direction: m.direction,
      drives_metric_id: m.drives_metric_id, status: m.status, state: value === null ? "no_value" : "ok",
      week_start: week, value, previous: by.get(addDays(week, -7))?.value ?? null,
      change: out.change?.value ?? null, change_pct: out.change?.pct ?? null,
      vs_6w_avg: vsAvg, vs_6w_avg_pct: vsAvg !== null && average ? round((vsAvg / average) * 100) : null,
      vs_last_year: null, vs_last_year_pct: null, spark: out.spark, variance: out.change?.variance ?? null,
      href: `/company/metrics?metric=${m.id}`,
      text: value === null ? `${m.title}: No value this week` : `${m.title}: ${value} ${m.unit} (${signed(out.change?.value ?? null)} on the week before)`,
    }; // prettier-ignore
  });
  const variances = db.variances
    .filter((v) => v.week_start === week)
    .map((v) => {
      v.occurrence_id = occurrenceId;
      const o = varianceOut(ctx, db, v);
      const { id, ...rest } = o;
      return { ...rest, variance_id: id, owner_name: nameOf(ctx, o.owner_id), href: `/company/metrics?metric=${o.metric_id}`, text: `${o.metric_title}, week of ${calendarDay(week)}: ${signed(o.change)} · ${o.direction === "better" ? "Better" : "Worse"}` };
    });
  return [
    { key: "metrics_table", title: "Metrics", as_of: asOf, rows: table },
    { key: "variances", title: "Variances", as_of: asOf, rows: variances },
  ];
}

/** How many of an occurrence's variances nobody has answered yet. */
export function openVariances(db: MetricsDb, occurrenceId: string): number {
  return db.variances.filter((v) => v.occurrence_id === occurrenceId && v.status === "open").length;
}

// --- Inbox (review.inbox_rows) ------------------------------------------------------------

export function metricInbox(ctx: MetricsContext, db: MetricsDb): Schemas["InboxMetric"][] {
  const today = dayIn(now(), ctx.companyTimezone());
  const rows: Schemas["InboxMetric"][] = [];
  for (const v of [...db.variances].sort((a, b) => a.week_start.localeCompare(b.week_start))) {
    const m = db.metrics.find((x) => x.id === v.metric_id)!;
    if (m.owner_id !== ctx.me.id || m.status === "archived") continue;
    if (v.status === "open") rows.push({ variance_id: v.id, metric_id: m.id, metric_title: m.title, reason: "explain", week_start: v.week_start, occurrence_id: v.occurrence_id ?? null, counts: true });
    else if (v.status === "unknown" && v.find_out_by && v.find_out_by <= today)
      rows.push({ variance_id: v.id, metric_id: m.id, metric_title: m.title, reason: "find_out", week_start: v.week_start, due_on: v.find_out_by, occurrence_id: v.occurrence_id ?? null, counts: true });
  }
  if (atLeast(ctx.me.role, "owner")) {
    const week = lastCompleteWeek(ctx.companyTimezone());
    for (const m of db.metrics.filter((x) => x.status === "error")) rows.push({ metric_id: m.id, metric_title: m.title, reason: "pull_failed", week_start: week, counts: true });
  }
  return rows;
}

// --- seed ---------------------------------------------------------------------------------

export function emptyMetrics(): MetricsDb {
  return { metrics: [], values: [], variances: [], analytics: null };
}

/** A PostHog query's made-up values for `weeks` weeks ending `last` (the mock's provider). */
function readQuery(query: string, last: string, weeks: number): Schemas["WeekValue"][] {
  const base = 20 + (query.length % 40);
  return Array.from({ length: weeks }, (_, i) => ({ week_start: addDays(last, -7 * (weeks - 1 - i)), value: round(base + i * 0.6 + (i % 2 ? 0.4 : 0)) }));
}

/** The "metrics" scenario (see the file's comment). */
export function seedMetrics(ctx: MetricsContext): MetricsDb {
  const db = emptyMetrics();
  const t = now().toISOString();
  const week = lastCompleteWeek(ctx.companyTimezone());
  const owner = ctx.members.find((m) => m.role === "owner")!;
  const approver = ctx.members.find((m) => m.email === "approver@example.com")!;
  const commenter = ctx.members.find((m) => m.email === "commenter@example.com")!;
  const paid = ctx.goals().find((g) => g.title === "Grow paid conversion");
  db.analytics = { host: "eu", project_id: "12345", connected_by: owner.id, connected_at: "2026-10-01T16:00:00Z" };
  const metric = (fields: Partial<Metric> & Pick<Metric, "title" | "description" | "kind" | "unit" | "source" | "owner_id">, series: number[]): Metric => {
    const m: Metric = {
      id: ctx.uuid(), direction: "up", goal_id: null, drives_metric_id: null, query: null, threshold_pct: null,
      status: "active", definition_version: 1, last_pulled_at: fields.source === "posthog" ? t : null, last_error: null,
      lock_version: 1, definitions: [], ...fields,
    }; // prettier-ignore
    m.definitions = [{ version: 1, unit: m.unit, query: m.query, at: "2026-07-01T16:00:00Z" }];
    db.metrics.push(m);
    series.forEach((value, i) =>
      db.values.push({
        metric_id: m.id, week_start: addDays(week, -7 * (series.length - 1 - i)), value, source: m.source,
        definition_version: 1, note: null, recorded_by: m.source === "posthog" ? null : m.owner_id, recorded_at: t,
      }), // prettier-ignore
    );
    return m;
  };
  const teams = metric(
    {
      title: "Weekly active teams", description: "Teams with 3 or more sessions in the week", kind: "output", unit: "teams",
      source: "posthog", owner_id: commenter.id,
      query: "select count(distinct team_id) from events where timestamp between {period_start} and {period_end}",
    }, // prettier-ignore
    [281, 288, 292, 297, 301, 306, 310, 318, 325, 322, 331, 335, 333, 342, 349, 352, 360, 368, 375, 412],
  );
  const invites = metric(
    { title: "Invites sent per team", description: "Invitations sent in the week per active team", kind: "input", unit: "invites", source: "api", owner_id: commenter.id, drives_metric_id: teams.id },
    [3.8, 3.9, 4.0, 4.1, 4.3, 4.2, 4.4, 4.5, 4.4, 4.6, 4.7, 4.6, 4.8, 4.9, 5.0, 3.9],
  );
  metric(
    { title: "Trial to paid rate", description: "Trials that moved to a paid plan in the week", kind: "output", unit: "%", source: "manual", owner_id: approver.id, goal_id: paid?.id ?? null },
    [8.9, 9.0, 9.1, 9.0, 9.2, 9.3, 9.2, 9.3, 9.4, 9.3, 9.4, 9.4, 9.5],
  );
  const variance = (m: Metric, fields: Partial<Variance>): Variance => {
    const by = valuesOf(db, m.id);
    const value = by.get(week)!.value;
    const previous = by.get(addDays(week, -7))!.value;
    const v: Variance = {
      id: ctx.uuid(), metric_id: m.id, week_start: week, value, previous, change: round(value - previous),
      change_pct: round(((value - previous) / previous) * 100), band: null, direction: "better", status: "open",
      explanation: null, explained_by: null, find_out_by: null, noise_reason: null, oracle_draft: null,
      oracle_confidence: null, possible_causes: [], lock_version: 1, occurrence_id: null, ...fields,
    }; // prettier-ignore
    db.variances.push(v);
    return v;
  };
  variance(teams, {
    band: { low: 361, high: 389 },
    direction: "better",
    oracle_draft: "The team-invite launch on Oct 14 matches the rise: teams that joined through an invite link account for most of the new active teams.",
    oracle_confidence: "medium",
    possible_causes: [
      { kind: "launch", title: "Team invites", on: addDays(week, 2), href: "/roadmap/launches" },
      { kind: "changelog", title: "Invite links in the sharing menu", on: addDays(week, 3), href: "/roadmap/launches" },
    ],
  });
  variance(invites, { band: { low: 4.7, high: 5.3 }, direction: "worse", possible_causes: [{ kind: "decision", title: "Pause the invite reminder emails", on: addDays(week, -3), href: "/company/decisions" }] });
  return db;
}

// --- routes -------------------------------------------------------------------------------

type Create = Schemas["MetricCreate"];

/** The API's 422s for a metric's fields, or null. */
function invalid(ctx: MetricsContext, db: MetricsDb, f: Partial<Create>, self: string | null): string | null {
  if (!f.title?.trim()) return "Give the metric a title";
  if (db.metrics.some((m) => m.id !== self && m.status !== "archived" && m.title.toLowerCase() === f.title!.trim().toLowerCase())) return "A metric with this title exists";
  const d = f.description?.trim() ?? "";
  if (d.length < 3 || d.length > 200) return "What it counts is 3 to 200 characters";
  if (!f.unit?.trim()) return "Give the metric a unit";
  if (f.kind === "input" && !f.drives_metric_id) return "An input drives an output: pick the output it drives";
  if (f.kind === "output" && f.drives_metric_id) return "An output drives no other metric";
  if (f.drives_metric_id && !db.metrics.some((m) => m.id === f.drives_metric_id && m.kind === "output")) return "An input drives an output metric";
  if (f.kind === "input" && f.goal_id) return "Only an output links to a goal";
  if (f.goal_id) {
    const goal = ctx.goals().find((g) => g.id === f.goal_id && g.confirmed);
    if (!goal) return "Link a confirmed goal";
    if ((goal.unit ?? "") !== f.unit) return `The metric's unit must match the goal's unit (${goal.unit ?? "none"})`;
    if (db.metrics.some((m) => m.id !== self && m.status !== "archived" && m.goal_id === f.goal_id)) return "Another metric reads this goal";
  }
  if (f.threshold_pct != null && (f.threshold_pct < 1 || f.threshold_pct > 500)) return "The threshold is 1 to 500 %";
  if (f.query && f.query.length > MAX_QUERY) return "The query is at most 4,000 characters";
  if (f.source === "posthog" && !f.query?.trim()) return "A PostHog metric needs its query";
  return null;
}

/** Handles the metrics routes and /v1/company-integrations/analytics; null for any other path. */
export async function routeMetrics(ctx: MetricsContext, db: MetricsDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const analytics = p[1] === "company-integrations" && p[2] === "analytics";
  if (p[1] !== "metrics" && p[1] !== "metric-variances" && !analytics) return null;
  const m = req.method;
  const role = ctx.me.role;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const approver = atLeast(role, "approver");
  const notApprover = () => fail(403, "Requires the approver role");
  const zone = ctx.companyTimezone();
  const week = lastCompleteWeek(zone);
  const posthogCount = () => db.metrics.filter((x) => x.source === "posthog" && x.status !== "archived").length;

  if (analytics && p.length === 3) {
    if (!atLeast(role, "owner")) return fail(403, "Requires the owner role");
    if (m === "PUT") {
      const input = await body<Schemas["AnalyticsIn"]>();
      if (!input.project_id?.trim()) return fail(422, "project_id: give the PostHog project id");
      if (input.host !== "us" && input.host !== "eu" && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(input.host)) return fail(422, "An own host is an https address that resolves to public addresses only");
      if (!input.api_key?.trim()) return fail(422, "api_key: give a personal API key");
      if (/refused/.test(input.api_key)) return fail(422, "PostHog refused the key: Invalid personal API key");
      db.analytics = { host: input.host, project_id: input.project_id.trim(), connected_by: ctx.me.id, connected_at: now().toISOString() };
      for (const x of db.metrics) if (x.source === "posthog" && x.status === "paused") Object.assign(x, { status: "active", last_error: null });
    } else if (m === "DELETE") {
      db.analytics = null;
      for (const x of db.metrics) if (x.source === "posthog" && x.status !== "archived") Object.assign(x, { status: "paused", last_error: "Analytics disconnected" });
      return new Response(null, { status: 204 });
    } else if (m !== "GET") return fail(405, "Method not allowed");
    const a = db.analytics;
    return json(200, {
      provider: "posthog", host: a?.host ?? null, project_id: a?.project_id ?? null, status: a ? "active" : "disconnected", last_error: null,
      connected_by_name: a ? nameOf(ctx, a.connected_by) : null, connected_at: a?.connected_at ?? null, metrics: posthogCount(),
    } satisfies Schemas["AnalyticsOut"]); // prettier-ignore
  }

  if (p[1] === "metrics") {
    if (p.length === 2 && m === "GET") {
      const all = q.get("include_archived") === "true";
      return json(200, ordered(db.metrics.filter((x) => all || x.status !== "archived")).map((x) => metricOut(ctx, db, x)));
    }
    if (p.length === 2 && m === "POST") {
      if (!approver) return notApprover();
      const input = await body<Create>();
      const bad = invalid(ctx, db, input, null);
      if (bad) return fail(422, bad);
      if (input.source === "posthog" && !db.analytics) return fail(409, "Connect PostHog in Settings › Analytics first");
      const t = now().toISOString();
      const x: Metric = {
        id: ctx.uuid(), title: input.title.trim(), description: input.description.trim(), kind: input.kind, unit: input.unit.trim(),
        direction: input.direction, goal_id: input.goal_id ?? null, drives_metric_id: input.drives_metric_id ?? null,
        owner_id: input.owner_id, source: input.source, query: input.source === "posthog" ? (input.query ?? null) : null,
        threshold_pct: input.threshold_pct ?? null, status: "active", definition_version: 1, last_pulled_at: input.source === "posthog" ? t : null,
        last_error: null, lock_version: 1, definitions: [{ version: 1, unit: input.unit.trim(), query: input.query ?? null, at: t }],
      }; // prettier-ignore
      db.metrics.push(x);
      // A PostHog metric reads its last 12 complete weeks at once.
      if (x.query)
        for (const v of readQuery(x.query, week, 12)) {
          db.values.push({ ...v, metric_id: x.id, source: "posthog", definition_version: 1, note: null, recorded_by: null, recorded_at: t });
          toGoal(ctx, x, v.week_start, v.value);
        }
      return json(201, metricOut(ctx, db, x));
    }
    if (p[2] === "test" && p.length === 3 && m === "POST") {
      if (!approver) return notApprover();
      const { query } = await body<{ query: string }>();
      if (!db.analytics) return fail(409, "Connect PostHog in Settings › Analytics first");
      if (!query?.trim() || query.length > MAX_QUERY) return fail(422, "The query is 1 to 4,000 characters");
      if (!/\bselect\b/i.test(query)) return json(200, { values: [], error: "HogQL: the query must start with SELECT" });
      return json(200, { values: readQuery(query, week, 4), error: null });
    }
    const x = db.metrics.find((y) => y.id === p[2]);
    if (!x) return fail(404, "Metric not found");
    if (p.length === 3 && m === "GET") {
      const values = db.values
        .filter((v) => v.metric_id === x.id)
        .sort((a, b) => a.week_start.localeCompare(b.week_start))
        .slice(-52)
        .map(valueOut);
      const variances = db.variances.filter((v) => v.metric_id === x.id).sort((a, b) => b.week_start.localeCompare(a.week_start)).map((v) => varianceOut(ctx, db, v));
      return json(200, { ...metricOut(ctx, db, x), values, variances, definitions: x.definitions });
    }
    if (p.length === 3 && m === "PATCH") {
      if (!approver) return notApprover();
      const input = await body<Schemas["MetricPatch"]>();
      if (input.lock_version !== x.lock_version) return fail(409, "Someone changed this metric; reload to see their change");
      const next = { ...x, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== "lock_version")) } as Metric;
      const bad = invalid(ctx, db, next, x.id);
      if (bad) return fail(422, bad);
      if (next.query !== x.query || next.unit !== x.unit) {
        next.definition_version = x.definition_version + 1;
        next.definitions = [...x.definitions, { version: next.definition_version, unit: next.unit, query: next.query, at: now().toISOString() }];
      }
      Object.assign(x, next, { lock_version: x.lock_version + 1 });
      return json(200, metricOut(ctx, db, x));
    }
    if (p.length === 4 && m === "POST" && (p[3] === "archive" || p[3] === "restore")) {
      if (!approver) return notApprover();
      Object.assign(x, { status: p[3] === "archive" ? "archived" : "active", lock_version: x.lock_version + 1 });
      return json(200, metricOut(ctx, db, x));
    }
    if (p.length === 4 && m === "POST" && p[3] === "pull") {
      if (!approver) return notApprover();
      if (x.source !== "posthog" || !x.query) return fail(409, "Only a PostHog metric is pulled");
      if (!db.analytics) return fail(409, "Connect PostHog in Settings › Analytics first");
      const [v] = readQuery(x.query, week, 1);
      db.values = db.values.filter((y) => !(y.metric_id === x.id && y.week_start === week));
      db.values.push({ ...v, metric_id: x.id, source: "posthog", definition_version: x.definition_version, note: null, recorded_by: null, recorded_at: now().toISOString() });
      toGoal(ctx, x, week, v.value);
      Object.assign(x, { status: "active", last_error: null, last_pulled_at: now().toISOString() });
      return json(200, metricOut(ctx, db, x));
    }
    if (p.length === 5 && p[3] === "values") {
      const day = p[4];
      if (!(approver || x.owner_id === ctx.me.id)) return fail(403, "Only the metric's owner or an approver records its values");
      if (x.source === "posthog") return fail(409, "A PostHog metric's values are read from PostHog");
      if (m === "PUT") {
        if (!isMonday(day) || day > week) return fail(422, "A week starts on a Monday and has ended");
        const input = await body<{ value: number; note?: string | null }>();
        if (typeof input.value !== "number" || Number.isNaN(input.value)) return fail(422, "Give a number");
        db.values = db.values.filter((y) => !(y.metric_id === x.id && y.week_start === day));
        const row: Value = { metric_id: x.id, week_start: day, value: input.value, source: x.source, definition_version: x.definition_version, note: input.note ?? null, recorded_by: ctx.me.id, recorded_at: now().toISOString() };
        db.values.push(row);
        toGoal(ctx, x, day, input.value);
        return json(200, valueOut(row));
      }
      if (m === "DELETE") {
        if (!approver) return notApprover();
        db.values = db.values.filter((y) => !(y.metric_id === x.id && y.week_start === day));
        toGoal(ctx, x, day, null);
        return new Response(null, { status: 204 });
      }
    }
    return fail(404, "Route not found");
  }

  // /v1/metric-variances
  if (p.length === 2 && m === "GET") {
    const status = q.get("status");
    const metric = q.get("metric_id");
    return json(
      200,
      db.variances
        .filter((v) => (!status || v.status === status) && (!metric || v.metric_id === metric))
        .sort((a, b) => b.week_start.localeCompare(a.week_start))
        .map((v) => varianceOut(ctx, db, v)),
    );
  }
  const v = db.variances.find((y) => y.id === p[2]);
  if (!v) return fail(404, "Variance not found");
  const x = db.metrics.find((y) => y.id === v.metric_id)!;
  if (p.length !== 4 || m !== "POST") return fail(404, "Route not found");
  const input = await body<{ explanation?: string; find_out_by?: string; reason?: string; lock_version?: number | null }>();
  if (input.lock_version != null && input.lock_version !== v.lock_version) return fail(409, "Someone answered this variance; reload to see it");
  if (p[3] === "noise") {
    if (!approver) return notApprover();
    if (!input.reason?.trim()) return fail(422, "Say why it is noise");
    Object.assign(v, { status: "noise", noise_reason: input.reason.trim(), explained_by: ctx.me.id });
  } else {
    if (!(approver || x.owner_id === ctx.me.id)) return fail(403, "Only the metric's owner or an approver explains its variances");
    if (p[3] === "explain") {
      const text = input.explanation?.trim() ?? "";
      if (text.length < 10 || text.length > 1000) return fail(422, "An explanation is 10 to 1,000 characters");
      Object.assign(v, { status: "explained", explanation: text, explained_by: ctx.me.id, find_out_by: null });
    } else if (p[3] === "unknown") {
      const today = dayIn(now(), zone);
      const day = input.find_out_by ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day <= today || day > addDays(today, 28)) return fail(422, "Find out by a day 1 to 28 days ahead");
      Object.assign(v, { status: "unknown", find_out_by: day });
    } else return fail(404, "Route not found");
  }
  v.lock_version += 1;
  return json(200, varianceOut(ctx, db, v));
}
