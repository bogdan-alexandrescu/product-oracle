/**
 * Simple S7 (#723): Oracle's suggested features for a goal (GET /v1/simple/goal-suggestions,
 * POST /v1/simple/goals/{goal_id}/suggest, POST /v1/simple/goal-suggestions/{id}/accept and
 * /reject), as api/oracle/simple serves them, over the mock's roadmap (./simple-roadmap.ts).
 *
 * Invented data: Keep alerts quiet has no items, so Oracle suggested two features for it on
 * its own ("auto"); Grow retention has one suggestion a person asked for. "Suggest features"
 * queues a job that, once the mock clock passes DRAFT_JOB_MS, proposes 3 features from the
 * goal's pool, never one whose title a person rejected for that goal. People suggest too
 * (POST /v1/simple/goals/{goal_id}/suggestions, commenters and up, origin "person"; the chat's
 * suggest_feature card files the same). Only who decides the goal's suggestions (an owner, or
 * the decider of the goal's roadmap) accepts (an add_item change on the goal, applied with
 * Undo) or rejects.
 */
import type { Schemas } from "@/lib/api/client";
import { plainFlow } from "./simple-visuals";
import { mockNowMs } from "./clock";
import { newCompany, stableUuid } from "./ids";
import { canEditRoadmap, closed, GOALS, goalId, knowTalkGoals, lookalikes, matchesOf, TALK_GOALS, type GoalSuggestionRow, type SimpleDb } from "./simple-roadmap";

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
  // fid-prio: the plan's goals ("simple-plan"), for "✦ Ask Oracle to suggest" on Priorities' Goal buckets.
  reliability: [
    { title: "Setup health check", outcome: "An admin sees which setup steps fail most this week", why: "Most setup failures repeat on the same two steps.", evidence: [ev("Setup failures by step", "metric", "high")] },
    { title: "Resume a broken setup", outcome: "A team picks up setup where it stopped", why: "Teams that restart setup from the top often give up.", evidence: [ev("Restarted setups", "metric", "medium")] },
  ],
  growth: [
    { title: "Invite reminders", outcome: "A teammate who has not joined gets one reminder", why: "Half of the invites sent are never opened.", evidence: [ev("Invite opens", "metric", "medium")] },
    { title: "Share a setup link", outcome: "An admin shares one link that sets a new team up", why: "Admins ask how to bring in a second team.", evidence: [ev("4 requests for a team link", "request", "low")] },
  ],
  activation: [
    { title: "Setup progress email", outcome: "An admin gets one email with the steps left", why: "Teams that stop on day one rarely come back without a nudge.", evidence: [ev("Day-one drop-off", "metric", "medium")] },
  ],
  revenue: [
    { title: "Trial end reminder", outcome: "A team hears three days before its trial ends", why: "Most trials end without the admin noticing.", evidence: [ev("Trial ends without a visit", "metric", "medium")] },
  ],
};

const FLOW = (title: string): Schemas["SimpleFlow"] => (plainFlow({
  title,
  steps: ["Open the alert settings", `Choose ${title.toLowerCase()}`, "Confirm in one step", "See the change on the next alert"],
  screen: { title: `${title} settings`, regions: ["Header: what it does", "The setting", "A preview of the next alert", "Save and Cancel buttons"] },
}));

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
  // A dated plan's goals are goals people suggest under (fid-prio); Oracle suggests for them only when asked.
  knowTalkGoals(db);
  db.goal_suggestions ??= seedGoalSuggestions();
  db.auto_done ??= ["quiet-alerts", ...Object.keys(TALK_GOALS)];
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

type Ctx = { id: string; role: Role; names: Record<string, string>; owners?: string[]; roles?: Record<string, Role> };

/** The roadmap a goal's suggestions belong to: the one holding its items, else the first. */
function roadmapOf(db: SimpleDb, goal: string): string | null {
  return db.items.find((x) => !closed(x) && (x.goal === goal || (x.goals ?? []).includes(goal)))?.roadmap ?? db.items[0]?.roadmap ?? null;
}

/**
 * Who decides a goal's suggestions and whether it is the caller (additions.deciding): the
 * caller when drafts.can_edit lets them change its roadmap (an owner; its decider; with none,
 * its track owners who are approvers); named, the decider, else its approving track owner,
 * else the company's first owner.
 */
export function goalDecider(db: SimpleDb, goal: string, ctx: Ctx): { id: string | null; mine: boolean } {
  const rm = roadmapOf(db, goal);
  const named = rm ? (db.deciders?.[rm] ?? null) : null;
  const tracks = new Set(db.items.filter((s) => s.roadmap === rm && s.track).map((s) => s.track!));
  const approving = [...tracks].map((t) => db.track_owners?.[t]).find((p) => !!p && (ctx.roles?.[p] === "approver" || ctx.roles?.[p] === "owner")) ?? null;
  const id = named ?? approving ?? ctx.owners?.[0] ?? null;
  return { id, mine: rm ? canEditRoadmap(db, rm, ctx) : ctx.role === "owner" };
}

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A person's suggestion (the drawer's form and the chat's card): the row, or the refusal. */
export function fileSuggestion(db: SimpleDb, ctx: Ctx, goal: string, title: string, outcome: string): GoalSuggestionRow | { status: number; detail: string } {
  settle(db);
  if (ctx.role === "viewer") return { status: 403, detail: "Viewers read; commenters and up suggest" };
  const t = title.replace(/\s+/g, " ").trim();
  const o = outcome.replace(/\s+/g, " ").trim();
  if (!t || t.length > 200 || !o || o.length > 1000) return { status: 422, detail: "A name and what it does, and for whom" };
  if (db.goal_suggestions!.some((x) => x.goal === goal && x.status !== "accepted" && norm(x.title) === norm(t))) return { status: 409, detail: `${t} is suggested for ${GOALS[goal]} already` };
  const r: GoalSuggestionRow = {
    id: crypto.randomUUID(), goal, title: t, outcome: o, why: "", evidence: [], status: "open", reason: null, origin: "person", proposed_by: ctx.id,
    created_at: new Date(mockNowMs()).toISOString(), decided_by_name: null, decided_at: null, change_id: null, item_id: null, flow: null,
  };
  db.goal_suggestions!.push(r);
  return r;
}

/** Takes back a person's suggestion while it is open (the chat card's Undo). */
export function unfileSuggestion(db: SimpleDb, id: string): boolean {
  const rows = db.goal_suggestions ?? [];
  const s = rows.find((x) => x.id === id);
  if (!s || s.status !== "open") return false;
  db.goal_suggestions = rows.filter((x) => x !== s);
  return true;
}

function out(db: SimpleDb, s: GoalSuggestionRow, ctx: Ctx): Schemas["SimpleGoalSuggestion"] {
  const open = s.status === "open";
  const decides = goalDecider(db, s.goal, ctx).mine;
  return {
    id: s.id, goal: { id: goalId(s.goal), key: s.goal, title: GOALS[s.goal] }, title: s.title, outcome: s.outcome, why: s.why, evidence: s.evidence,
    status: s.status, reason: s.reason, origin: s.origin, created_at: s.created_at, decided_by_name: s.decided_by_name, decided_at: s.decided_at,
    change_id: s.change_id, item_id: s.item_id, looks_like: open ? matchesOf(db, lookalikes(db, s.title, null)) : [], flow: s.flow,
    proposed_by_name: s.proposed_by ? (ctx.names[s.proposed_by] ?? "someone") : null,
    can_accept: open && decides,
    can_reject: open && decides,
    // oracle.simple.quality: a suggestion that failed its checks twice is the owners' to look at.
    needs_look: ctx.role === "owner" ? [...(s.checks ?? [])] : [],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const goalOf = (value: string | undefined): string | undefined => Object.keys(GOALS).find((k) => goalId(k) === value || k === value);

/** /v1/simple/goal-suggestions and /v1/simple/goals/{goal_id}/suggest. `addItem` makes the add_item change. */
export async function routeGoalSuggestions(
  db: SimpleDb,
  ctx: Ctx,
  req: Request,
  p: string[],
  q: URLSearchParams,
  addItem: (body: Schemas["SimpleChangeIn"]) => Promise<Response>,
): Promise<Response | null> {
  settle(db);
  const m = req.method;
  const rows = db.goal_suggestions!;
  if (p[2] === "goals") {
    if (m !== "POST" || (p[4] !== "suggest" && p[4] !== "suggestions")) return null;
    const goal = goalOf(p[3]);
    if (!goal) return json(404, { detail: "No such goal" });
    if (p[4] === "suggestions") {
      const body = (await req.json().catch(() => ({}))) as { title?: string; outcome?: string };
      const r = fileSuggestion(db, ctx, goal, body.title ?? "", body.outcome ?? "");
      return "detail" in r ? json(r.status, { detail: r.detail }) : json(201, out(db, r, ctx));
    }
    if (ctx.role === "viewer") return json(403, { detail: "Commenters and up ask Oracle for suggestions" });
    const job = (db.goal_jobs![goal] ??= { until: mockNowMs() + SUGGEST_JOB_MS, job_id: crypto.randomUUID(), origin: "on_demand" });
    return json(200, { goal_id: goalId(goal), pending: true, job_id: job.job_id });
  }
  if (!p[3] && m === "GET") {
    const only = q.get("goal_id") ? goalOf(q.get("goal_id")!) : undefined;
    if (q.get("goal_id") && !only) return json(404, { detail: "No such goal" });
    const status = q.get("status") ?? "open";
    // A new company has no confirmed goal yet: none to suggest under.
    const goals = newCompany() ? [] : Object.keys(GOALS).filter((g) => !only || g === only);
    return json(200, {
      goals: goals.map((g) => {
        const d = goalDecider(db, g, ctx);
        return { goal: { id: goalId(g), key: g, title: GOALS[g] }, pending: !!db.goal_jobs![g], empty: isEmpty(db, g), decider_name: d.id ? (ctx.names[d.id] ?? null) : null, can_decide: d.mine };
      }),
      suggestions: rows.filter((s) => goals.includes(s.goal) && s.status === status && (ctx.role === "owner" || !s.checks?.length)).map((s) => out(db, s, ctx)),
    });
  }
  if (m !== "POST" || !p[3]) return null;
  const s = rows.find((x) => x.id === p[3]);
  if (!s) return json(404, { detail: "No such suggestion" });
  const body = (await req.json().catch(() => ({}))) as { roadmap_id?: string | null; session_id?: string | null; reason?: string | null };
  if ((p[4] === "reject" || p[4] === "accept") && !goalDecider(db, s.goal, ctx).mine) return json(403, { detail: "Only the decider accepts or rejects suggestions" });
  if (p[4] === "reject") {
    if (s.status !== "open") return json(409, { detail: `This suggestion is ${s.status} already` });
    const reason = (body.reason ?? "").trim();
    Object.assign(s, { status: "rejected", reason: reason || null, decided_by_name: ctx.names[ctx.id] ?? "someone", decided_at: new Date(mockNowMs()).toISOString() });
    return json(200, out(db, s, ctx));
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
