import type { Schemas } from "../client";
import { mockNowMs } from "./clock";
import { companyDateInWords } from "./connections";
import { stableUuid } from "./ids";

/**
 * prd-questions (mock): an invented PRD's open questions (Q1..Q16 of "Guided setup"), read
 * in as decisions: List and Board on Simple's Decisions, Home's "Decisions waiting for you",
 * the rail's count and a review meeting's "Decisions due". Their writes go through
 * POST /v1/simple/changes (decide_question, name_decider) and its undo, role-aware as the
 * other Simple ops: owners and the decider apply (with Undo), approvers and commenters
 * propose to the decider, viewers read. All data is invented.
 */

type Role = Schemas["Me"]["role"];
type Question = Schemas["SimpleQuestion"];
type Change = Schemas["SimpleChangeOut"];

export interface QuestionsCtx {
  me: { id: string; role: Role };
  members: { id: string; name: string; role: Role; email: string }[];
}

interface Q {
  n: number;
  title: string;
  /** Who decides: "owner" (the first owner), "approver" (approver@example.com) or none. */
  decider: string | null;
  /** Due, in days from the mock's today. */
  due: number;
  milestone: "M1" | "M2" | "M3";
  feature: [string, string];
  recommendation: string | null;
  alternatives: string[];
  chosen?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  in_prd?: boolean;
  pending?: { change_id: string; by: string; answer: string } | null;
  /** The meeting it was decided in. */
  meeting_id?: string | null;
}

interface QChange {
  change: Change;
  /** The question as it was before an applied change (for Undo). */
  was: Q;
}

export interface QuestionsDb {
  questions: Q[];
  changes: QChange[];
}

const DAY = 86_400_000;
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const MILESTONES = { M1: "Prove it", M2: "Scale volume", M3: "Open to all" } as const;
/** The mock's "Guided setup" PRD (./simple-one-pager.ts, ./simple-meetings.ts): its questions. */
export const QUESTIONS_PRD = { id: stableUuid("simple-one-pager-doc"), slug: "guided-setup", title: "Guided setup" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const iso = (t: number) => new Date(t).toISOString();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri Nov 6" (UTC, the mock company's days). */
const dayWords = (t: number) => {
  const d = new Date(t);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** The approved version the questions were read from, and when (a day before the mock's today). */
const SOURCE_VERSION = 3;
const todayStart = () => Math.floor(mockNowMs() / DAY) * DAY;

export function seedQuestions(ctx: QuestionsCtx): QuestionsDb {
  // A new company ("empty" scenario, as server.ts's MOCK_SCENARIO_KEY): no PRD, no questions.
  if (typeof localStorage !== "undefined" && localStorage.getItem("po-mock-scenario") === "empty") return { questions: [], changes: [] };
  const owner = ctx.members.find((m) => m.role === "owner")?.id ?? null;
  const approver = ctx.members.find((m) => m.email === "approver@example.com")?.id ?? null;
  const q = (n: number, title: string, decider: string | null, due: number, milestone: Q["milestone"], feature: [string, string], recommendation: string | null, alternatives: string[], extra: Partial<Q> = {}): Q => ({
    n, title, decider, due, milestone, feature, recommendation, alternatives, ...extra,
  });
  return {
    questions: [
      q(1, "Data retention period", owner, -10, "M1", ["F-02", "Team setup"], "Keep 90 days", ["Keep a year"], {
        chosen: "Keep 90 days", decided_by: owner, decided_at: iso(todayStart() - 6 * DAY + 10 * 3_600_000), in_prd: true,
      }),
      q(2, "Export format sign-off", null, 15, "M2", ["F-09", "Data export"], "CSV first", ["PDF first"]),
      q(3, "Offline mode scope", approver, 22, "M2", ["F-11", "Offline mode"], null, ["Read only", "Read and write"]),
      q(4, "Pricing for teams over 50", null, 39, "M3", ["F-20", "Team plans"], "Per seat", ["Flat price"]),
      q(5, "Reminder default time", owner, -6, "M1", ["F-03", "Health log"], "9:00 in each person's zone", ["Noon", "Let each person pick"]),
      q(6, "Invite limit on the free plan", owner, 4, "M1", ["F-05", "Invite teammates"], "5 invites", ["3 invites", "No limit"]),
      q(7, "Legal input on health notes", approver, -2, "M1", ["F-03", "Health log"], "Ask outside counsel", ["Use our own template"]),
      q(8, "Sign-in choice: Google at launch", owner, 7, "M1", ["F-01", "Sign in"], "Yes, at launch", ["After launch"]),
      q(9, "Onboarding checklist length", owner, 12, "M1", ["F-04", "Onboarding checklist"], "Five steps", ["Three steps", "Seven steps"]),
      q(10, "Weekly summary email", owner, 15, "M2", ["F-08", "Weekly summary"], "Monday mornings", ["Friday afternoons"]),
      q(11, "Dark mode in the first release", owner, 20, "M2", ["F-12", "Themes"], "Yes", ["Later"]),
      q(12, "Status page provider", approver, 22, "M2", ["F-14", "Status page"], "Host our own", ["Use a vendor"]),
      q(13, "Usage-based add-on", owner, 29, "M3", ["F-18", "Add-ons"], "Not this year", ["Pilot with five teams"]),
      q(14, "Public API rate limit", owner, 36, "M3", ["F-21", "Public API"], "100 calls a minute", ["1,000 calls a minute"]),
      q(15, "Referral reward", approver, 43, "M3", ["F-22", "Referrals"], "One free month", ["A gift card"]),
      q(16, "Self-serve plan cancel", owner, 50, "M3", ["F-24", "Billing settings"], "Yes, in two clicks", ["Through support"]),
    ],
    changes: [],
  };
}

const nameOf = (ctx: QuestionsCtx, id: string | null | undefined) => ctx.members.find((m) => m.id === id)?.name ?? "someone";
const ref = (ctx: QuestionsCtx, id: string) => ({ id, name: nameOf(ctx, id) });
const owners = (ctx: QuestionsCtx) => ctx.members.filter((m) => m.role === "owner").map((m) => m.id);
const decided = (q: Q) => !!q.chosen;

/** Owners and the decider apply; approvers and commenters propose; viewers read. */
function canOf(ctx: QuestionsCtx, q: Q): Schemas["SimpleQuestionCan"] {
  if (decided(q)) return { decide: false, propose: false, name_decider: false };
  const applies = ctx.me.role === "owner" || (q.decider === ctx.me.id && RANK[ctx.me.role] >= RANK.approver);
  return { decide: applies, propose: !applies && RANK[ctx.me.role] >= RANK.commenter, name_decider: applies };
}

function out(ctx: QuestionsCtx, q: Q): Question {
  const due = todayStart() + q.due * DAY;
  const late = !decided(q) && q.due < 0;
  const missing = decided(q) ? null : !q.decider ? "decider" : !q.recommendation ? "recommendation" : null;
  const chosenLabel = q.chosen === "recommended" ? q.recommendation : q.chosen;
  return {
    id: stableUuid(`simple-question/${q.n}`),
    number: 100 + q.n,
    code: `Q${q.n}`,
    title: q.title,
    status: decided(q) ? "decided" : "proposed",
    column: decided(q) ? "decided" : missing ? "needs_input" : "recommended",
    prd: QUESTIONS_PRD,
    decider: q.decider ? ref(ctx, q.decider) : null,
    missing,
    due_on: new Date(due).toISOString().slice(0, 10),
    due_label: decided(q) ? null : `${late ? "Late · due" : "Due"} ${dayWords(due)}`,
    late,
    blocks: {
      milestone: q.milestone,
      milestone_name: MILESTONES[q.milestone],
      features: [{ code: q.feature[0], title: q.feature[1] }],
      label: `Blocks ${q.milestone}: ${q.feature[0]} ${q.feature[1]}`,
    },
    recommendation: q.recommendation,
    alternatives: q.alternatives.map((label, i) => ({ key: `alt-${i + 1}`, label })),
    chosen: chosenLabel ?? null,
    decided_at: q.decided_at ?? null,
    decided_by: q.decided_by ? ref(ctx, q.decided_by) : null,
    // qa-simple-decide-7: decided_at is a real moment (unlike a due day), so its day reads
    // the company's zone (America/Los_Angeles), not UTC, as the API's company_time.day does.
    decided_label: decided(q) && q.decided_at ? `Decided ${q.in_prd ? "in the PRD " : ""}on ${companyDateInWords(q.decided_at)} by ${nameOf(ctx, q.decided_by)}` : null,
    waiting_for_me: !decided(q) && !!q.decider && q.decider === ctx.me.id && RANK[ctx.me.role] >= RANK.approver,
    pending: q.pending ? { change_id: q.pending.change_id, by: ref(ctx, q.pending.by), answer: q.pending.answer } : null,
    can: canOf(ctx, q),
    source: { version: SOURCE_VERSION, read_at: iso(todayStart() - DAY + 9 * 3_600_000) },
    undo_id: null,
  };
}

/** Open first, soonest due first; decided after, newest first (as the API). */
export function questionsOut(ctx: QuestionsCtx, db: QuestionsDb, prd?: string | null): Question[] {
  if (prd && prd !== QUESTIONS_PRD.slug && prd !== QUESTIONS_PRD.id) return [];
  const all = db.questions.map((q) => [q, out(ctx, q)] as const);
  const open = all.filter(([q]) => !decided(q)).sort(([a], [b]) => a.due - b.due || a.n - b.n);
  const done = all.filter(([q]) => decided(q)).sort(([a], [b]) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));
  return [...open, ...done].map(([, o]) => o);
}

/** The ids of the questions decided in this meeting (the Decisions page's meeting filter). */
export function questionsOfMeeting(db: QuestionsDb, meetingId: string): Set<string> {
  return new Set(db.questions.filter((q) => q.meeting_id === meetingId).map((q) => stableUuid(`simple-question/${q.n}`)));
}

/** The person's waiting questions and counts (SimpleDecisionsOut's new fields), of `shown` when given. */
export function questionsCounts(ctx: QuestionsCtx, db: QuestionsDb, shown?: Question[]) {
  const mine = (shown ?? questionsOut(ctx, db)).filter((q) => q.waiting_for_me);
  const approvals = RANK[ctx.me.role] >= RANK.approver ? 1 : 0;
  return {
    mine,
    waiting_count: mine.length,
    late_count: mine.filter((q) => q.late).length,
    approvals_waiting: approvals,
    approvals_example: approvals ? "D-30 Approve the baseline check" : null,
  };
}

/** The decided questions taken outside meetings, as the Decisions page's "Outside meetings" rows (with their code and answer). */
export function decidedOutsideRows(ctx: QuestionsCtx, db: QuestionsDb, shown: Question[]): Schemas["SimpleDecisionRow"][] {
  const ids = new Set(shown.map((q) => q.id));
  return db.questions
    .filter((q) => decided(q) && !q.meeting_id && ids.has(stableUuid(`simple-question/${q.n}`)))
    .map((q) => {
      const o = out(ctx, q);
      return {
        id: o.id, number: o.number, title: o.title, origin: "prd", status: "decided", approver: q.decider ? ref(ctx, q.decider) : null,
        decided_at: o.decided_at ?? null, created_at: o.decided_at ?? iso(todayStart()), subjects: [{ kind: "document", id: QUESTIONS_PRD.id }],
        code: o.code, chosen: o.chosen,
      };
    })
    .sort((a, b) => b.number - a.number);
}

/**
 * A review meeting's agenda (questions.due_for): the open questions blocking the milestone the
 * soonest one blocks, and those decided in this meeting (they stay, with Undo for who decided
 * them while it runs); soonest first.
 */
export function agendaOut(ctx: QuestionsCtx, db: QuestionsDb, meeting: { id: string; session_id: string; live: boolean }): Question[] {
  const all = questionsOut(ctx, db);
  const open = all.filter((q) => q.status === "proposed");
  const ms = open.find((q) => q.blocks?.milestone)?.blocks?.milestone ?? null;
  const here = new Set(db.questions.filter((q) => decided(q) && q.meeting_id === meeting.id).map((q) => stableUuid(`simple-question/${q.n}`)));
  const done = all
    .filter((q) => here.has(q.id))
    .map((q) => {
      const c = meeting.live
        ? db.changes.find(
            (x) => x.change.session_id === meeting.session_id && x.change.op === "decide_question" && x.change.status === "applied" && !x.change.undone && x.change.by === ctx.me.id && x.change.target.decision_id === q.id,
          )
        : undefined;
      return { ...q, undo_id: c?.change.id ?? null };
    });
  return [...open.filter((q) => !ms || q.blocks?.milestone === ms), ...done].sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || a.number - b.number);
}

/** GET /v1/simple/decisions/waiting: `others` is the decision log's judgement calls waiting for me. */
export function waitingOut(ctx: QuestionsCtx, db: QuestionsDb, others: number): Schemas["SimpleDecisionsWaitingOut"] {
  const c = questionsCounts(ctx, db);
  return { count: c.waiting_count + others, late: c.late_count, questions: c.mine, others, approvals_waiting: c.approvals_waiting };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  return ((await req.clone().json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/**
 * POST /v1/simple/changes with op decide_question or name_decider, and the undo of one of
 * them; null for every other change (the other mocks answer). `inMeeting` records a decision
 * taken with a live meeting's session_id in its minutes (false: no such live meeting).
 */
export async function routeQuestionChanges(
  ctx: QuestionsCtx,
  db: QuestionsDb,
  req: Request,
  p: string[],
  inMeeting: (sessionId: string, title: string) => string | false | "ended",
): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "changes" || req.method !== "POST") return null;
  if (p.length === 5 && p[4] === "undo") {
    const held = db.changes.find((c) => c.change.id === p[3]);
    if (!held) return null;
    if (held.change.by !== ctx.me.id && ctx.me.role !== "owner") return json(403, { detail: "Only who made it undoes it" });
    if (held.change.status !== "applied" || held.change.undone) return json(409, { detail: "Already undone" });
    const at = db.questions.findIndex((q) => q.n === held.was.n);
    db.questions[at] = structuredClone(held.was);
    held.change.undone = true;
    held.change.can_undo = false;
    const undo: Change = { ...held.change, id: crypto.randomUUID(), status: "undone", undoes_id: held.change.id, undone: false, at: iso(mockNowMs()) };
    return json(200, { change: undo, flags: [] });
  }
  if (p.length !== 3) return null;
  const b = await readBody(req);
  if (b.op !== "decide_question" && b.op !== "name_decider") return null;
  if (RANK[ctx.me.role] < RANK.commenter) return json(403, { detail: "Requires the commenter role" });
  const target = (b.target ?? {}) as Record<string, unknown>;
  const after = (b.after ?? {}) as Record<string, unknown>;
  const q = db.questions.find((x) => stableUuid(`simple-question/${x.n}`) === target.decision_id);
  if (!q) return json(404, { detail: "No such question" });
  if (decided(q)) return json(409, { detail: "This question is decided already" });
  const can = canOf(ctx, q);
  let answer = "";
  if (b.op === "decide_question") {
    if (after.option === "recommended") {
      if (!q.recommendation) return json(422, { detail: "The PRD recommends nothing for this question yet" });
      answer = q.recommendation;
    } else if (typeof after.option === "string") {
      const alt = out(ctx, q).alternatives.find((a) => a.key === after.option);
      if (!alt) return json(422, { detail: "No such answer" });
      answer = alt.label;
    } else if (typeof after.answer === "string" && after.answer.trim()) answer = after.answer.trim().slice(0, 500);
    else return json(422, { detail: "Choose an answer" });
  } else {
    if (!ctx.members.some((m) => m.id === after.decider_id)) return json(422, { detail: "Not a member" });
  }
  const applies = b.op === "decide_question" ? can.decide : can.name_decider;
  const was = structuredClone(q);
  const routed = applies ? [] : q.decider ? [q.decider] : owners(ctx).slice(0, 1);
  const change: Change = {
    id: crypto.randomUUID(), session_id: typeof b.session_id === "string" ? b.session_id : null, document_id: QUESTIONS_PRD.id, draft_ids: [],
    op: b.op, target: { decision_id: target.decision_id }, before: (b.before ?? {}) as Record<string, unknown>, after,
    status: applies ? "applied" : "proposed", by: ctx.me.id, by_name: nameOf(ctx, ctx.me.id), at: iso(mockNowMs()),
    decided_by: applies ? ctx.me.id : null, decided_at: applies ? iso(mockNowMs()) : null, reason: null, decision_reason: null,
    routed_to: routed, undoes_id: null, undone: false, can_decide: false, can_undo: applies,
  };
  let meetingId: string | null = null;
  if (change.session_id) {
    const words = b.op === "decide_question" ? `Q${q.n} ${q.title}: ${answer}` : `Q${q.n} ${q.title}: ${nameOf(ctx, String(after.decider_id))} decides`;
    const ok = inMeeting(change.session_id, applies ? `Decided ${words}` : `Proposed: ${words}`);
    if (ok === "ended") return json(409, { detail: "This meeting has ended" });
    if (ok) meetingId = ok;
  }
  if (applies) {
    if (b.op === "decide_question") {
      q.chosen = after.option === "recommended" ? "recommended" : answer;
      q.decided_by = ctx.me.id;
      q.decided_at = iso(mockNowMs());
      q.pending = null;
      q.meeting_id = meetingId;
    } else q.decider = String(after.decider_id);
  } else if (b.op === "decide_question") q.pending = { change_id: change.id, by: ctx.me.id, answer };
  db.changes.push({ change, was });
  return json(201, { change, flags: [] });
}
