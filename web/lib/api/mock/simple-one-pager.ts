/**
 * Simple S5 (#723): one-pagers, as api/oracle/simple/one_pager.py serves them:
 * GET /v1/simple/one-pagers/{doc} (and .../pdf), and the change engine's `edit_line` op on
 * POST /v1/simple/changes with its accept, decline and undo. One invented PRD,
 * "guided-setup", version 3, its six fallback blocks; each line names its source sections.
 *
 * Who (D4, D-a): owners and the PRD's decider (none in the default seed) apply a line edit
 * into the PRD's one shared working draft with a section patch for EVERY source section of
 * the line; approvers and commenters propose it to the decider, else the company's owners;
 * viewers read. Those who see the draft (owners, its people) read the edited lines and the
 * margin notes; everyone else the published lines and a `changes_in_review` count. Undo
 * works for the change's author while its session is open.
 *
 * Submit and Remind (owner, 2026-10-26): an owner submits the draft (POST
 * /v1/simple/drafts/{id}/submit): it waits on the PRD's required reviewers (`ctx.reviewers`).
 * Remind (POST /v1/simple/one-pagers/{doc}/remind, owners and the decider) writes each
 * waiting reviewer an Inbox nudge (`ctx.notify`, kind review_reminder) "<name> is waiting
 * for your review of <PRD>", at most once a day per reviewer (409 when none is due).
 */
import type { Schemas } from "@/lib/api/client";
import { planByMonth } from "@/lib/simple-home";
import { planSlices } from "./simple-plan";
import { mockNowMs } from "./clock";
import { stableUuid } from "./ids";
import { annotate } from "./one-pager-checks";
import { betSubject, flowFor, onePagerFlow, requestVisual, type VisualsDb } from "./simple-visuals";

type Role = Schemas["Me"]["role"];
type Change = Schemas["SimpleChangeOut"];
type Line = Schemas["OnePagerLine"];
type Patch = Schemas["OnePagerSectionPatch"];

export interface OnePagerCtx {
  id: string;
  role: Role;
  owners: string[];
  names: Record<string, string>;
  /** The PRD's required reviewers (its review policy). */
  reviewers: string[];
  /** The PRD's decider (Dana Decider in "simple-deciders", as the meetings mock), and its track owners. */
  decider?: string | null;
  trackOwners?: string[];
  /** Writes one Inbox notification, as oracle.review.collab.notify. */
  notify: (userId: string, kind: "review_reminder", title: string, data: Record<string, unknown>, version: number) => void;
  /** prd-timeline: the PRD's dated plan's milestones ("M1 Prove it"): the PDF prints the timeline, then one page each. */
  planPages?: string[];
}

const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

interface Sec {
  key: string;
  heading: string;
  body: string;
}

interface SeedLine {
  id: string;
  text: string;
  /** The whole text when `text` is shortened with "…" (the API's OnePagerLine.full). */
  full?: string;
  keys: string[];
  metric?: { name: string; from: string; to: string };
}

export interface OnePagerDb {
  doc: { id: string; slug: string; title: string };
  version: number;
  sections: Sec[];
  blocks: { key: string; title: string; rules: string; kind: Schemas["OnePagerBlock"]["kind"]; lines: SeedLine[] }[];
  draft: null | {
    id: string; base: number; participants: string[]; lines: Record<string, string>; sections: Record<string, string>;
    status?: "working" | "submitted"; waiting_on?: string[]; reminders?: Record<string, string>;
  };
  changes: (Change & { session_open: boolean; in_meeting: boolean; meeting_title?: string | null })[];
  /** S10: the visuals (./simple-visuals.ts), shared with the roadmap's. */
  visuals?: VisualsDb;
  /** S8: decided decisions that changed each line (by line id), newest first (./simple-meetings.ts). */
  decisions?: Record<string, { id: string; number: number; title: string }[]>;
  /** Imported by a service token: the PRD has no owner yet. */
  ownerless?: boolean;
  /**
   * The document's owner (one_pager.document_owner, P4): the member who brought the PRD in;
   * unset, the company's first owner (who imported the seeded PRD).
   */
  owner?: string;
  /** The PRD's roadmap slice, when not the default invented one (SLICE). */
  slice?: SliceItem[];
  /** S8: the decider approved the draft in a meeting: its title and who it still waits on. */
  approval?: { approved_in: string; waiting_on: { id: string; name: string }[]; blocked_by?: string[] } | null;
}

const DOC_ID = stableUuid("simple-one-pager-doc");

export function seedOnePager(ownerless = false): OnePagerDb {
  const sections: Sec[] = [
    { key: "problem", heading: "Problem", body: "New workspace admins stall during setup and never invite a teammate in the first week." },
    { key: "who", heading: "Who has it", body: "Admins of new teams with fewer than ten people." },
    { key: "build", heading: "What we will build", body: "- A setup checklist that shows the next step\n- Invite suggestions from the admin's calendar\n- A sample project created on day one" },
    { key: "outcomes", heading: "Outcomes", body: "- Teammate invited in week one from 48% to 65%\n- Setup finished in a day from 30% to 50%" },
    { key: "not-doing", heading: "Not doing", body: "- Single sign-on setup\n- A mobile setup flow" },
    { key: "risks", heading: "Risks and open decisions", body: "- Calendar access may scare admins away\n- Decide whether the sample project can be deleted\n- F-26 may slip past M1†" },
    // Reads clearly (2026-10-30): a measure, the codes' names and numbers that disagree.
    { key: "definitions", heading: "Definitions", body: "- Teammate invited in week one: counted as admins whose first invite is accepted within 7 days; source: the product events table" },
    { key: "glossary", heading: "Glossary", body: "| Code | Name |\n|---|---|\n| F-26 | Calendar invites |" },
    { key: "targets", heading: "Targets", body: "Each region adds 40 paid workspaces a month. We sell in 5 regions. Company-wide target: 250 paid workspaces a month." },
    { key: "later", heading: "Not this quarter", body: "Eight features wait for next quarter.\n\n- Single sign-on setup\n- A mobile setup flow\n- Setup in more languages\n- Bulk user import\n- Setup analytics\n- A guided tour video" },
  ];
  return {
    doc: { id: DOC_ID, slug: "guided-setup", title: "Guided setup" },
    version: 3,
    sections,
    blocks: [
      { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", lines: [
        { id: "problem-1", text: "New workspace admins stall during setup and never invite a teammate in the first week. Admins of new teams with fewer than ten people.", keys: ["problem", "who"] },
      ] },
      { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: [
        { id: "bets-1", text: "A setup checklist that shows the next step", keys: ["build"] },
        { id: "bets-2", text: "Invite suggestions from the admin's calendar", keys: ["build"] },
        { id: "bets-3", text: "A sample project created on day one", keys: ["build"] },
      ] },
      { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: [
        { id: "outcomes-1", text: "Teammate invited in week one from 48% to 65%", keys: ["outcomes"], metric: { name: "Teammate invited in week one", from: "48%", to: "65%" } },
        { id: "outcomes-2", text: "Setup finished in a day from 30% to 50%", keys: ["outcomes"], metric: { name: "Setup finished in a day", from: "30%", to: "50%" } },
      ] },
      { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: [
        { id: "not_doing-1", text: "Single sign-on setup", keys: ["not-doing"] },
        { id: "not_doing-2", text: "A mobile setup flow", keys: ["not-doing"] },
      ] },
      { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: [
        { id: "risks-1", text: "Calendar access may scare admins away", keys: ["risks"] },
        { id: "risks-2", text: "Decide whether the sample project can be deleted", keys: ["risks"] },
        { id: "risks-3", text: "F-26 may slip past M1†", keys: ["risks"] },
      ] },
      { key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] },
    ],
    draft: null,
    changes: [],
    ownerless,
  };
}

/**
 * The PRD's roadmap slice (invented): 12 items carry M1, 5 carry M2, 3 carry M3, 2 have no
 * milestone; one of those is committed past M3's month (the strip's edge).
 */
type SliceItem = {
  title: string;
  horizon: "now" | "next" | "later";
  start: string;
  end: string;
  estimated: boolean;
  milestone: [string, string] | null;
  /** The track milestone record naming the item, when any (the strip's row). */
  record?: { id: string; name: string };
  /** The day its milestone starts when the PRD's plan dates it (the strip's row spans it). */
  milestoneStart?: string;
};

/** The plan-model lane ("simple-plan"): the slice as the PRD's dated plan has it, one item per slice. */
export function planSlice(): SliceItem[] {
  return planSlices().map((x) => ({
    title: x.name,
    horizon: "now" as const,
    start: x.start_date!,
    end: x.end_date!,
    estimated: !(x.milestone_start && x.milestone_end),
    milestone: [`${x.milestone} · ${x.milestone_name}`, x.milestone_end!] as [string, string],
    milestoneStart: x.milestone_start!,
  }));
}
const BETA_LAUNCH = { id: stableUuid("op-milestone/beta-launch"), name: "Beta launch" };
const SLICE: SliceItem[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ title: `Setup step ${i + 1}`, horizon: "now" as const, start: "2026-10-05", end: "2026-11-20", estimated: false, milestone: ["M1", "2026-11-20"] as [string, string] })),
  ...Array.from({ length: 5 }, (_, i) => ({ title: `Calendar invites ${i + 1}`, horizon: "next" as const, start: "2026-11-23", end: "2026-12-18", estimated: i > 2, milestone: ["M2", "2026-12-18"] as [string, string] })),
  ...Array.from({ length: 3 }, (_, i) => ({ title: `Sample project ${i + 1}`, horizon: "later" as const, start: "2026-12-21", end: "2027-01-29", estimated: true, milestone: ["M3", "2027-01-29"] as [string, string] })),
  { title: "Setup help center", horizon: "now", start: "2026-10-12", end: "2026-12-11", estimated: false, milestone: null },
  { title: "Setup analytics", horizon: "later", start: "2026-11-02", end: "2027-03-12", estimated: false, milestone: null },
];

/**
 * CLD's production walk (2026-10-27), the "simple-walk" scenario: a slice whose milestone
 * texts carry their items' notes, as real roadmaps do (one row per milestone on the strip),
 * and a problem line the API cut at a word with its whole text kept. Invented data.
 */
const NOTED_SLICE: SliceItem[] = [
  { title: "Baseline export", horizon: "now", start: "2026-10-05", end: "2026-11-18", estimated: false, milestone: ["M1 · Measure it, make it safe (baseline needs the export); Alert digest in M2 · Ship to beta", "2026-11-20"] },
  { title: "Dry run", horizon: "now", start: "2026-10-12", end: "2026-11-20", estimated: true, milestone: ["M1 · Measure it, make it safe (owner asks for a dry run)", "2026-11-20"] },
  { title: "Setup audit", horizon: "now", start: "2026-10-19", end: "2026-11-13", estimated: false, milestone: ["M1 · Measure it, make it safe; follow-up in M3", "2026-11-20"] },
  { title: "Beta invites", horizon: "next", start: "2026-11-23", end: "2026-12-18", estimated: false, milestone: ["M2 · Ship to beta (two teams first)", "2026-12-18"] },
  { title: "Beta feedback form", horizon: "next", start: "2026-12-01", end: "2026-12-11", estimated: true, milestone: ["M2 · Ship to beta", "2026-12-18"] },
  // A track milestone record naming three items: two whose own texts differ, one with none.
  { title: "Beta for two teams", horizon: "next", start: "2026-12-07", end: "2027-01-08", estimated: false, milestone: ["Beta launch, two teams first", "2027-01-15"], record: BETA_LAUNCH },
  { title: "Beta terms", horizon: "next", start: "2026-12-14", end: "2027-01-12", estimated: true, milestone: ["Beta launch - after legal", "2027-01-15"], record: BETA_LAUNCH },
  { title: "Beta docs", horizon: "next", start: "2026-12-14", end: "2027-01-08", estimated: true, milestone: null, record: BETA_LAUNCH },
  { title: "Setup help center", horizon: "now", start: "2026-10-12", end: "2026-12-11", estimated: false, milestone: null },
];
export const WALK_PROBLEM =
  "New workspace admins stall during setup because the checklist hides the invite step. The queue of half-set-up teams grows every week a cohort lands; teams with more than ten people wait the longest, and the promise we make is a first teammate invited within a 48-hour window that we miss for most new teams after a weekend signup.";

export function seedWalkOnePager(): OnePagerDb {
  const db = seedOnePager();
  db.slice = NOTED_SLICE;
  db.sections[0].body = WALK_PROBLEM;
  // As the API stores it: 60 words at most, cut at a word with "…", the whole text kept.
  db.blocks[0].lines[0] = { id: "problem-1", text: `${WALK_PROBLEM.split(" ").slice(0, 52).join(" ")}…`, full: WALK_PROBLEM, keys: ["problem"] };
  return db;
}

/**
 * A PRD started from an empty skeleton (the "simple-walk" scenario): its sections are the
 * template's guidance only, and the lines an older build stored from them (an HTML comment,
 * placeholders, a bare arrow) never show: the API's read drops them (one_pager.template_only)
 * and an empty block reads "Not written yet". Invented data.
 */
export function seedSkeletonOnePager(doc: OnePagerDb["doc"]): OnePagerDb {
  const db = seedOnePager();
  const guide: Record<string, string> = {
    problem: "<!-- Brief: fits one slide; say who has the problem and what it costs them. -->",
    bets: "<Milestone>: <Feature>",
    outcomes: "→",
    not_doing: "<!-- What we leave out -->",
    risks: "<Risk>: <mitigation>",
  };
  db.doc = doc;
  db.sections = db.sections.map((x) => ({ ...x, body: "<!-- Write this section. -->\n- <Milestone>: <Feature>\n- →" }));
  db.blocks = db.blocks.map((b) => ({ ...b, lines: b.kind === "timeline" ? [] : [{ id: `${b.key}-1`, text: guide[b.key] ?? "→", keys: [db.sections[0].key] }] }));
  return db;
}

/**
 * As one_pager.milestone_span (P4): from the earliest start of the items under dated milestones
 * (or that date, when earlier) to the latest milestone date; null with no dated milestone.
 */
function milestoneSpan(items: SliceItem[]): [string, string] | null {
  const dated = items.filter((i) => i.milestone?.[1]);
  if (!dated.length) return null;
  const end = dated.map((i) => i.milestone![1]).sort().pop()!;
  const start = dated.flatMap((i) => [i.start, i.milestone![1]]).sort()[0];
  return [start < end ? start : end, end];
}

/** The API's one_pager.template_only: only a template's comments, placeholders or arrows. */
const uncomment = (t: string) => t.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
const templateOnly = (t: string) => !/[\p{L}\p{N}]/u.test(uncomment(t).replace(/<[^<>\n]*>/g, ""));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

/** As one_pager.decides: an owner; the decider; with none, a track owner while an approver. */
function decides(ctx: OnePagerCtx): boolean {
  if (ctx.role === "owner") return true;
  if (ctx.decider) return ctx.id === ctx.decider;
  return (ctx.trackOwners ?? []).includes(ctx.id) && RANK[ctx.role] >= RANK.approver;
}

/** As one_pager.starts (meetings.may_start): an owner or the PRD's decider start its review. */
function starts(ctx: OnePagerCtx): boolean {
  return ctx.role === "owner" || (!!ctx.decider && ctx.id === ctx.decider);
}

function seesDraft(db: OnePagerDb, ctx: OnePagerCtx): boolean {
  return ctx.role === "owner" || (db.draft?.participants.includes(ctx.id) ?? false) || (!!db.draft && ctx.reviewers.includes(ctx.id));
}

/** As one_pager.may_remind: the PRD's owners (a company owner, its track owners) and its decider. */
function mayRemind(ctx: OnePagerCtx): boolean {
  return decides(ctx) || (ctx.trackOwners ?? []).includes(ctx.id);
}

/** As one_pager.due_reminders: waiting reviewers not reminded in the last day. */
function dueReminders(db: OnePagerDb): string[] {
  const d = db.draft;
  if (!d || d.status !== "submitted") return [];
  const sent = d.reminders ?? {};
  return (d.waiting_on ?? []).filter((i) => !sent[i] || mockNowMs() - Date.parse(sent[i]) >= REMIND_EVERY_MS);
}

function remindedAt(db: OnePagerDb): string | null {
  const d = db.draft;
  const at = Object.entries(d?.reminders ?? {}).filter(([k]) => d?.waiting_on?.includes(k)).map(([, v]) => v).sort();
  return at.length ? at[at.length - 1] : null;
}

function seedLine(db: OnePagerDb, id: string): SeedLine | undefined {
  return db.blocks.flatMap((b) => b.lines).find((l) => l.id === id);
}

function lineNow(db: OnePagerDb, id: string): string | undefined {
  return db.draft?.lines[id] ?? seedLine(db, id)?.text;
}

function sectionNow(db: OnePagerDb, key: string, sees = true): string {
  return (sees ? db.draft?.sections[key] : undefined) ?? db.sections.find((s) => s.key === key)!.body;
}

/** As the API's one_pager.patch_all: the facts (bullets, else sentences) the old line says
 * are replaced by the new line in its first section and dropped from the others; null when
 * a section holds none of them (the edit is refused, never appended). */
function plain(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}
function patch(body: string, old: string, next: string, first: boolean): string | null {
  const bullets = body.split("\n").map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x);
  const spans = bullets.length ? bullets : body.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const o = plain(old).replace(/…$/, "");
  const hits = spans.filter((r) => plain(r) && (o.includes(plain(r)) || (o.split(" ").length > 2 && plain(r).includes(o))));
  if (!hits.length) return null;
  let out = body;
  hits.forEach((raw, i) => {
    if (first && i === 0) out = out.replace(raw, next);
    else if (bullets.length) out = out.split("\n").filter((l) => !(l.includes(raw) && /^\s*(?:[-*+]|\d+[.)])\s/.test(l))).join("\n");
    else out = out.replace(new RegExp(raw.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "\\s*"), "");
  });
  return out;
}

/** As the API's metric_of: "name from X to Y". */
function metricOf(text: string): Line["metric"] {
  const m = /^(.*?)[:\s,-]*\s(?:from\s+)?(\S+)\s*(?:→|->|\bto\b)\s*(\S+)/i.exec(text);
  return m ? { name: m[1].trim() || text, from: m[2], to: m[3] } : null;
}

function write(db: OnePagerDb, ctx: OnePagerCtx, lineId: string, values: Record<string, unknown>) {
  db.draft ??= { id: stableUuid(`simple-one-pager-draft-${db.doc.id}-${mockNowMs()}`), base: db.version, participants: [], lines: {}, sections: {} };
  if (!db.draft.participants.includes(ctx.id)) db.draft.participants.push(ctx.id);
  const line = String(values.line);
  if (line === seedLine(db, lineId)?.text) delete db.draft.lines[lineId];
  else db.draft.lines[lineId] = line;
  for (const [k, v] of Object.entries((values.sections ?? {}) as Record<string, { body: string }>)) {
    if (v.body === db.sections.find((s) => s.key === k)?.body) delete db.draft.sections[k];
    else db.draft.sections[k] = v.body;
  }
}

/**
 * S8: the decider's Approve in a meeting with no required reviewer waiting publishes the
 * PRD's draft (drafts.approve_in_meeting): its lines and sections become the page's, the
 * version moves on, no working draft is left; open proposals stay.
 */
export function publishOnePager(db: OnePagerDb) {
  const d = db.draft;
  if (!d) return;
  for (const b of db.blocks) for (const l of b.lines) if (d.lines[l.id] !== undefined) l.text = d.lines[l.id];
  for (const sec of db.sections) if (d.sections[sec.key] !== undefined) sec.body = d.sections[sec.key];
  db.version += 1;
  db.draft = null;
  db.approval = null;
  db.changes = db.changes.filter((c) => c.status === "proposed");
}

function liveChanges(db: OnePagerDb) {
  const undone = new Set(db.changes.filter((c) => c.status === "undone").map((c) => c.undoes_id));
  return db.changes.filter((c) => (c.status === "applied" || c.status === "accepted") && !undone.has(c.id));
}

function out(db: OnePagerDb, ctx: OnePagerCtx, c: Change): Change {
  return {
    ...c,
    can_decide: c.status === "proposed" && (ctx.role === "owner" || c.routed_to.includes(ctx.id)),
    can_undo: c.status === "applied" && c.by === ctx.id && !db.changes.some((u) => u.undoes_id === c.id),
  };
}

function patches(c: Change): Patch[] {
  const before = (c.before.sections ?? {}) as Record<string, { heading: string; body: string }>;
  return Object.entries((c.after.sections ?? {}) as Record<string, { heading: string; body: string }>).map(([key, v]) => ({
    key, heading: v.heading, before: before[key]?.body ?? "", after: v.body,
  }));
}

function onePager(db: OnePagerDb, ctx: OnePagerCtx): Schemas["OnePagerOut"] {
  const sees = seesDraft(db, ctx);
  const proposals = db.changes.filter((c) => c.status === "proposed");
  const shown = proposals.filter((c) => c.by === ctx.id || ctx.role === "owner" || c.routed_to.includes(ctx.id));
  const live = sees ? liveChanges(db).filter((c) => c.status !== "undone") : [];
  const note = (c: (typeof db.changes)[number], kind: "change" | "proposal"): Schemas["OnePagerNote"] => {
    const lineId = String(c.target.line_id);
    return {
      change_id: c.id, line_id: lineId, kind, by: c.by, by_name: c.by_name, at: c.at, in_meeting: c.in_meeting,
      before: String(c.before.line ?? ""), after: String(c.after.line ?? ""), sections: patches(c),
      can_undo: kind === "proposal" ? c.by === ctx.id : c.by === ctx.id && c.session_open,
      can_decide: kind === "proposal" && (ctx.role === "owner" || c.routed_to.includes(ctx.id)),
      adds_feature: lineId.startsWith("bets-"), flow: onePagerFlow(flowFor(db.visuals, "change", c.id)), meeting_title: c.meeting_title ?? null,
    };
  };
  const notes = [...live.map((c) => note(c, "change")), ...shown.map((c) => note(c, "proposal"))];
  const proposed = new Set(notes.filter((n) => n.kind === "proposal").map((n) => n.line_id));
  const hiddenDraft = !sees && db.draft ? Object.keys(db.draft.lines).length : 0;
  const owner = db.ownerless ? undefined : db.owner ?? ctx.owners[0];
  const span = milestoneSpan(db.slice ?? SLICE);
  const blocks: Schemas["OnePagerBlock"][] = db.blocks.map((b) => ({
      key: b.key, title: b.title, rules: b.rules, kind: b.kind, who: null,
      lines: b.lines.filter((l) => (sees && db.draft?.lines[l.id] !== undefined) || !templateOnly(l.text)).map((l): Line => {
        const edited = sees && db.draft?.lines[l.id] !== undefined;
        const text = edited ? db.draft!.lines[l.id] : uncomment(l.text).split(/\s+/).filter(Boolean).join(" ");
        const flow = b.key === "bets" ? onePagerFlow(flowFor(db.visuals, "one_pager_line", betSubject(l.id))) : null;
        return {
          id: l.id, text, full: edited ? null : l.full ?? null, source_keys: l.keys, metric: edited && b.kind === "metrics" ? metricOf(text) : l.metric ?? null,
          state: edited ? "edited" : proposed.has(l.id) ? "proposal" : "published",
          // S10: each bet carries its visual, keyed by its line: an edit keeps the flow. Its
          // brief is the published words (the API's bet_line): never a draft's.
          ...(b.key === "bets" ? { flow_subject: betSubject(l.id, uncomment(l.text).split(/\s+/).filter(Boolean).join(" ")), flow } : {}),
          decisions: [...(db.decisions?.[l.id] ?? [])],
          measure: null, measure_source: null, footnotes: [],
          // 2026-10-30: a bet with no flow offers "Draw the flow" to those who change the PRD (visuals.may_revise).
          can_draw_flow: b.key === "bets" && !flow && decides(ctx),
        };
      }),
    }));
  // Reads clearly (2026-10-30): as one_pager_checks.annotate on the PRD's sections.
  const looks = annotate(blocks, db.sections);
  return {
    document: db.doc,
    version: db.version,
    published_at: "2026-10-20T15:00:00Z",
    owner: owner ? { id: owner, name: ctx.names[owner] ?? "Owner" } : null,
    decider: ctx.decider ? { id: ctx.decider, name: ctx.names[ctx.decider] ?? "someone" } : null,
    span_start: span?.[0] ?? null,
    span_end: span?.[1] ?? null,
    built_by: "oracle",
    built_at: "2026-10-20T15:05:00Z",
    blocks,
    timeline: (db.slice ?? SLICE).map((x, i) => ({ id: stableUuid(`op-item-${i + 1}`), title: x.title, horizon: x.horizon, start: x.start, end: x.end, estimated: x.estimated })),
    plan: planByMonth(
      (db.slice ?? SLICE).map((x) => ({ start: x.start, end: x.end, estimated: x.estimated, milestone: x.milestone?.[0] ?? null, milestoneDate: x.milestone?.[1] ?? null, milestoneStart: x.milestoneStart ?? null, record: x.record ?? null })),
      new Date(mockNowMs()).toISOString().slice(0, 10),
    ),
    // As the API: the sections the page's lines rest on.
    sections: db.sections.filter((s) => db.blocks.some((b) => b.lines.some((l) => l.keys.includes(s.key)))).map((s) => ({ key: s.key, heading: s.heading, body: sectionNow(db, s.key, sees) })),
    notes,
    draft: sees && db.draft
      ? {
          id: db.draft.id, status: db.draft.status ?? "working", changes: liveChanges(db).length, base_version: db.draft.base, decider_approved: !!db.approval, approved_in: db.approval?.approved_in ?? null, blocked_by: db.approval?.blocked_by ?? [],
          waiting_on: db.approval?.waiting_on ?? (db.draft.waiting_on ?? []).map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })),
          can_submit: (db.draft.status ?? "working") === "working" && decides(ctx) && liveChanges(db).length > 0,
          reminded_at: remindedAt(db), can_remind: mayRemind(ctx) && dueReminders(db).length > 0,
        }
      : null,
    changes_in_review: hiddenDraft + (proposals.length - shown.length),
    can_edit: decides(ctx),
    can_propose: !decides(ctx) && RANK[ctx.role] >= RANK.commenter,
    can_start: starts(ctx),
    // As one_pager.owns: a company owner, the PRD's track owners and its document owner.
    needs_look: ctx.role === "owner" || (ctx.trackOwners ?? []).includes(ctx.id) || (!!owner && ctx.id === owner) ? looks : [],
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

export async function routeOnePager(db: OnePagerDb, ctx: OnePagerCtx, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "simple") return null;
  const m = req.method;
  if (p[2] === "one-pagers" && m === "GET") {
    if (p[3] !== db.doc.slug && p[3] !== db.doc.id) return json(404, { detail: "No such PRD" });
    if (p[4] === "pdf") {
      const pages = ctx.planPages?.length ? ["The timeline", ...ctx.planPages] : ["One page"];
      return new Response(`%PDF-1.7\n${pages.map((t, i) => `% page ${i + 1}: ${t}\n`).join("")}`, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${db.doc.slug}-v${db.version}-one-pager.pdf"` },
      });
    }
    return json(200, onePager(db, ctx));
  }
  if (p[2] === "drafts" && p[4] === "submit" && m === "POST" && db.draft && p[3] === db.draft.id) {
    if (!decides(ctx)) return json(403, { detail: "Only an owner or the PRD's decider submits its draft" });
    if ((db.draft.status ?? "working") !== "working") return json(409, { detail: "This draft is submitted already" });
    db.draft.status = "submitted";
    db.draft.waiting_on = [...ctx.reviewers];
    db.draft.reminders = {};
    db.changes.forEach((c) => (c.session_open = false));
    return json(200, { id: db.draft.id, status: "submitted", version: db.version + 1, waiting_on: db.draft.waiting_on });
  }
  if (p[2] === "one-pagers" && p[4] === "remind" && m === "POST") {
    if (p[3] !== db.doc.slug && p[3] !== db.doc.id) return json(404, { detail: "No such PRD" });
    if (RANK[ctx.role] < RANK.commenter || !mayRemind(ctx)) return json(403, { detail: "Only the PRD's owners and its decider remind its reviewers" });
    const d = db.draft;
    if (!d || d.status !== "submitted" || !d.waiting_on?.length) return json(409, { detail: "No submitted draft of this PRD waits on a review" });
    const due = dueReminders(db);
    if (!due.length) return json(409, { detail: "Every reviewer it waits on was reminded in the last day" });
    const at = new Date(mockNowMs()).toISOString();
    const n = liveChanges(db).length;
    for (const i of due) {
      if (i === ctx.id) continue;
      ctx.notify(i, "review_reminder", `${ctx.names[ctx.id] ?? "Someone"} is waiting for your review of ${db.doc.title}`, {
        draft_id: d.id, href: `/simple/one-pagers/${db.doc.slug}`, waits: `Version ${db.version + 1} · ${n} ${n === 1 ? "change" : "changes"}`,
      }, db.version + 1);
    }
    d.reminders = { ...(d.reminders ?? {}), ...Object.fromEntries(due.map((i) => [i, at])) };
    return json(200, { reminded: due.map((i) => ({ id: i, name: ctx.names[i] ?? "someone" })), reminded_at: at });
  }
  if (p[2] !== "changes") return null;
  if (m === "POST" && p.length === 3) {
    const b = await body(req.clone());
    if (b.op !== "edit_line") return null;
    const target = (b.target ?? {}) as Record<string, string>;
    const lineId = String(target.line_id ?? "");
    // Who cannot see the draft proposes against the published line and sections.
    const sees = seesDraft(db, ctx);
    const cur = sees ? lineNow(db, lineId) : seedLine(db, lineId)?.text;
    if (cur === undefined) return json(404, { detail: "No such line on this one-pager" });
    if (RANK[ctx.role] < RANK.commenter) return json(403, { detail: "Viewers read the one-pager" });
    const old = String(((b.before ?? {}) as Record<string, unknown>).line ?? "");
    const next = String(((b.after ?? {}) as Record<string, unknown>).line ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (!next || next.length > 300) return json(422, { detail: "after.line: 1 to 300 characters" });
    if (old !== cur) return json(409, { detail: { message: "This line changed since you read it", current: { line: cur }, changed_by: null, changed_at: null } });
    const keys = seedLine(db, lineId)!.keys;
    const heads = Object.fromEntries(db.sections.map((s) => [s.key, s.heading]));
    const patched = keys.map((k, i) => patch(sectionNow(db, k, sees), cur, next, i === 0));
    if (patched.some((x) => x === null)) return json(409, { detail: "Oracle could not find this line's words in its sections; open the detailed view to edit them" });
    const before = { line: cur, sections: Object.fromEntries(keys.map((k) => [k, { heading: heads[k], body: sectionNow(db, k, sees) }])) };
    const after = { line: next, sections: Object.fromEntries(keys.map((k, i) => [k, { heading: heads[k], body: patched[i]! }])) };
    const applies = decides(ctx);
    const c = {
      id: stableUuid(`op-change-${db.doc.id}-${db.changes.length}-${mockNowMs()}`), session_id: applies ? stableUuid(`op-session-${ctx.id}`) : null,
      document_id: db.doc.id, draft_ids: [] as string[], op: "edit_line" as const,
      target: { document_id: db.doc.id, line_id: lineId, version: db.version }, before, after,
      status: (applies ? "applied" : "proposed") as Change["status"], by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone",
      at: new Date(mockNowMs()).toISOString(), decided_by: null, decided_at: null, reason: null, decision_reason: null,
      routed_to: applies ? [] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
      session_open: applies, in_meeting: false,
    };
    if (applies) {
      write(db, ctx, lineId, after);
      c.draft_ids = [db.draft!.id];
    }
    db.changes.push(c);
    // S10: a bet's new wording comes with its visual (Oracle drafts it with the proposal).
    if (lineId.startsWith("bets-")) requestVisual(db.visuals, "change", c.id, `A bet of the PRD's one-pager, reworded to: ${next}`);
    return json(201, { change: out(db, ctx, c), flags: [] });
  }
  const c = db.changes.find((x) => x.id === p[3]);
  if (!c || m !== "POST") return null;
  if (p[4] === "accept" || p[4] === "decline") {
    if (!(ctx.role === "owner" || c.routed_to.includes(ctx.id))) return json(403, { detail: "Only an owner or the PRD's decider decides this proposal" });
    if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
    const lineId = String(c.target.line_id);
    if (p[4] === "accept") {
      if (lineNow(db, lineId) !== c.before.line) return json(409, { detail: { message: "outdated: the line or its sections changed since the proposal", current: { line: lineNow(db, lineId) }, changed_by: null, changed_at: null } });
      write(db, ctx, lineId, c.after);
      c.draft_ids = [db.draft!.id];
    }
    c.status = p[4] === "accept" ? "accepted" : "declined";
    c.decided_by = ctx.id;
    c.decided_at = new Date(mockNowMs()).toISOString();
    return json(200, { change: out(db, ctx, c), flags: [] });
  }
  if (p[4] === "undo") {
    // qa-simple-prd-p3-17: a proposal is withdrawn by its author (declined, the PRD untouched).
    if (c.status === "proposed") {
      if (c.by !== ctx.id) return json(403, { detail: "Only the person who proposed it withdraws it" });
      c.status = "declined";
      c.decided_by = ctx.id;
      c.decided_at = new Date(mockNowMs()).toISOString();
      c.decision_reason = "Withdrawn by its author";
      return json(201, { change: out(db, ctx, c), flags: [] });
    }
    if (c.status !== "applied") return json(409, { detail: `Only an applied change undoes; this one is ${c.status}` });
    if (c.by !== ctx.id) return json(403, { detail: "Only the person who made a change undoes it" });
    if (db.changes.some((u) => u.undoes_id === c.id)) return json(409, { detail: "This change is undone already" });
    write(db, ctx, String(c.target.line_id), c.before);
    const u = { ...c, id: stableUuid(`op-undo-${c.id}`), status: "undone" as const, before: c.after, after: c.before, undoes_id: c.id, at: new Date(mockNowMs()).toISOString() };
    db.changes.push(u);
    return json(201, { change: out(db, ctx, u), flags: [] });
  }
  return null;
}
