/**
 * Simple S7 (#723): Oracle's suggested features for a goal (GET /v1/simple/goal-suggestions,
 * POST /v1/simple/goals/{goal_id}/suggest, POST /v1/simple/goal-suggestions/{id}/accept and
 * /reject), as api/oracle/simple serves them, over the mock's roadmap (./simple-roadmap.ts).
 *
 * Invented data: Keep alerts quiet has no items, so Oracle suggested two features for it on
 * its own ("auto"); Grow retention has one suggestion a person asked for. "Suggest features"
 * queues a job that, once the mock clock passes DRAFT_JOB_MS, proposes 3 features from the
 * goal's pool, never one whose title a person rejected for that goal. Accept is an add_item
 * change on the goal (./simple-changes.ts: editors apply, others propose); Reject is for
 * approvers and owners.
 */
import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { stableUuid } from "./ids";
import { closed, GOALS, goalId, lookalikes, matchesOf, type GoalSuggestionRow, type SimpleDb } from "./simple-roadmap";

type Role = Schemas["Me"]["role"];

/** How long a suggest job runs in the mock (ms of the mock clock). */
export const SUGGEST_JOB_MS = 1_500;

interface Idea {
  title: string;
  outcome: string;
  why: string;
  evidence: Schemas["SimpleEvidence"][];
}

const ev = (label: string, kind: string, confidence: "high" | "medium" | "low", ref: string | null = null): Schemas["SimpleEvidence"] => ({
  label, kind, ref, url: ref ? `/baseline?entity=${ref}` : null, confidence,
});

/** Each goal's invented ideas, in the order Oracle offers them. */
const POOL: Record<string, Idea[]> = {
  "quiet-alerts": [
    { title: "Quiet hours for alerts", outcome: "Teams set hours when no alert pushes", why: "Most mutes happen at night, when nobody acts on an alert.", evidence: [ev("12 requests for night-time silence", "request", "high", "req-quiet-hours"), ev("Mutes peak 22:00-06:00", "metric", "medium")] },
    { title: "Alert bundling per rule", outcome: "One message for a burst of alerts of the same rule", why: "Bursts of the same rule are the second reason teams mute.", evidence: [ev("Support thread: alert storms", "conversation", "medium")] },
    { title: "Snooze an alert for a day", outcome: "A person pauses one alert without muting the rule", why: "People mute a whole rule to stop one noisy alert.", evidence: [ev("8 requests to snooze", "request", "medium", "req-snooze")] },
    { title: "Noise score per rule", outcome: "Owners see which rules fire most and are ignored", why: "Owners cannot tell which rules cause the noise.", evidence: [ev("Interview: the ops lead", "interview", "low")] },
    { title: "Digest instead of push", outcome: "Low-priority alerts arrive once a day", why: "Low-priority alerts are read in batches anyway.", evidence: [ev("Digest opens are steady", "metric", "medium")] },
  ],
  "grow-retention": [
    { title: "Alert templates for new teams", outcome: "A new team starts from three proven rules", why: "Teams that set up three rules in week one stay.", evidence: [ev("Cohort: 3 rules in week one", "metric", "high"), ev("5 requests for examples", "request", "medium", "req-templates")] },
    { title: "Weekly team health email", outcome: "Leads get one email on what their alerts caught", why: "Leads who see value each week renew.", evidence: [ev("Renewal calls mention reporting", "conversation", "medium")] },
    { title: "Shared alert inbox", outcome: "A team works its alerts in one shared list", why: "Alerts handled by one person get dropped when they leave.", evidence: [ev("Churn interview: the owner left", "interview", "low")] },
    { title: "Alert history search", outcome: "People find a past alert by rule or text", why: "People search old alerts before renewing.", evidence: [ev("3 requests for search", "request", "low")] },
  ],
  "faster-activation": [
    { title: "Connect a source in one click", outcome: "A new team connects its first source in a minute", why: "Most new teams stop at the source step.", evidence: [ev("Drop-off at step 2 of setup", "metric", "high")] },
    { title: "First alert in the tour", outcome: "The tour ends with a working alert", why: "Teams that see an alert fire on day one come back.", evidence: [ev("Activation cohort", "metric", "medium")] },
    { title: "Invite from the checklist", outcome: "The checklist asks for one teammate", why: "Teams of two activate twice as often.", evidence: [ev("Invites and activation", "metric", "medium")] },
    { title: "Setup help chat", outcome: "A new team asks a question without leaving setup", why: "Support tickets in week one are setup questions.", evidence: [ev("Week-one tickets", "conversation", "low")] },
  ],
};

const FLOW = (title: string): Schemas["SimpleFlow"] => ({
  title,
  steps: ["Open the alert settings", `Choose ${title.toLowerCase()}`, "Confirm in one step", "See the change on the next alert"],
  screen: { title: `${title} settings`, regions: ["Header: what it does", "The setting", "A preview of the next alert", "Save and Cancel buttons"] },
});

function row(goal: string, idea: Idea, origin: GoalSuggestionRow["origin"], at: string, seed: string): GoalSuggestionRow {
  return {
    id: stableUuid(`simple-goal-suggestion/${goal}/${seed}/${idea.title}`), goal, title: idea.title, outcome: idea.outcome, why: idea.why, evidence: idea.evidence,
    status: "open", reason: null, origin, created_at: at, decided_by_name: null, decided_at: null, change_id: null, item_id: null, flow: FLOW(idea.title),
  };
}

/** The seeded suggestions: two Oracle made on its own for the empty goal, one a person asked for. */
export function seedGoalSuggestions(): GoalSuggestionRow[] {
  const at = new Date(mockNowMs() - 86_400_000).toISOString();
  return [
    row("quiet-alerts", POOL["quiet-alerts"][0], "auto", at, "seed"),
    row("quiet-alerts", POOL["quiet-alerts"][1], "auto", at, "seed"),
    row("grow-retention", POOL["grow-retention"][0], "on_demand", at, "seed"),
  ];
}

/** Whether the goal has no live roadmap item. */
const isEmpty = (db: SimpleDb, goal: string): boolean => !db.items.some((s) => !closed(s) && (s.goal === goal || (s.goals ?? []).includes(goal)));

/** The suggest jobs whose time has come propose up to 3 new features; an empty goal gets one automatically, once. */
function settle(db: SimpleDb): void {
  db.goal_suggestions ??= seedGoalSuggestions();
  db.auto_done ??= ["quiet-alerts"];
  db.goal_jobs ??= {};
  const now = mockNowMs();
  for (const goal of Object.keys(GOALS)) {
    if (isEmpty(db, goal) && !db.auto_done.includes(goal) && !db.goal_jobs[goal]) {
      db.auto_done.push(goal);
      db.goal_jobs[goal] = { until: now + SUGGEST_JOB_MS, job_id: crypto.randomUUID(), origin: "auto" };
    }
    const job = db.goal_jobs[goal];
    if (!job || job.until > now) continue;
    delete db.goal_jobs[goal];
    const taken = new Set(db.goal_suggestions.filter((s) => s.goal === goal).map((s) => s.title.toLowerCase()));
    const fresh = (POOL[goal] ?? []).filter((i) => !taken.has(i.title.toLowerCase())).slice(0, 3);
    const at = new Date(now).toISOString();
    db.goal_suggestions.push(...fresh.map((i) => row(goal, i, job.origin, at, job.job_id)));
  }
}

function out(db: SimpleDb, s: GoalSuggestionRow, role: Role): Schemas["SimpleGoalSuggestion"] {
  const open = s.status === "open";
  return {
    id: s.id, goal: { id: goalId(s.goal), key: s.goal, title: GOALS[s.goal] }, title: s.title, outcome: s.outcome, why: s.why, evidence: s.evidence,
    status: s.status, reason: s.reason, origin: s.origin, created_at: s.created_at, decided_by_name: s.decided_by_name, decided_at: s.decided_at,
    change_id: s.change_id, item_id: s.item_id, looks_like: open ? matchesOf(db, lookalikes(db, s.title, null)) : [], flow: s.flow,
    can_accept: open && role !== "viewer",
    can_reject: open && (role === "owner" || role === "approver"),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const goalOf = (value: string | undefined): string | undefined => Object.keys(GOALS).find((k) => goalId(k) === value || k === value);

/** /v1/simple/goal-suggestions and /v1/simple/goals/{goal_id}/suggest. `addItem` makes the add_item change. */
export async function routeGoalSuggestions(
  db: SimpleDb,
  ctx: { id: string; role: Role; names: Record<string, string> },
  req: Request,
  p: string[],
  q: URLSearchParams,
  addItem: (body: Schemas["SimpleChangeIn"]) => Promise<Response>,
): Promise<Response | null> {
  settle(db);
  const m = req.method;
  const rows = db.goal_suggestions!;
  if (p[2] === "goals") {
    if (p[4] !== "suggest" || m !== "POST") return null;
    const goal = goalOf(p[3]);
    if (!goal) return json(404, { detail: "No such goal" });
    const job = (db.goal_jobs![goal] ??= { until: mockNowMs() + SUGGEST_JOB_MS, job_id: crypto.randomUUID(), origin: "on_demand" });
    return json(200, { goal_id: goalId(goal), pending: true, job_id: job.job_id });
  }
  if (!p[3] && m === "GET") {
    const only = q.get("goal_id") ? goalOf(q.get("goal_id")!) : undefined;
    if (q.get("goal_id") && !only) return json(404, { detail: "No such goal" });
    const status = q.get("status") ?? "open";
    const goals = Object.keys(GOALS).filter((g) => !only || g === only);
    return json(200, {
      goals: goals.map((g) => ({ goal: { id: goalId(g), key: g, title: GOALS[g] }, pending: !!db.goal_jobs![g], empty: isEmpty(db, g) })),
      suggestions: rows.filter((s) => goals.includes(s.goal) && s.status === status).map((s) => out(db, s, ctx.role)),
    });
  }
  if (m !== "POST" || !p[3]) return null;
  const s = rows.find((x) => x.id === p[3]);
  if (!s) return json(404, { detail: "No such suggestion" });
  const body = (await req.json().catch(() => ({}))) as { roadmap_id?: string | null; session_id?: string | null; reason?: string | null };
  if (p[4] === "reject") {
    if (ctx.role !== "owner" && ctx.role !== "approver") return json(403, { detail: "Requires the approver role" });
    if (s.status !== "open") return json(409, { detail: `This suggestion is ${s.status} already` });
    const reason = (body.reason ?? "").trim();
    Object.assign(s, { status: "rejected", reason: reason || null, decided_by_name: ctx.names[ctx.id] ?? "someone", decided_at: new Date(mockNowMs()).toISOString() });
    return json(200, out(db, s, ctx.role));
  }
  if (p[4] !== "accept") return null;
  if (s.status !== "open") return json(409, { detail: `This suggestion is ${s.status} already` });
  const res = await addItem({
    op: "add_item",
    target: { roadmap_id: body.roadmap_id ?? null, where: { kind: "goal", value: goalId(s.goal) }, suggestion_id: s.id },
    before: {},
    after: { title: s.title, outcome: s.outcome },
    session_id: body.session_id ?? null,
  });
  if (res.status !== 201) return res;
  const result = (await res.json()) as Schemas["SimpleChangeResult"];
  Object.assign(s, {
    status: "accepted", change_id: result.change.id, item_id: String(result.change.target.item_id),
    decided_by_name: ctx.names[ctx.id] ?? "someone", decided_at: new Date(mockNowMs()).toISOString(),
  });
  return json(200, result);
}
