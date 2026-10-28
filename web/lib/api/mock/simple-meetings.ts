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
 *
 * The minutes job (production walk): ending a meeting answers at once unless the key holds
 * "minutes-failed" (the job fails: "failed", Draft again requeues it, which then answers) or
 * "minutes-slow" (still drafting past 2 minutes: "slow"), "minutes-later" (drafting, then
 * Oracle's minutes MINUTES_LATER_MS after End on the mock clock) or "minutes-later-failed"
 * (drafting, then failed); Send works in every state.
 *
 * "no-reviewers": Guided setup has no required reviewer (a PRD started from an empty skeleton).
 * Approve publishes only when nothing holds it: an absent required reviewer, or (with
 * "section-reviewer") the commenter named as the reviewer of Guided setup's required section
 * "What we will build" and absent, whom the draft then waits on too (drafts._section_people);
 * with "section-needs-reviewer" that section has nobody who may approve it and the draft's
 * blocked_by says so (drafts.held). The decision then reads "not yet published: …" in the
 * banner's words.
 *
 * Each decided flow is linked (meetings.decided_flows): a meeting decision on a draft item
 * names it with its flow, S10's (the priorities mock's bundles); "flow" in MOCK_MEETINGS_KEY
 * stands for S10 having drawn one for Team invite nudges. A scheduled review has at most one
 * meeting (409 naming it).
 */
import type { Schemas } from "@/lib/api/client";
import { plainFlow } from "./simple-visuals";
import { seedSimpleProposal } from "./simple-changes";
import { mockNowMs } from "./clock";
import { stableUuid } from "./ids";
import { nextOccurrence, type RitualsDb } from "./rituals";
import { publishOnePager, type OnePagerDb } from "./simple-one-pager";
import { roadmapOut, type SimpleDb } from "./simple-roadmap";

export const MOCK_MEETINGS_KEY = "po-mock-simple-meetings";
/** "minutes-later": the minutes job ends this long after End (the production walk: 14 s). */
export const MINUTES_LATER_MS = 20_000;

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
  /** The rituals (./rituals.ts): Meetings > Upcoming lists each active one's next review, as Home does. */
  rituals?: RitualsDb;
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
  /** The minutes job while drafting (meetings._minutes_job). */
  minutes_job?: "drafting" | "slow" | "failed" | null;
  /** "minutes-later": when (mock clock, ms) the job ends, and how. */
  minutes_due?: { at: number; outcome: "succeeded" | "failed" } | null;
  delivery: Delivery | null;
  sent_at: string | null;
  approved: { at: string; waiting_on: string[]; blocked_by?: string[] } | null;
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
  /** The roadmap items its changes touched (meetings.decided_flows reads them). */
  item_ids?: string[];
}

interface Occurrence {
  id: string;
  ritual_id: string;
  ritual_title: string;
  due_at: string;
  ends_at: string;
  length_min: number;
  /** Its pre-read is built (the rituals mock's "ready"). */
  ready?: boolean;
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
    { slug: "guided-setup", title: "Guided setup", id: ctx.onePager.doc.id, ids: [ctx.onePager.doc.id, stableUuid("simple-prd/onboarding-roadmap")], decider: dana?.id ?? null, reviewers: approver && !flags().includes("no-reviewers") ? [approver.id] : [] },
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
 * decisions outside meetings. */
/** A commenter's proposal on Team invite nudges for a starting meeting to decide (once, unless one already waits). */
function seedMeetingProposal(ctx: MeetingsCtx): void {
  const commenter = ctx.members.find((m) => m.email === "commenter@example.com");
  const item = items(ctx).find((i) => i.key === "setup-ideas");
  if (!commenter || !item || (ctx.roadmap.changes ?? []).some((c) => c.status === "proposed" && c.target.item_id === item.id)) return;
  const roles = Object.fromEntries(ctx.members.map((m) => [m.id, m.role]));
  seedSimpleProposal(ctx.roadmap, { id: commenter.id, name: commenter.name, owners: owners(ctx), roles }, "change_horizon", "setup-ideas", { horizon: "next" }, { horizon: "now" }, iso(mockNowMs() - 3_600_000), "Invites matter in week one");
}

export function ensureMeetings(holder: { simple_meetings?: MeetingsDb }, ctx: MeetingsCtx): MeetingsDb {
  if (holder.simple_meetings) return holder.simple_meetings;
  // A new company ("empty" scenario, as server.ts's MOCK_SCENARIO_KEY): no past meetings, decisions or seeded proposal.
  // Home and the rail read meetings too, so seeding here would fill every empty Home.
  if (typeof localStorage !== "undefined" && localStorage.getItem("po-mock-scenario") === "empty") {
    return (holder.simple_meetings = { meetings: [], decisions: [], occurrences: [], inbox_seen: {} });
  }
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
    // Made when a review starts from a ritual's next due time (the rituals mock's are listed too).
    occurrences: [],
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
  // The demo proposal a meeting decides is seeded when a meeting starts (seedMeetingProposal), not here: Home and the
  // rail read meetings on every page, and a proposal made by that read changed what the roadmap and Home showed.
  holder.simple_meetings = db;
  return db;
}

function mayStart(ctx: MeetingsCtx, p: Prd): boolean {
  return ctx.me.role === "owner" || ctx.me.id === p.decider;
}

/** meetings.may_start_ritual: owners and the ritual's owner start a ritual's review. */
function mayStartRitual(ctx: MeetingsCtx, ritualId: string): boolean {
  return ctx.me.role === "owner" || ctx.rituals?.rituals.find((r) => r.id === ritualId)?.owner_id === ctx.me.id;
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

/** The decider approved, and something still holds publishing (drafts.holds). */
const held = (m: Meeting) => !!m.approved && (m.approved.waiting_on.length > 0 || (m.approved.blocked_by ?? []).length > 0);

const people = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

function meetingDrafts(ctx: MeetingsCtx, db: MeetingsDb, m: Meeting, p: Prd): Schemas["SimpleDraftOut"][] {
  const made = db.decisions.filter((d) => d.meeting_id === m.id && d.change_ids.length);
  if (!made.length) return [];
  return [{
    id: stableUuid(`simple-meeting-draft/${m.id}`), document: docRef(p), status: m.approved ? (held(m) ? "submitted" : "approved") : "working",
    base_version: p.slug === ctx.onePager.doc.slug ? ctx.onePager.version : 1, version: null, created_by: m.presenter_id, created_at: made[made.length - 1].at,
    participant_ids: [...new Set(made.map((d) => d.approver_id).filter((x): x is string => !!x))], changes: made.length,
    submitted_at: m.approved?.at ?? null, submitted_by: m.approved ? m.presenter_id : null, decider_approved: !!m.approved,
    waiting_on: m.approved?.waiting_on ?? [], approved_at: m.approved && !held(m) ? m.approved.at : null, blocked_by: m.approved?.blocked_by ?? [],
    can_submit: false, can_resume: false, can_approve: false, change_log: [], can_withdraw: false,
  }];
}

/** A "minutes-later" job whose time came: it answers (Oracle's minutes) or fails. */
function settleLater(ctx: MeetingsCtx, db: MeetingsDb, m: Meeting) {
  if (!m.minutes_due || m.minutes_state !== "drafting" || mockNowMs() < m.minutes_due.at) return;
  if (m.minutes_due.outcome === "failed") m.minutes_job = "failed";
  else {
    m.minutes = { ...extract(ctx, db, m), summary: `Oracle's minutes of ${m.title}: ${db.decisions.filter((d) => d.meeting_id === m.id).length} decisions taken.`, written_by: "oracle" };
    m.minutes_state = "ready";
    m.minutes_job = null;
  }
  m.minutes_due = null;
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
      flow: decidedFlow(ctx, d),
    })),
    open_decisions: openDecisions(ctx, db, p),
    pending_proposals: proposals(ctx, p),
    drafts: meetingDrafts(ctx, db, m, p),
    waiting_people: [...new Set(meetingDrafts(ctx, db, m, p).flatMap((d) => d.waiting_on))].map((i) => ref(ctx, i)),
    minutes: m.minutes,
    minutes_job: m.status === "ended" && m.minutes_state === "drafting" ? (m.minutes_job ?? "drafting") : null,
    delivery: m.delivery,
    slack: slackState(),
    email_available: emailAvailable(),
    can: {
      change: mayChange(m, ctx.me.id) && RANK[ctx.me.role] >= RANK.commenter,
      set_rules: m.status === "live" && ctx.me.id === m.presenter_id,
      approve: m.status === "live" && deciderOrOwner,
      end: presenterOrDecider(ctx, m, p) && m.minutes_state !== "sent",
      redraft: m.status === "ended" && m.minutes_state === "drafting" && m.minutes_job === "failed" && presenterOrDecider(ctx, m, p),
    },
    not_approved: [],
  };
}

/**
 * Meetings > Upcoming, the one list Home's "Next review meeting" and the rail's Meetings count
 * read (meetings._upcoming): one row per active ritual, soonest first: its open occurrence, else its
 * next due time, however far ahead (no horizon), when no occurrence is made for it yet (occurrence_id null).
 */
function upcoming(ctx: MeetingsCtx, db: MeetingsDb, only?: string): Schemas["SimpleUpcomingMeeting"][] {
  const now = mockNowMs();
  const rituals = ctx.rituals?.rituals ?? [];
  const active = new Map(rituals.filter((r) => r.status === "active").map((r) => [r.id, r]));
  const made: Occurrence[] = [
    ...db.occurrences,
    ...(ctx.rituals?.occurrences ?? [])
      .filter((o) => (o.status === "scheduled" || o.status === "ready") && active.has(o.ritual_id))
      .map((o) => {
        const r = active.get(o.ritual_id)!;
        return { id: o.id, ritual_id: r.id, ritual_title: r.title, due_at: o.due_at, ends_at: o.ends_at ?? iso(Date.parse(o.due_at) + r.duration_min * 60_000), length_min: r.duration_min, attendee_ids: [r.owner_id, ...r.attendee_ids], ready: o.status === "ready" };
      }),
  ];
  // The walk: the ritual's real attendees add whoever was present at the last review held
  // from it, until its attendees are edited after that review (attendees_edited_at, as the
  // API: not the ritual's updated_at, which the scheduler moves).
  const ritualOf = new Map<string, string>([...db.occurrences, ...(ctx.rituals?.occurrences ?? [])].map((o) => [o.id, o.ritual_id]));
  const held = (ritualId: string): string[] => {
    const last = [...db.meetings].filter((m) => m.occurrence_id && ritualOf.get(m.occurrence_id) === ritualId).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (!last) return [];
    const edited = rituals.find((r) => r.id === ritualId)?.attendees_edited_at;
    if (edited && Date.parse(last.started_at) < Date.parse(edited)) return [];
    return last.attendee_ids.filter((i) => !last.absent_ids.includes(i));
  };
  const open = made
    .filter((o) => (only ? o.id === only : Date.parse(o.ends_at) >= now && (active.has(o.ritual_id) || !rituals.some((r) => r.id === o.ritual_id))))
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
    .filter((o, i, xs) => !!only || xs.findIndex((x) => x.ritual_id === o.ritual_id) === i);
  const rows: Schemas["SimpleUpcomingMeeting"][] = open.map((o) => ({
    occurrence_id: o.id, ritual_id: o.ritual_id, ritual_title: o.ritual_title, due_at: o.due_at, ends_at: o.ends_at, length_min: o.length_min,
    // As the API: the ritual's owner and attendees as they are now, not as the occurrence was made.
    attendees: [...new Set([...(active.has(o.ritual_id) ? [active.get(o.ritual_id)!.owner_id, ...active.get(o.ritual_id)!.attendee_ids] : o.attendee_ids), ...held(o.ritual_id)])].map((i) => ref(ctx, i)), meeting_id: db.meetings.find((m) => m.occurrence_id === o.id)?.id ?? null,
    pre_read_ready: !!o.ready, can_start: mayStartRitual(ctx, o.ritual_id),
  }));
  if (only) return rows;
  for (const r of active.values()) {
    if (!r.next_due_at || open.some((o) => o.ritual_id === r.id)) continue;
    rows.push({
      occurrence_id: null, ritual_id: r.id, ritual_title: r.title, due_at: r.next_due_at, ends_at: iso(Date.parse(r.next_due_at) + r.duration_min * 60_000),
      length_min: Math.min(Math.max(r.duration_min, 5), 240), attendees: [...new Set([r.owner_id, ...r.attendee_ids, ...held(r.id)])].map((i) => ref(ctx, i)), meeting_id: null,
      pre_read_ready: false, can_start: mayStartRitual(ctx, r.id),
    });
  }
  return rows.sort((a, b) => a.due_at.localeCompare(b.due_at)).slice(0, 20);
}

/**
 * Starting a ritual's review from its Upcoming row (meetings._occurrence_now): its occurrence at the
 * row's due time when made, else made now when that is the ritual's next due time (the ritual moves
 * on); "moved" when the ritual has moved past it (a stale page: 409, never next week's review).
 */
function occurrenceNow(ctx: MeetingsCtx, db: MeetingsDb, ritualId: string, due: string): Occurrence | "moved" | null {
  const r = ctx.rituals?.rituals.find((x) => x.id === ritualId && x.status === "active");
  if (!r) return null;
  const at = (x: string) => Date.parse(x) === Date.parse(due);
  const mine = db.occurrences.find((o) => o.ritual_id === r.id && at(o.due_at));
  if (mine) return mine;
  const theirs = ctx.rituals?.occurrences.find((o) => o.ritual_id === r.id && at(o.due_at));
  if (theirs) {
    return {
      id: theirs.id, ritual_id: r.id, ritual_title: r.title, due_at: theirs.due_at, ends_at: theirs.ends_at ?? iso(Date.parse(theirs.due_at) + r.duration_min * 60_000),
      length_min: Math.min(Math.max(r.duration_min, 5), 240), attendee_ids: [r.owner_id, ...r.attendee_ids], ready: theirs.status === "ready",
    };
  }
  if (!r.next_due_at || !at(r.next_due_at)) return "moved";
  due = r.next_due_at;
  const o: Occurrence = {
    id: stableUuid(`simple-occurrence/${r.id}/${due}`), ritual_id: r.id, ritual_title: r.title, due_at: due,
    ends_at: iso(Date.parse(due) + r.duration_min * 60_000), length_min: Math.min(Math.max(r.duration_min, 5), 240), attendee_ids: [r.owner_id, ...r.attendee_ids],
  };
  db.occurrences.push(o);
  r.next_due_at = nextOccurrence(r.schedule, new Date(due)).toISOString();
  return o;
}

/** The invented bundle S10 would draw for mobile alerts (was ./simple-priorities' FLOWS). */
const FLOWS: Record<string, Schemas["SimpleFlow"]> = {
  "alert-mobile": plainFlow({
    title: "Act on a pushed alert",
    steps: ["Get the push", "Open the alert", "See what crossed the line", "Snooze or assign it"],
    screen: { title: "Alert on a phone", regions: ["Header: rule and time", "What crossed the line", "Chart of the last day", "Snooze and Assign buttons"] },
  }),
};

/** An invented bundle S10 would draw for Team invite nudges (the "flow" flag). */
const INVITE_FLOW: Schemas["SimpleFlow"] = plainFlow({
  title: "Invite your team",
  steps: ["Finish setup", "See the nudge", "Pick teammates", "Send the invites"],
  screen: { title: "Invite step", regions: ["Header: invite your team", "Teammate emails", "Send invites button"] },
});

/** A meeting decision on a new flow or feature (a draft item): that item and its flow. */
function decidedFlow(ctx: MeetingsCtx, d: Decision): Schemas["SimpleDecidedFlow"] | null {
  const item = items(ctx).find((i) => i.draft && (d.item_ids ?? []).includes(i.id));
  if (!item) return null;
  const flow = flags().includes("flow") && item.key === "setup-ideas" ? INVITE_FLOW : (FLOWS[item.key] ?? null);
  return { kind: "draft_item", id: item.id, title: item.title, flow };
}

function record(db: MeetingsDb, ctx: MeetingsCtx, m: Meeting, title: string, subjects: Decision["subjects"], changeIds: string[], itemIds: string[] = []): Decision {
  const number = Math.max(0, ...db.decisions.map((d) => d.number)) + 1;
  const d: Decision = {
    id: crypto.randomUUID(), number, title, origin: "meeting", status: "decided", approver_id: ctx.me.id, at: iso(Math.max(mockNowMs(), ...db.decisions.map((x) => Date.parse(x.at) + 1))),
    subjects, meeting_id: m.id, change_ids: changeIds, item_ids: itemIds,
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
  record(db, ctx, m, title, [...subjects, { kind: "document", id: prd.id }], [c.id], c.target.item_id ? [String(c.target.item_id)] : []);
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
    decided_at: d.status === "decided" ? d.at : null, created_at: d.at, subjects: d.subjects, flow: decidedFlow(ctx, d),
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
    seedMeetingProposal(ctx);
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
    let occ = b.occurrence_id ? db.occurrences.find((o) => o.id === b.occurrence_id) : undefined;
    if (b.occurrence_id && !occ) {
      const listed = upcoming(ctx, db, b.occurrence_id)[0];
      if (listed?.occurrence_id) occ = { id: listed.occurrence_id, ritual_id: listed.ritual_id, ritual_title: listed.ritual_title, due_at: listed.due_at, ends_at: listed.ends_at, length_min: listed.length_min, attendee_ids: listed.attendees.map((a) => a.id) };
    }
    if (b.occurrence_id && !occ) return json(404, { detail: "No such scheduled review" });
    if (!occ && b.ritual_id) {
      if (!ctx.rituals?.rituals.some((r) => r.id === b.ritual_id && r.status === "active")) return json(404, { detail: "No such scheduled review" });
      if (!mayStartRitual(ctx, b.ritual_id)) return json(403, { detail: "Only an owner or the ritual's owner starts its review" });
      if (!b.due_at) return json(422, { detail: "due_at: the review's due time is required with ritual_id" });
      const got = occurrenceNow(ctx, db, b.ritual_id, b.due_at);
      if (got === "moved") return json(409, { detail: { message: "This scheduled review has moved on: reload Upcoming", meeting_id: null } });
      if (!got) return json(404, { detail: "No such scheduled review" });
      occ = got;
    }
    const first = occ && db.meetings.find((x) => x.occurrence_id === occ.id);
    if (first) return json(409, { detail: { message: "This scheduled review has its meeting already", meeting_id: first.id } });
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
  settleLater(ctx, db, m);
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
    // "section-reviewer": Guided setup's required section "What we will build" names the
    // commenter as its reviewer; absent, it is not approved over their head and the draft
    // waits on them (drafts._sections_approve, drafts._section_people).
    const sectionReviewer = flags().includes("section-reviewer") ? ctx.members.find((x) => x.email === "commenter@example.com") : undefined;
    if (sectionReviewer && !present.includes(sectionReviewer.id) && sectionReviewer.id !== ctx.me.id && !waiting.includes(sectionReviewer.id)) waiting.push(sectionReviewer.id);
    const blocked = flags().includes("section-needs-reviewer") ? ["Sections What we will build need a reviewer"] : [];
    m.approved = { at: now, waiting_on: waiting, blocked_by: blocked };
    const why = [...(waiting.length ? [`Waiting on ${people(waiting.map((i) => nameOf(ctx, i)))}'s approval`] : []), ...blocked];
    record(db, ctx, m, `Approved ${prd.title} (${why.length ? `not yet published: ${why.join(" · ")}` : "published"})`, [{ kind: "document", id: prd.id }], []);
    if (prd.slug === ctx.onePager.doc.slug && why.length) ctx.onePager.approval = { approved_in: m.title, waiting_on: waiting.map((i) => ref(ctx, i)), blocked_by: blocked };
    else if (prd.slug === ctx.onePager.doc.slug) publishOnePager(ctx.onePager);
    return ok();
  }
  if (p[4] === "end" && method === "POST") {
    if (!presenterOrDecider(ctx, m, prd)) return json(403, { detail: "Only the presenter, the PRD's decider or an owner ends it" });
    if (m.status === "ended") return json(409, { detail: "This meeting has ended already" });
    m.status = "ended";
    m.ended_at = now;
    m.ended_by = ctx.me.id;
    m.minutes = extract(ctx, db, m);
    const job = flags().includes("minutes-failed") ? "failed" : flags().includes("minutes-slow") ? "slow" : null;
    const later = flags().includes("minutes-later-failed") ? "failed" : flags().includes("minutes-later") ? "succeeded" : null;
    m.minutes_state = job || later ? "drafting" : "ready";
    m.minutes_job = later ? "drafting" : job;
    m.minutes_due = later ? { at: mockNowMs() + MINUTES_LATER_MS, outcome: later } : null;
    return ok();
  }
  if (p[4] === "minutes" && p[5] === "redraft" && method === "POST") {
    if (!presenterOrDecider(ctx, m, prd)) return json(403, { detail: "Only the presenter, the PRD's decider or an owner drafts again" });
    if (!(m.status === "ended" && m.minutes_state === "drafting" && m.minutes_job === "failed")) return json(409, { detail: "Oracle is not failing to draft these minutes" });
    // The requeued job answers (the fake model): Oracle's minutes, ready to edit and send.
    m.minutes = { ...extract(ctx, db, m), summary: `Oracle's minutes of ${m.title}: ${db.decisions.filter((d) => d.meeting_id === m.id).length} decisions taken.`, written_by: "oracle" };
    m.minutes_state = "ready";
    m.minutes_job = null;
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
    m.minutes_job = null;
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
    m.minutes_job = null;
    m.sent_at = now;
    return ok();
  }
  return null;
}
