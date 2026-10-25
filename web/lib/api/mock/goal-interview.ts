/**
 * B6 Goals interview in the mock: the three routes (start one, start several, the vague
 * goals), Propose and Dismiss on a goal_measure version, the Accept-now hook, and a scripted
 * Oracle for goal subjects: a fixed opening turn with two versions for "Cut early churn",
 * one pushback when a target is already met by the start or current value, and the closing
 * "“…” is measurable now". Nothing starts by itself: a discussion exists only once a person
 * asks for it. Generic, made-up data only.
 */
import type { Schemas } from "@/lib/api/client";

import type { BaselineState } from "./baseline";
import { type ChangeRow, type DiscussionRow, type DiscussionsDb } from "./discussions";
import { goalCheck, refusedProblems } from "./goals";

type Role = Schemas["MemberOut"]["role"];
type Attrs = Record<string, unknown>;
type Entity = BaselineState["entities"][number];

export type GoalInterviewContext = {
  baseline: BaselineState;
  discussions: () => DiscussionsDb;
  members: { id: string; email: string; role: Role; status?: string | null }[];
  me: { id: string; role: Role };
  isMember: (id: string) => boolean;
  uuid: () => string;
  now: () => string;
  /** H11 Shape goals' level (Recommend when not given): Observe opens no interview, Draft keeps one version. */
  goalsLevel?: () => "observe" | "draft" | "recommend" | "act";
};

/** The API's refusal at Observe (oracle.baseline.goal_interview.OBSERVING). */
export const GOALS_OBSERVING = "Oracle is set to observe goals: it flags gaps and drafts nothing. An owner can change this in Settings › Autonomy.";

/** A scripted Oracle reply: its text in the pieces it streams in, and its citations. */
export type ReplyScript = { pieces: string[]; citations: Record<string, unknown>[] };

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, detail: string) => json(status, { detail });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WORDS: Record<string, string> = { at_least: "at least", above: "more than", at_most: "at most", below: "less than" };
const day = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const fig = (n: unknown, unit: unknown) => (unit === "%" ? `${n}%` : `${n} ${unit ?? ""}`.trim());
/** The fields a person reads as one: a target is its value, unit and comparison. */
const GROUP: Record<string, string> = { metric: "metric", unit: "target", comparison: "target", target: "target", horizon: "horizon", owner: "owner" };

/** goal_check.missing as the interview names it: "target, horizon, owner". */
export function missingGroups(missing: readonly string[]): string[] {
  return [...new Set(missing.map((k) => GROUP[k] ?? k))];
}

/** G3's card label for goal_measure: "Make Cut early churn measurable: less than 8% by Jun 30". */
export function measureLabel(title: string, p: Attrs): string {
  if (!(p.comparison && p.target != null)) return `Make ${title} measurable: ${p.metric ?? "a measurable target"}`;
  const what = `${WORDS[String(p.comparison)] ?? p.comparison} ${fig(p.target, p.unit)}`;
  const by = typeof p.due === "string" ? ` by ${day(p.due)}` : typeof p.horizon === "string" ? ` within the ${p.horizon} horizon` : "";
  return `Make ${title} measurable: ${what}${by}`;
}

/** Evidence the scripted Oracle cites (as members see it: excerpts, never a private item). */
const CHURN_CITATIONS = [
  { n: 1, kind: "evidence", ref: "support-export-q3", title: "Support export, Q3: accounts closed by age", url: null, confidence: 0.74, low_confidence: false },
  { n: 2, kind: "evidence", ref: "churn-review", title: "Churn review notes: what is reachable by mid-year", url: null, confidence: 0.62, low_confidence: false },
];

/** The two versions Oracle offers for "Cut early churn" (never weight or owner). */
function churnVersions(goalId: string): { payload: Attrs; rationale: string }[] {
  return [
    {
      payload: {
        entity_id: goalId, metric: "Accounts leaving in their first 90 days", unit: "%", comparison: "below",
        target: 8, start: 11, horizon: "medium", due: "2027-06-30",
      },
      rationale: "The support export shows 11% of new accounts leaving in their first 90 days [c:1]; the churn review calls 8% reachable by mid-year [c:2].",
    },
    {
      payload: {
        entity_id: goalId, metric: "Accounts leaving in their first 30 days", unit: "%", comparison: "at_most",
        target: 5, start: 7, horizon: "short", due: "2026-12-31",
      },
      rationale: "Most early losses happen in the first month [c:1]; a 30-day measure shows progress sooner.",
    },
  ];
}

/** The opening turn: restates the goal, names what is missing, offers versions, asks one question. */
function openingTurn(goal: Entity, missing: string[], versions: number): ReplyScript {
  const said = goal.body ? `“${goal.title}” says: ${goal.body}` : `“${goal.title}” has no description yet.`;
  const lines = [`${said}\nMissing: ${missing.join(", ")}.`];
  if (versions > 0) {
    lines.push(`\nI propose ${versions === 1 ? "a measurable version" : `${versions} measurable versions`} below, from the support export [c:1] and the churn review [c:2].`);
    lines.push(versions === 1 ? "\nEdit it as you see fit, then propose it." : "\nWhich version fits best?");
  } else {
    lines.push(`\nWho should own “${goal.title}”?`);
  }
  return { pieces: lines, citations: versions > 0 ? CHURN_CITATIONS : [] };
}

/** Oracle's next question after a person's message in a goals interview. */
export function goalInterviewReply(s: BaselineState, d: DiscussionRow, body: string, isMember: (id: string) => boolean): ReplyScript | null {
  if (!(d.subject as { interview?: unknown }).interview) return null;
  const goal = s.entities.find((e) => e.id === d.subject.entity_id);
  if (!goal) return null;
  const missing = missingGroups(goalCheck(goal.attrs, goal.status, isMember).missing);
  const owner = missing.includes("owner") ? `Who should own “${goal.title}”?` : "Propose the version that fits, or Edit it first.";
  const picked = /use version (\d)/i.exec(body);
  if (picked) return { pieces: [`Version ${picked[1]} it is. `, "Check its fields with Edit, then Propose it. ", owner], citations: [] };
  if (/don.?t know/i.test(body)) return { pieces: ["That's fine: you can propose a version now and change it later. ", owner], citations: [] };
  return { pieces: ["Thanks. ", owner], citations: [] };
}

const meets = (v: number, c: string, t: number) => ({ at_least: v >= t, above: v > t, at_most: v <= t, below: v < t })[c] ?? false;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The goal_measure payload as goal attrs (owner_id is the goal's owner). */
function attrsOf(p: Attrs): Attrs {
  const out: Attrs = {};
  for (const k of ["metric", "unit", "comparison", "target", "start", "horizon", "due", "weight"]) if (p[k] != null) out[k] = p[k];
  if (p.owner_id != null) out.owner = p.owner_id;
  return out;
}

export async function routeGoalInterview(ctx: GoalInterviewContext, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "baseline") return null;
  const m = req.method;
  const [, , head, id, action] = p;
  const isStart = head === "entities" && !!id && action === "interview" && m === "POST";
  const isMany = head === "goals" && id === "interview" && !action && m === "POST";
  const isVague = head === "goals" && id === "vague" && !action && m === "GET";
  const isMeasure = head === "goal-measures" && !!id && (action === "propose" || action === "dismiss") && m === "POST";
  if (!isStart && !isMany && !isVague && !isMeasure) return null;

  const s = ctx.baseline;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const at = (min: Role) => RANK[ctx.me.role] >= RANK[min];
  const check = (g: Entity) => goalCheck(g.attrs, g.status, ctx.isMember);
  const vague = () => s.entities.filter((e) => e.type === "goal" && (e.status === "confirmed" || e.status === "proposed") && !check(e).measurable);
  const openOn = (goalId: string) => ctx.discussions().discussions.find((d) => d.subject_key === `entity:${goalId}` && d.status === "open");
  const entityOut = (e: Entity) => ({ ...e, evidence_count: s.evidence.filter((x) => x.entity_id === e.id).length, goal_check: check(e) });

  /** Reopen the open interview on the goal, or create one with its opening turn. */
  const start = (goal: Entity, priv: boolean): { discussion_id: string; created: boolean } => {
    const open = openOn(goal.id);
    if (open) return { discussion_id: open.id, created: false };
    const db = ctx.discussions();
    const now = ctx.now();
    const d: DiscussionRow = {
      id: ctx.uuid(),
      subject_kind: "entity",
      subject: { entity_id: goal.id, interview: true },
      subject_key: `entity:${goal.id}`,
      subject_label: `Goal · ${goal.title}`,
      subject_url: `/baseline?entity=${goal.id}`,
      document_id: null,
      run_id: null,
      title: `Make “${goal.title}” measurable`,
      visibility: priv ? "private" : "open",
      author_only: false,
      status: "open",
      origin: "discuss",
      started_by: ctx.me.id,
      summary: null,
      summary_status: "none",
      summary_shared: !priv,
      last_message_at: now,
      lock_version: 1,
      created_at: now,
      updated_at: now,
    };
    db.discussions.push(d);
    const join = (user_id: string, added_via: "started" | "added") =>
      db.participants.push({ discussion_id: d.id, user_id, added_via, left_at: null, last_read_at: null, created_at: now });
    join(ctx.me.id, "started");
    const owner = goal.attrs.owner;
    if (typeof owner === "string" && owner !== ctx.me.id && ctx.isMember(owner)) join(owner, "added");
    // H11: at Draft, one version for a named person to edit and own.
    const level = ctx.goalsLevel?.() ?? "recommend";
    const versions = (goal.key === "g.early-churn" ? churnVersions(goal.id) : []).slice(0, level === "draft" ? 1 : 3);
    for (const v of versions) {
      db.changes = db.changes ?? [];
      db.changes.push({
        id: ctx.uuid(),
        discussion_id: d.id,
        kind: "goal_measure",
        label: measureLabel(goal.title, v.payload),
        target: { entity_id: goal.id },
        payload: v.payload,
        edited_payload: null,
        rationale: v.rationale,
        proposed_by_kind: "oracle",
        proposed_by: null,
        suggested_by: null,
        status: "proposed",
        created_at: now,
        lock_version: 1,
        result_ref: null,
        pushback: null,
        override_reason: null,
      });
    }
    const script = openingTurn(goal, missingGroups(check(goal).missing), versions.length);
    db.messages.push({
      id: ctx.uuid(),
      discussion_id: d.id,
      author_kind: "oracle",
      author_id: null,
      body: "",
      mentions: [],
      mentions_oracle: false,
      reply_to: null,
      created_at: now,
      edited_at: null,
      deleted_at: null,
      status: "pending",
      citations: [],
      script: script.pieces,
      script_citations: script.citations,
    });
    return { discussion_id: d.id, created: true };
  };

  if (isVague) {
    return json(
      200,
      vague().map((g) => ({ entity: entityOut(g), missing: check(g).missing, discussion_id: openOn(g.id)?.id ?? null })),
    );
  }
  if (!at("commenter")) return refuse(403, "Requires the commenter role");
  const observing = ctx.goalsLevel?.() === "observe";

  if (isStart) {
    const goal = s.entities.find((e) => e.id === id);
    if (!goal) return refuse(404, "Entity not found");
    if (goal.type !== "goal") return refuse(422, "Only goals can be interviewed");
    if (check(goal).measurable) return refuse(422, "This goal is already measurable");
    if (observing) return refuse(409, GOALS_OBSERVING);
    const input = (await body<{ private?: boolean }>()) ?? {};
    const out = start(goal, !!input.private);
    return json(out.created ? 201 : 200, out);
  }
  if (isMany) {
    const input = (await body<{ entity_ids?: string[] | null }>()) ?? {};
    const goals = input.entity_ids ? vague().filter((g) => input.entity_ids!.includes(g.id)) : vague();
    if (observing && goals.length > 0) return refuse(409, GOALS_OBSERVING);
    return json(200, { discussions: goals.map((g) => ({ entity_id: g.id, ...start(g, false) })) });
  }

  // Propose / Dismiss a goal_measure version.
  const db = ctx.discussions();
  const change = (db.changes ?? []).find((c) => c.id === id);
  const d = change && db.discussions.find((x) => x.id === change.discussion_id);
  if (!change || !d) return refuse(404, "Change not found");
  if (d.visibility === "private" && !db.participants.some((x) => x.discussion_id === d.id && x.user_id === ctx.me.id && !x.left_at))
    return refuse(403, "This discussion is private");
  if (d.status === "closed") return refuse(409, "This discussion is closed");
  if (change.status !== "proposed") return refuse(409, `This version is already ${change.status}`);
  const out = (c: ChangeRow) => {
    const rest: Partial<ChangeRow> = { ...c };
    delete rest.discussion_id;
    return rest;
  };
  const oracleSays = (text: string, pushback: { reason: string } | null = null) => {
    const now = ctx.now();
    db.messages.push({
      id: ctx.uuid(),
      discussion_id: d.id,
      author_kind: "oracle",
      author_id: null,
      body: text,
      mentions: [],
      mentions_oracle: false,
      reply_to: null,
      created_at: now,
      edited_at: null,
      deleted_at: null,
      status: "complete",
      citations: [],
      pushback,
    });
    d.last_message_at = now;
  };

  if (action === "dismiss") {
    if (!at("approver")) return refuse(403, "Requires the approver role");
    Object.assign(change, { status: "dismissed", lock_version: change.lock_version + 1 });
    return json(200, out(change));
  }

  const input = (await body<{ payload?: Attrs | null; keep?: boolean }>()) ?? {};
  const goal = s.entities.find((e) => e.id === change.target.entity_id);
  if (!goal) return refuse(404, "Entity not found");
  const payload: Attrs = { ...(input.payload ?? change.edited_payload ?? change.payload), entity_id: goal.id };
  const attrs = attrsOf(payload);
  const merged = { ...goal.attrs, ...attrs };
  const errors = refusedProblems(merged, goal.attrs, ctx.isMember);
  if (errors.length) return json(422, { detail: `goal fields rejected: ${errors.length} problem(s)`, errors });

  // Pushback once: a target the start or current value already meets.
  const met = isNum(merged.target) && ["start", "current"].find((k) => isNum(merged[k]) && meets(merged[k] as number, String(merged.comparison), merged.target as number));
  if (met && !input.keep && !change.pushback) {
    const sentence = `The ${met} value ${merged[met]} already meets the target ${merged.target}; a target that is already met does not measure progress.`;
    change.pushback = { reason: sentence };
    oracleSays(`Pushback: ${sentence}`, { reason: sentence });
    return json(409, { detail: sentence, pushback: true });
  }
  if (met) {
    const line = `Kept target ${merged.target} although the ${met} value ${merged[met]} already meets it.`;
    change.override_reason = line;
    d.summary = d.summary ? `${d.summary} ${line}` : line;
    d.summary_status = "draft";
  }
  const proposalId = ctx.uuid();
  s.proposals.push({
    id: proposalId,
    entity_id: goal.id,
    edge_id: null,
    payload: { op: "update", kind: "entity", fields: { attrs }, reason: `From discussion ${d.title}`, origin: "user" },
    run_id: null,
    actor: `user:${ctx.me.id}`,
    status: "open",
    decided_by: null,
    decided_at: null,
    created_at: ctx.now(),
  });
  Object.assign(change, {
    status: "done",
    result_ref: { proposal_id: proposalId },
    edited_payload: input.payload ? payload : change.edited_payload,
    suggested_by: ctx.me.id,
    lock_version: change.lock_version + 1,
  });
  return json(200, out(change));
}

/**
 * After POST /v1/baseline/proposals/{id}/accept: a proposal made from a goals interview that
 * leaves its goal measurable closes the discussion with "“…” is measurable now". Accepting any
 * other proposal changes no discussion.
 */
export function afterAccept(ctx: GoalInterviewContext, proposalId: string) {
  const db = ctx.discussions();
  const change = (db.changes ?? []).find((c) => c.result_ref?.proposal_id === proposalId);
  const d = change && db.discussions.find((x) => x.id === change.discussion_id);
  if (!change || !d || !(d.subject as { interview?: unknown }).interview) return;
  const goal = ctx.baseline.entities.find((e) => e.id === change.target.entity_id);
  if (!goal) return;
  const c = goalCheck(goal.attrs, goal.status, ctx.isMember);
  const now = ctx.now();
  const text = c.measurable ? `“${goal.title}” is measurable now` : `Accepted. Still missing: ${missingGroups(c.missing).join(", ")}.`;
  db.messages.push({
    id: ctx.uuid(),
    discussion_id: d.id,
    author_kind: "oracle",
    author_id: null,
    body: text,
    mentions: [],
    mentions_oracle: false,
    reply_to: null,
    created_at: now,
    edited_at: null,
    deleted_at: null,
    status: "complete",
    citations: [],
  });
  d.last_message_at = now;
  if (c.measurable) d.status = "closed";
  d.lock_version += 1;
  d.updated_at = now;
}
