/**
 * Simple S8 (#723): review meetings and the Decisions page, as api/oracle/simple/meetings.py
 * serves them: GET/POST /v1/simple/meetings, .../options, .../{id} with join, rules,
 * comments, approve, end, minutes and send, and GET /v1/simple/decisions. Changes posted to
 * /v1/simple/changes (and accept/decline) with a meeting's session_id become meeting
 * decisions (withMeeting). All data is invented.
 *
 * Who (the owner's picks): owners and the PRD's decider start a meeting (others: 403 and
 * can_start false, with the starters' names); the presenter sets the change mode and who is
 * absent; the decider (or an owner) approves: present required reviewers approve with
 * them, absent ones leave the draft waiting; the presenter, the decider or an owner ends it
 * and sends the minutes. Guided setup's decider is Dana Decider when the company has her
 * (the "simple-deciders" scenario); its required reviewer is the approver.
 *
 * Delivery: email is available unless localStorage MOCK_MEETINGS_KEY holds "no-email";
 * Slack is connected (to #product-reviews) when it holds "slack".
 */
import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { stableUuid } from "./ids";
import { seedSimpleProposal } from "./simple-changes";
import type { OnePagerDb } from "./simple-one-pager";
import { roadmapOut, type SimpleDb } from "./simple-roadmap";

export const MOCK_MEETINGS_KEY = "po-mock-simple-meetings";

type Role = Schemas["Me"]["role"];
type Ref = Schemas["SimplePersonRef"];
type Minutes = Schemas["SimpleMinutes"];
type Delivery = Schemas["SimpleDelivery"];
type Change = Schemas["SimpleChangeOut"];

export interface MeetingsCtx {
  me: { id: string; role: Role };
  members: { id: string; name: string; role: Role; email: string }[];
  roadmap: SimpleDb;
  onePager: OnePagerDb;
}

interface Meeting {
  id: string;
  title: string;
  prd: string;
  origin: Schemas["SimpleMeetingIn"]["origin"] & string;
  occurrence_id: string | null;
  session_id: string;
  presenter_id: string;
  attendee_ids: string[];
  absent_ids: string[];
  change_mode: "everyone" | "presenter" | "named";
  change_people: string[];
  length_min: number;
  status: "live" | "ended";
  started_at: string;
  ended_at: string | null;
  ended_by: string | null;
  minutes: Minutes | null;
  minutes_state: "drafting" | "ready" | "sent" | null;
  delivery: Delivery | null;
  sent_at: string | null;
  approved: { at: string; waiting_on: string[] } | null;
}

interface Decision {
  id: string;
  number: number;
  title: string;
  origin: string;
  status: "decided" | "proposed";
  approver_id: string | null;
  at: string;
  subjects: { kind: string; id: string; ref?: string }[];
  meeting_id: string | null;
  change_ids: string[];
}

interface Occurrence {
  id: string;
  ritual_title: string;
  due_at: string;
  ends_at: string;
  length_min: number;
  attendee_ids: string[];
}

export interface MeetingsDb {
  meetings: Meeting[];
  decisions: Decision[];
  occurrences: Occurrence[];
  inbox_seen: Record<string, string>;
}

interface Prd {
  slug: string;
  title: string;
  id: string;
  /** Every id the PRD goes by in the mock (the one-pager's, the roadmap's). */
  ids: string[];
  decider: string | null;
  reviewers: string[];
}

const iso = (t: number) => new Date(t).toISOString();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

function flags(): string[] {
  try {
    return (localStorage.getItem(MOCK_MEETINGS_KEY) ?? "").split(",");
  } catch {
    return [];
  }
}
const slackState = (): Schemas["SimpleSlackState"] => (flags().includes("slack") ? { connected: true, channel: "#product-reviews" } : { connected: false, channel: null });
const emailAvailable = () => !flags().includes("no-email");

function prds(ctx: MeetingsCtx): Prd[] {
  const dana = ctx.members.find((m) => m.email === "dana.decider@example.com");
  const approver = ctx.members.find((m) => m.email === "approver@example.com");
  return [
    { slug: "guided-setup", title: "Guided setup", id: ctx.onePager.doc.id, ids: [ctx.onePager.doc.id, stableUuid("simple-prd/onboarding-roadmap")], decider: dana?.id ?? null, reviewers: approver ? [approver.id] : [] },
    { slug: "usage-alerts", title: "Usage alerts", id: stableUuid("simple-prd/alerts-roadmap"), ids: [stableUuid("simple-prd/alerts-roadmap")], decider: null, reviewers: [] },
  ];
}

const owners = (ctx: MeetingsCtx) => ctx.members.filter((m) => m.role === "owner").map((m) => m.id);
const nameOf = (ctx: MeetingsCtx, id: string) => ctx.members.find((m) => m.id === id)?.name ?? "someone";
const ref = (ctx: MeetingsCtx, id: string): Ref => ({ id, name: nameOf(ctx, id) });
const docRef = (p: Prd) => ({ id: p.id, slug: p.slug, title: p.title });

function items(ctx: MeetingsCtx) {
  return roadmapOut(ctx.roadmap, "owner", new URLSearchParams())?.items ?? [];
}

/** Seeds on first use: a scheduled review, one past meeting whose minutes were sent, and
 * decisions outside meetings; a commenter's proposal on Guided setup's roadmap. */
export function ensureMeetings(holder: { simple_meetings?: MeetingsDb }, ctx: MeetingsCtx): MeetingsDb {
  if (holder.simple_meetings) return holder.simple_meetings;
  const now = mockNowMs();
  const owner = owners(ctx)[0];
  const approver = ctx.members.find((m) => m.email === "approver@example.com")?.id;
  const commenter = ctx.members.find((m) => m.email === "commenter@example.com");
  const people = [owner, approver, commenter?.id].filter((x): x is string => !!x);
  const all = items(ctx);
  const item = (key: string) => all.find((i) => i.key === key);
  const alerts = prds(ctx)[1];
  const setup = prds(ctx)[0];
  const past = stableUuid("simple-meeting/past-alerts");
  const day = 86_400_000;
  const startedAt = iso(now - 7 * day + 3 * 3_600_000);
  const digest = item("alert-digest");
  const checklist = item("setup-checklist");
  const d = (n: number, title: string, extra: Partial<Decision>): Decision => ({
    id: stableUuid(`simple-meeting-decision/${n}`), number: n, title, origin: "manual", status: "decided", approver_id: owner ?? null,
    at: iso(now - (10 - n) * day), subjects: [], meeting_id: null, change_ids: [], ...extra,
  });
  const db: MeetingsDb = {
    occurrences: [{
      id: stableUuid("simple-occurrence/weekly-review"), ritual_title: "Weekly product review",
      due_at: iso(now + day + 3 * 3_600_000), ends_at: iso(now + day + 4 * 3_600_000), length_min: 60, attendee_ids: people,
    }],
    decisions: [
      d(1, "Start guided setup with the checklist", { subjects: [{ kind: "document", id: setup.id }, ...(checklist ? [{ kind: "roadmap_item", id: checklist.id, ref: checklist.key }] : [])] }),
      d(2, "Keep the free plan's alert limit at three", { subjects: [{ kind: "document", id: alerts.id }] }),
      d(3, "Should muted teams still get the weekly digest?", { origin: "oracle", status: "proposed", approver_id: null, subjects: [{ kind: "document", id: alerts.id }] }),
      d(4, `Moved ${digest?.title ?? "Alert digest"}`, { origin: "meeting", meeting_id: past, at: iso(Date.parse(startedAt) + 20 * 60_000), subjects: [...(digest ? [{ kind: "roadmap_item", id: digest.id, ref: digest.key }] : []), { kind: "document", id: alerts.id }] }),
      d(5, "Comment: keep quiet hours on by default", { origin: "meeting", meeting_id: past, at: iso(Date.parse(startedAt) + 35 * 60_000), subjects: [{ kind: "document", id: alerts.id }] }),
    ],
    meetings: [{
      id: past, title: "Review: Usage alerts", prd: "usage-alerts", origin: "one_pager", occurrence_id: null, session_id: stableUuid("simple-meeting-session/past"),
      presenter_id: owner, attendee_ids: people, absent_ids: [], change_mode: "everyone", change_people: [], length_min: 60, status: "ended",
      started_at: startedAt, ended_at: iso(Date.parse(startedAt) + 50 * 60_000), ended_by: owner,
      minutes: {
        summary: `2 decisions in Review: Usage alerts: Moved ${digest?.title ?? "Alert digest"}; Comment: keep quiet hours on by default.`,
        open_questions: ["D-3: Should muted teams still get the weekly digest?"],
        action_items: commenter ? [{ title: "Draft the quiet hours copy", owner_id: commenter.id, owner_name: nameOf(ctx, commenter.id), due_date: iso(now + 7 * day).slice(0, 10) }] : [],
        waits: [{ what: "Usage alerts: the working draft is not approved yet", on: [] }],
        written_by: "oracle",
      },
      minutes_state: "sent", delivery: { decisions: true, inbox: true, email: true, email_status: "sent", slack: false, slack_status: null, slack_channel: null },
      sent_at: iso(Date.parse(startedAt) + 55 * 60_000), approved: null,
    }],
    inbox_seen: {},
  };
  if (checklist) (ctx.roadmap.decided_in ??= {})[checklist.id] = [{ id: db.decisions[0].id, number: 1, title: db.decisions[0].title }];
  if (digest) (ctx.roadmap.decided_in ??= {})[digest.id] = [{ id: db.decisions[3].id, number: 4, title: db.decisions[3].title }];
  if (commenter && !(ctx.roadmap.changes ?? []).some((c) => c.status === "proposed" && c.target.item_id === item("setup-ideas")?.id)) {
    const roles = Object.fromEntries(ctx.members.map((m) => [m.id, m.role]));
    seedSimpleProposal(ctx.roadmap, { id: commenter.id, name: commenter.name, owners: owners(ctx), roles }, "change_horizon", "setup-ideas", { horizon: "next" }, { horizon: "now" }, iso(now - 3_600_000), "Invites matter in week one");
  }
  holder.simple_meetings = db;
  return db;
}

function mayStart(ctx: MeetingsCtx, p: Prd): boolean {
  return ctx.me.role === "owner" || ctx.me.id === p.decider;
}

function mayChange(m: Meeting, id: string): boolean {
  if (m.status === "ended") return false;
  if (id === m.presenter_id) return true;
  if (m.change_mode === "everyone") return m.attendee_ids.includes(id);
  if (m.change_mode === "named") return m.change_people.includes(id);
  return false;
}

function presenterOrDecider(ctx: MeetingsCtx, m: Meeting, p: Prd): boolean {
  return ctx.me.id === m.presenter_id || ctx.me.id === p.decider || ctx.me.role === "owner";
}

function prdItems(ctx: MeetingsCtx, p: Prd) {
  return items(ctx).filter((i) => i.prd && (i.prd.slug === p.slug || p.ids.includes(i.prd.id)));
}

function attendees(ctx: MeetingsCtx, m: Meeting, p: Prd): Schemas["SimpleAttendee"][] {
  return m.attendee_ids.map((i) => {
    const roles: Schemas["SimpleAttendee"]["roles"] = [];
    if (i === m.presenter_id) roles.push("presenter");
    if (i === p.decider) roles.push("decider");
    if (p.reviewers.includes(i)) roles.push("reviewer");
    return { id: i, name: nameOf(ctx, i), roles, present: !m.absent_ids.includes(i) };
  });
}

function brief(ctx: MeetingsCtx, db: MeetingsDb, m: Meeting): Schemas["SimpleMeetingBrief"] {
  const p = prds(ctx).find((x) => x.slug === m.prd)!;
  return {
    id: m.id, title: m.title, prd: docRef(p), origin: m.origin, status: m.status, presenter: ref(ctx, m.presenter_id),
    attendees: attendees(ctx, m, p), length_min: m.length_min, started_at: m.started_at, ended_at: m.ended_at,
    decisions: db.decisions.filter((d) => d.meeting_id === m.id).length, minutes_state: m.minutes_state,
    summary: m.minutes_state === "sent" ? (m.minutes?.summary ?? null) : null,
  };
}

const newestFirst = (a: Decision, b: Decision) => (a.at === b.at ? b.number - a.number : a.at < b.at ? 1 : -1);

function openDecisions(ctx: MeetingsCtx, db: MeetingsDb, p: Prd): Schemas["SimpleOpenDecision"][] {
  const ids = new Set([...p.ids, ...prdItems(ctx, p).map((i) => i.id)]);
  return db.decisions
    .filter((d) => d.status === "proposed" && d.subjects.some((s) => ids.has(s.id)))
    .sort((a, b) => b.number - a.number)
    .map((d) => ({ id: d.id, number: d.number, title: d.title }));
}

function sees(ctx: MeetingsCtx, c: Change): boolean {
  return c.by === ctx.me.id || ctx.me.role === "owner" || c.routed_to.includes(ctx.me.id);
}

function bare(ctx: MeetingsCtx, c: Change): Change {
  const { id, session_id, document_id, draft_ids, op, target, before, after, status, by, by_name, at, decided_by, decided_at, reason, decision_reason, routed_to, undoes_id, undone } = c;
  return {
    id, session_id, document_id, draft_ids, op, target, before, after, status, by, by_name, at, decided_by, decided_at, reason, decision_reason, routed_to, undoes_id, undone,
    can_decide: status === "proposed" && (ctx.me.role === "owner" || routed_to.includes(ctx.me.id)), can_undo: false,
  };
}

function proposals(ctx: MeetingsCtx, p: Prd): Change[] {
  const ids = new Set(prdItems(ctx, p).map((i) => i.id));
  const roadmap = (ctx.roadmap.changes ?? []).filter((c) => c.status === "proposed" && ids.has(String(c.target.item_id)));
  const lines = p.slug === ctx.onePager.doc.slug ? ctx.onePager.changes.filter((c) => c.status === "proposed") : [];
  return [...roadmap, ...lines].filter((c) => sees(ctx, c)).sort((a, b) => (a.at < b.at ? -1 : 1)).map((c) => bare(ctx, c));
}

function meetingDrafts(ctx: MeetingsCtx, db: MeetingsDb, m: Meeting, p: Prd): Schemas["SimpleDraftOut"][] {
  const made = db.decisions.filter((d) => d.meeting_id === m.id && d.change_ids.length);
  if (!made.length) return [];
  return [{
    id: stableUuid(`simple-meeting-draft/${m.id}`), document: docRef(p), status: m.approved ? (m.approved.waiting_on.length ? "submitted" : "approved") : "working",
    base_version: p.slug === ctx.onePager.doc.slug ? ctx.onePager.version : 1, version: null, created_by: m.presenter_id, created_at: made[made.length - 1].at,
    participant_ids: [...new Set(made.map((d) => d.approver_id).filter((x): x is string => !!x))], changes: made.length,
    submitted_at: m.approved?.at ?? null, submitted_by: m.approved ? m.presenter_id : null, decider_approved: !!m.approved,
    waiting_on: m.approved?.waiting_on ?? [], approved_at: m.approved && !m.approved.waiting_on.length ? m.approved.at : null, blocked_by: [],
    can_submit: false, can_resume: false, can_approve: false, change_log: [], can_withdraw: false,
  }];
}

function one(ctx: MeetingsCtx, db: MeetingsDb, m: Meeting): Schemas["SimpleMeetingOut"] {
  const p = prds(ctx).find((x) => x.slug === m.prd)!;
  const deciderOrOwner = ctx.me.id === p.decider || ctx.me.role === "owner";
  return {
    ...brief(ctx, db, m),
    session_id: m.session_id,
    occurrence_id: m.occurrence_id,
    change_mode: m.change_mode,
    change_people: m.change_people.map((i) => ref(ctx, i)),
    roadmap_ids: [...new Set(prdItems(ctx, p).map((i) => i.roadmap.id))].sort(),
    meeting_decisions: db.decisions.filter((d) => d.meeting_id === m.id).sort(newestFirst).map((d) => ({
      id: d.id, number: d.number, title: d.title, approver: ref(ctx, d.approver_id ?? ""), at: d.at, subjects: d.subjects, change_ids: d.change_ids,
    })),
    open_decisions: openDecisions(ctx, db, p),
    pending_proposals: proposals(ctx, p),
    drafts: meetingDrafts(ctx, db, m, p),
    minutes: m.minutes,
    delivery: m.delivery,
    slack: slackState(),
    email_available: emailAvailable(),
    can: {
      change: mayChange(m, ctx.me.id) && RANK[ctx.me.role] >= RANK.commenter,
      set_rules: m.status === "live" && ctx.me.id === m.presenter_id,
      approve: m.status === "live" && deciderOrOwner,
      end: presenterOrDecider(ctx, m, p) && m.minutes_state !== "sent",
    },
    not_approved: [],
  };
}

function upcoming(ctx: MeetingsCtx, db: MeetingsDb, only?: string): Schemas["SimpleUpcomingMeeting"][] {
  const now = mockNowMs();
  return db.occurrences
    .filter((o) => (only ? o.id === only : Date.parse(o.ends_at) >= now))
    .map((o) => ({
      occurrence_id: o.id, ritual_title: o.ritual_title, due_at: o.due_at, ends_at: o.ends_at, length_min: o.length_min,
      attendees: o.attendee_ids.map((i) => ref(ctx, i)), meeting_id: db.meetings.find((m) => m.occurrence_id === o.id)?.id ?? null,
    }));
}

function record(db: MeetingsDb, ctx: MeetingsCtx, m: Meeting, title: string, subjects: Decision["subjects"], changeIds: string[]): Decision {
  const number = Math.max(0, ...db.decisions.map((d) => d.number)) + 1;
  const d: Decision = {
    id: crypto.randomUUID(), number, title, origin: "meeting", status: "decided", approver_id: ctx.me.id, at: iso(Math.max(mockNowMs(), ...db.decisions.map((x) => Date.parse(x.at) + 1))),
    subjects, meeting_id: m.id, change_ids: changeIds,
  };
  db.decisions.push(d);
  // The items and lines it names link to it (decided_in, a line's decisions), newest first.
  for (const s of subjects) {
    const row = { id: d.id, number: d.number, title: d.title };
    if (s.kind === "roadmap_item") ((ctx.roadmap.decided_in ??= {})[s.id] ??= []).unshift(row);
    if (s.kind === "section" && s.ref?.startsWith("line:")) ((ctx.onePager.decisions ??= {})[s.ref.slice(5)] ??= []).unshift(row);
  }
  return d;
}

const OP_WORDS: Record<string, string> = {
  move_dates: "New dates for", accept_date_suggestion: "Accepted Oracle's dates for", change_horizon: "Moved", reorder: "Reordered", cut: "Cut",
  restore: "Restored", edit_title: "Renamed", edit_outcome: "New outcome for", accept_risk: "Accepted a risk on", confirm_item: "Confirmed", edit_line: "New wording for",
};

/** A change in words and the subjects it names (as meetings.describe). */
function describe(ctx: MeetingsCtx, c: Change): [string, Decision["subjects"]] {
  const subjects: Decision["subjects"] = [];
  let name = "";
  const item = items(ctx).find((i) => i.id === c.target.item_id);
  if (item) {
    name = item.title;
    subjects.push({ kind: "roadmap_item", id: item.id, ref: item.key });
  }
  if (c.op === "edit_line") {
    name = `a line of ${ctx.onePager.doc.title}: “${String(c.after.line ?? "").slice(0, 120)}”`;
    subjects.push({ kind: "section", id: ctx.onePager.doc.id, ref: `line:${String(c.target.line_id)}` });
  } else if (!name) name = String(c.after.title ?? c.target.title ?? "");
  const words = OP_WORDS[c.op] ?? c.op.replace(/_/g, " ");
  return [`${words} ${name}`.trim(), subjects];
}

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.clone().json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/**
 * The change engine through a meeting: a change, accept or decline with a meeting's
 * session_id is checked against the meeting's rules, made by `run` (the one-pager and
 * roadmap mocks, in the caller's own session) and recorded as a meeting decision.
 */
export async function withMeeting(db: MeetingsDb, ctx: MeetingsCtx, req: Request, p: string[], run: (r: Request) => Promise<Response | null>): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "changes" || req.method !== "POST") return null;
  const isCreate = p.length === 3;
  const verb = p[4] === "accept" ? "Accepted" : p[4] === "decline" ? "Declined" : null;
  if (!isCreate && !verb) return null;
  const b = await body(req);
  const m = b.session_id ? db.meetings.find((x) => x.session_id === b.session_id) : undefined;
  if (!m) return null;
  if (m.status !== "live") return json(409, { detail: "This meeting has ended" });
  if (isCreate && !mayChange(m, ctx.me.id)) return json(403, { detail: "The presenter has not let you change things in this meeting" });
  const rest = { ...b };
  delete rest.session_id;
  const inner = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(rest) });
  const res = await run(inner);
  if (!res || !res.ok) return res;
  const out = (await res.clone().json()) as Schemas["SimpleChangeResult"];
  const c = out.change;
  const [words, subjects] = describe(ctx, c);
  const title = verb ? `${verb}: ${words}` : c.status === "proposed" ? `Proposed: ${words}` : words;
  const prd = prds(ctx).find((x) => x.slug === m.prd)!;
  record(db, ctx, m, title, [...subjects, { kind: "document", id: prd.id }], [c.id]);
  const line = ctx.onePager.changes.find((x) => x.id === c.id);
  if (line) Object.assign(line, { in_meeting: true, meeting_title: m.title });
  return res;
}

function extract(ctx: MeetingsCtx, db: MeetingsDb, m: Meeting): Minutes {
  const p = prds(ctx).find((x) => x.slug === m.prd)!;
  const titles = db.decisions.filter((d) => d.meeting_id === m.id).sort((a, b) => -newestFirst(a, b)).map((d) => d.title);
  const summary = titles.length
    ? `${titles.length} ${titles.length === 1 ? "decision" : "decisions"} in ${m.title}: ${titles.slice(0, 6).join("; ")}${titles.length > 6 ? "…" : "."}`
    : `${m.title}: no decision was taken.`;
  const waits: Schemas["SimpleWait"][] = [];
  for (const d of meetingDrafts(ctx, db, m, p)) {
    if (d.status === "submitted" && d.waiting_on.length) waits.push({ what: `Publishing ${d.document.title}: their approval`, on: d.waiting_on.map((i) => ref(ctx, i)) });
    else if (d.status === "working") waits.push({ what: `${d.document.title}: the working draft is not approved yet`, on: [] });
  }
  const made = new Set(db.decisions.filter((d) => d.meeting_id === m.id).flatMap((d) => d.change_ids));
  for (const c of [...(ctx.roadmap.changes ?? []), ...ctx.onePager.changes]) {
    if (made.has(c.id) && c.status === "proposed") waits.push({ what: `Proposal: ${describe(ctx, c)[0]}`, on: c.routed_to.map((i) => ref(ctx, i)) });
  }
  return {
    summary: summary.slice(0, 4000),
    open_questions: openDecisions(ctx, db, p).map((d) => `D-${d.number}: ${d.title}`),
    action_items: [],
    waits,
    written_by: "extract",
  };
}

/** Inbox rows (meetings.inbox_rows): minutes sent to me as an attendee. */
export function meetingInboxRows(db: MeetingsDb | undefined, me: string, seen: string | null): Schemas["InboxSimpleMinutes"][] {
  return (db?.meetings ?? [])
    .filter((m) => m.minutes_state === "sent" && m.attendee_ids.includes(me))
    .sort((a, b) => ((a.sent_at ?? "") < (b.sent_at ?? "") ? 1 : -1))
    .map((m) => ({
      meeting_id: m.id, title: m.title, ended_at: m.ended_at, decisions: db!.decisions.filter((d) => d.meeting_id === m.id).length,
      state: !seen || (m.sent_at ?? "") > seen ? "new" : "open",
    }));
}

function row(ctx: MeetingsCtx, d: Decision): Schemas["SimpleDecisionRow"] {
  return {
    id: d.id, number: d.number, title: d.title, origin: d.origin, status: d.status, approver: d.approver_id ? ref(ctx, d.approver_id) : null,
    decided_at: d.status === "decided" ? d.at : null, created_at: d.at, subjects: d.subjects,
  };
}

function decisionsPage(ctx: MeetingsCtx, db: MeetingsDb, q: URLSearchParams): Response {
  const all = items(ctx);
  const ps = prds(ctx);
  const goals = new Map(all.filter((i) => i.goal).map((i) => [i.goal!.key, i.goal!]));
  const prdQ = q.get("prd");
  const goalQ = q.get("goal");
  const meetingQ = q.get("meeting");
  const prd = prdQ ? ps.find((x) => x.slug === prdQ || x.id === prdQ) : undefined;
  if (prdQ && !prd) return json(404, { detail: "No such PRD" });
  const goal = goalQ ? [...goals.values()].find((g) => g.key === goalQ || g.id === goalQ) : undefined;
  if (goalQ && !goal) return json(404, { detail: "No such goal" });
  let match: Set<string> | null = null;
  if (prd || goal) {
    const entries = all.filter((i) => (!prd || (i.prd && (i.prd.slug === prd.slug || prd.ids.includes(i.prd.id)))) && (!goal || i.goal?.id === goal.id));
    match = new Set(entries.map((i) => i.id));
    if (prd) prd.ids.forEach((i) => match!.add(i));
    if (goal) match.add(goal.id);
  }
  const keep = (d: Decision) => !match || d.subjects.some((s) => match!.has(s.id));
  const ms = [...db.meetings].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  let shown = ms.filter((m) => !meetingQ || m.id === meetingQ);
  const of = (m: Meeting) => db.decisions.filter((d) => d.meeting_id === m.id).sort(newestFirst);
  if (prd) shown = shown.filter((m) => m.prd === prd.slug || of(m).some(keep));
  else if (match) shown = shown.filter((m) => of(m).some(keep));
  const others = meetingQ ? [] : db.decisions.filter((d) => !d.meeting_id && keep(d)).sort((a, b) => b.number - a.number);
  const out: Schemas["SimpleDecisionsOut"] = {
    meetings: shown.map((m) => {
      const whole = !!prd && !goal && m.prd === prd.slug;
      return { meeting: brief(ctx, db, m), minutes: m.minutes, decisions: of(m).filter((d) => whole || keep(d)).map((d) => row(ctx, d)) };
    }),
    other: others.map((d) => row(ctx, d)),
    prds: [...ps].sort((a, b) => a.title.localeCompare(b.title)).map((x) => ({ id: x.slug, title: x.title })),
    goals: [...goals.values()].sort((a, b) => a.key.localeCompare(b.key)).map((g) => ({ id: g.key, title: g.title })),
    meeting_options: ms.map((m) => ({ id: m.id, title: m.title })),
  };
  return json(200, out);
}

/** Handles /v1/simple/meetings… and /v1/simple/decisions; null for other routes. */
export async function routeSimpleMeetings(db: MeetingsDb, ctx: MeetingsCtx, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "simple" || (p[2] !== "meetings" && p[2] !== "decisions")) return null;
  const method = req.method;
  if (p[2] === "decisions") return method === "GET" ? decisionsPage(ctx, db, q) : null;
  const ps = prds(ctx);
  const now = iso(mockNowMs());
  if (method !== "GET" && RANK[ctx.me.role] < RANK.commenter) return json(403, { detail: "Requires the commenter role" });
  if (!p[3]) {
    if (method === "GET") {
      const all = [...db.meetings].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).map((m) => brief(ctx, db, m));
      return json(200, { upcoming: upcoming(ctx, db), live: all.filter((m) => m.status === "live"), past: all.filter((m) => m.status === "ended") });
    }
    if (method !== "POST") return null;
    const b = (await body(req)) as Partial<Schemas["SimpleMeetingIn"]>;
    const prd = ps.find((x) => x.slug === b.prd || x.id === b.prd);
    if (!prd) return json(404, { detail: "No such PRD" });
    if (!mayStart(ctx, prd)) return json(403, { detail: "Only an owner or the PRD's decider starts its review meeting" });
    const members = new Set(ctx.members.map((m) => m.id));
    const att = [...new Set([ctx.me.id, ...(b.attendee_ids ?? [])])];
    if (att.some((i) => !members.has(i))) return json(422, { detail: "Not active members" });
    const mode = b.change_mode ?? "everyone";
    let people = [...new Set(b.change_people ?? [])];
    if (mode === "named") {
      if (people.length < 1 || people.length > 2 || people.some((x) => !att.includes(x))) return json(422, { detail: "Name one or two people in the meeting who may change things" });
    } else people = [];
    const length = b.length_min ?? 60;
    if (length < 5 || length > 240) return json(422, { detail: "length_min: 5 to 240" });
    const occ = b.occurrence_id ? db.occurrences.find((o) => o.id === b.occurrence_id) : undefined;
    if (b.occurrence_id && !occ) return json(404, { detail: "No such scheduled review" });
    const title = (b.title ?? "").trim() || (occ ? `${occ.ritual_title}: ${prd.title}` : `Review: ${prd.title}`);
    const m: Meeting = {
      id: crypto.randomUUID(), title: title.slice(0, 200), prd: prd.slug, origin: occ ? "ritual" : (b.origin ?? "one_pager"), occurrence_id: occ?.id ?? null,
      session_id: crypto.randomUUID(), presenter_id: ctx.me.id, attendee_ids: att, absent_ids: [], change_mode: mode, change_people: people,
      length_min: length, status: "live", started_at: now, ended_at: null, ended_by: null, minutes: null, minutes_state: null, delivery: null, sent_at: null, approved: null,
    };
    db.meetings.push(m);
    return json(201, one(ctx, db, m));
  }
  if (p[3] === "options" && method === "GET") {
    const prdQ = q.get("prd");
    const list = prdQ ? ps.filter((x) => x.slug === prdQ || x.id === prdQ) : ps;
    if (prdQ && !list.length) return json(404, { detail: "No such PRD" });
    const occQ = q.get("occurrence");
    const occ = occQ ? upcoming(ctx, db, occQ)[0] : null;
    if (occQ && !occ) return json(404, { detail: "No such scheduled review" });
    const out: Schemas["SimpleStartOptions"] = {
      prds: list.map((x) => ({
        document: docRef(x), decider: x.decider ? ref(ctx, x.decider) : null, can_start: mayStart(ctx, x),
        starters: [...new Set([...(x.decider ? [x.decider] : []), ...owners(ctx)])].map((i) => ref(ctx, i)),
        default_attendee_ids: [...new Set([ctx.me.id, ...(x.decider ? [x.decider] : []), ...x.reviewers])],
      })),
      members: ctx.members.map((x) => ({ id: x.id, name: x.name })),
      length_min: occ?.length_min ?? 60,
      occurrence: occ,
    };
    return json(200, out);
  }
  const m = db.meetings.find((x) => x.id === p[3]);
  if (!m) return json(404, { detail: "No such meeting" });
  const prd = ps.find((x) => x.slug === m.prd)!;
  const ok = () => json(200, one(ctx, db, m));
  if (!p[4] && method === "GET") return ok();
  if (p[4] === "join" && method === "POST") {
    if (m.status !== "live") return json(409, { detail: "This meeting has ended" });
    if (!m.attendee_ids.includes(ctx.me.id)) m.attendee_ids.push(ctx.me.id);
    m.absent_ids = m.absent_ids.filter((i) => i !== ctx.me.id);
    return ok();
  }
  if (p[4] === "rules" && method === "PATCH") {
    if (ctx.me.id !== m.presenter_id) return json(403, { detail: "Only the presenter sets who may change things" });
    if (m.status !== "live") return json(409, { detail: "This meeting has ended" });
    const b = (await body(req)) as Schemas["SimpleMeetingRulesIn"];
    const mode = b.change_mode ?? m.change_mode;
    let people = [...new Set(b.change_people ?? m.change_people)];
    if (mode === "named") {
      if (people.length < 1 || people.length > 2 || people.some((x) => !m.attendee_ids.includes(x))) return json(422, { detail: "Name one or two people in the meeting who may change things" });
    } else people = [];
    if (b.absent_ids) {
      if (b.absent_ids.some((i) => !m.attendee_ids.includes(i) || i === m.presenter_id)) return json(422, { detail: "Only attendees other than the presenter are marked absent" });
      m.absent_ids = [...new Set(b.absent_ids)];
    }
    m.change_mode = mode;
    m.change_people = people;
    return ok();
  }
  if (p[4] === "comments" && method === "POST") {
    const b = (await body(req)) as Partial<Schemas["SimpleMeetingCommentIn"]>;
    const text = String(b.text ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (!text || text.length > 1000) return json(422, { detail: "text: 1 to 1000 characters" });
    if (!mayChange(m, ctx.me.id) && !m.attendee_ids.includes(ctx.me.id)) return json(403, { detail: "Join the meeting to comment in it" });
    if (m.status === "ended") return json(409, { detail: "This meeting has ended" });
    record(db, ctx, m, `Comment: ${text}`, [...((b.subjects ?? []) as Decision["subjects"]), { kind: "document", id: prd.id }], []);
    return json(201, one(ctx, db, m));
  }
  if (p[4] === "approve" && method === "POST") {
    if (m.status !== "live") return json(409, { detail: "This meeting has ended" });
    if (!(ctx.me.id === prd.decider || ctx.me.role === "owner")) return json(403, { detail: "Only the PRD's decider (or an owner) approves in the meeting" });
    if (!db.decisions.some((d) => d.meeting_id === m.id && d.change_ids.length)) return json(422, { detail: "Nothing to approve: no change was made in this meeting" });
    const present = m.attendee_ids.filter((i) => !m.absent_ids.includes(i));
    const waiting = prd.reviewers.filter((i) => i !== ctx.me.id && !present.includes(i));
    m.approved = { at: now, waiting_on: waiting };
    const wait = waiting.map((i) => nameOf(ctx, i)).join(", ");
    record(db, ctx, m, `Approved ${prd.title} (${waiting.length ? `publishes when ${wait} approves` : "published"})`, [{ kind: "document", id: prd.id }], []);
    if (prd.slug === ctx.onePager.doc.slug && waiting.length) ctx.onePager.approval = { approved_in: m.title, waiting_on: waiting.map((i) => ref(ctx, i)) };
    return ok();
  }
  if (p[4] === "end" && method === "POST") {
    if (!presenterOrDecider(ctx, m, prd)) return json(403, { detail: "Only the presenter, the PRD's decider or an owner ends it" });
    if (m.status === "ended") return json(409, { detail: "This meeting has ended already" });
    m.status = "ended";
    m.ended_at = now;
    m.ended_by = ctx.me.id;
    m.minutes = extract(ctx, db, m);
    m.minutes_state = "ready";
    return ok();
  }
  if (p[4] === "minutes" && method === "PUT") {
    if (!presenterOrDecider(ctx, m, prd)) return json(403, { detail: "Only the presenter, the PRD's decider or an owner edits them" });
    if (m.status !== "ended" || m.minutes_state === "sent") return json(409, { detail: "Minutes are edited after the meeting ends and before sending" });
    const b = (await body(req)) as Partial<Schemas["SimpleMinutesIn"]>;
    const members = new Set(ctx.members.map((x) => x.id));
    m.minutes = {
      summary: String(b.summary ?? "").trim(),
      open_questions: (b.open_questions ?? []).map((x) => x.trim()).filter(Boolean),
      action_items: (b.action_items ?? []).filter((a) => a.title?.trim()).map((a) => {
        const owner = a.owner_id && members.has(a.owner_id) ? a.owner_id : m.ended_by;
        return { title: a.title.trim(), owner_id: owner, owner_name: owner ? nameOf(ctx, owner) : null, due_date: a.due_date ?? null };
      }),
      waits: m.minutes?.waits ?? [],
      written_by: "edited",
    };
    if (m.minutes_state === "drafting") m.minutes_state = "ready";
    return ok();
  }
  if (p[4] === "send" && method === "POST") {
    if (!presenterOrDecider(ctx, m, prd)) return json(403, { detail: "Only the presenter, the PRD's decider or an owner sends them" });
    if (m.status !== "ended") return json(409, { detail: "End the meeting first" });
    if (m.minutes_state === "sent") return json(409, { detail: "The minutes were sent already" });
    const b = (await body(req)) as Partial<Schemas["SimpleSendIn"]>;
    const slack = slackState();
    if (b.slack && !(slack.connected && slack.channel)) return json(422, { detail: slack.connected ? "No Slack channel is set in Settings › Notifications" : "Slack is not connected" });
    m.minutes ??= extract(ctx, db, m);
    m.delivery = {
      decisions: true, inbox: true, email: !!b.email, email_status: b.email ? (emailAvailable() ? "queued" : "unavailable") : null,
      slack: !!b.slack, slack_status: b.slack ? "queued" : null, slack_channel: b.slack ? slack.channel : null,
    };
    m.minutes_state = "sent";
    m.sent_at = now;
    return ok();
  }
  return null;
}
