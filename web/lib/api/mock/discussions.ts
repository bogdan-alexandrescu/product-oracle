/**
 * Discussions (G1) in the mock: every /v1/discussions route, with the API's rules
 * (oracle.discussions): open by default, private when the starter says so, only the starter
 * adds people to a private one, viewers read, and the starter alone makes a private one open
 * with the counts its warning showed (409 with the current counts otherwise, then a system
 * line). Seeded only in the "discussions" scenario.
 *
 * G3 Outcome extraction: the canned Oracle reply proposes 2 changes of the kinds its subject
 * offers (on a section, as the API: section_edit and answer, so 2 section edits) as it ends, and the change routes act as the API's do for the four roles:
 * commenters suggest and edit, approvers stage, edit and dismiss, viewers only read; a
 * private discussion's Stage needs the reason everyone will see; a stale lock_version is 409.
 */
import type { Schemas } from "@/lib/api/client";
import type { ChangeOut, ChangeStatus, ChangeVerb } from "@/lib/api/discussion-changes";

import { companyDayInWords } from "./connections";

type Role = Schemas["MemberOut"]["role"];
type Member = { id: string; email: string; role: Role; status?: string | null };
type Kind = Schemas["DiscussionCreate"]["subject_kind"];

export type DiscussionRow = {
  id: string;
  subject_kind: Kind;
  subject: Record<string, unknown>;
  subject_key: string;
  subject_label: string;
  subject_url: string;
  document_id: string | null;
  run_id: string | null;
  title: string;
  visibility: "open" | "private";
  author_only: boolean;
  status: "open" | "closed";
  origin: "discuss" | "panel" | "slack";
  started_by: string;
  summary: string | null;
  summary_status: "none" | "draft" | "confirmed";
  summary_shared: boolean;
  last_message_at: string | null;
  lock_version: number;
  created_at: string;
  updated_at: string;
  /** G2 (mock only): the intake author's private findings on the subject (G1 §3.4.6). */
  private_findings?: { author: string; count: number; intake_id: string } | null;
  /** G8: its live link to a Slack thread (./slack.ts), or none. */
  slack?: Schemas["DiscussionSlackOut"] | null;
};
type ParticipantRow = {
  discussion_id: string;
  user_id: string;
  added_via: Schemas["DiscussionParticipantOut"]["added_via"];
  left_at: string | null;
  last_read_at: string | null;
  created_at: string;
};
export type MessageRow = {
  id: string;
  discussion_id: string;
  author_kind: "person" | "oracle" | "system";
  author_id: string | null;
  body: string;
  mentions: string[];
  mentions_oracle: boolean;
  reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  // G2 Live replies: an Oracle reply's state.
  status?: Schemas["DiscussionMessageOut"]["status"];
  citations?: Record<string, unknown>[];
  error_reason?: string | null;
  cancel_requested?: boolean;
  /** Pushback (G2, B6): the reason Oracle pushed back. */
  pushback?: { reason: string } | null;
  /** The mock's scripted reply for this message (a goals interview), in the pieces it streams. */
  script?: string[];
  script_citations?: Record<string, unknown>[];
  /** Where it was written: "web" unless stored otherwise (G8: a reply in the Slack thread). */
  via?: Schemas["DiscussionMessageOut"]["via"];
  /** G2 §4 Research this: the research run this line started, or whose answer this is. */
  run_id?: string | null;
  /** The mock's research run finishes on the thread's second read after it started (as a ritual summary's). */
  research_reads?: number;
  /** A research line whose run could not start: why, in words (the API keeps it in `error`). */
  research_error?: string;
};

/** G3/B6: a change Oracle or a person offered in a discussion (a section_edit, a goal_measure version); people by id, `action`, `can` and `needs_reason` computed per reader. */
export type ChangeRow = {
  id: string;
  discussion_id: string;
  kind: string;
  label: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  edited_payload: Record<string, unknown> | null;
  rationale: string | null;
  proposed_by_kind: "oracle" | "person";
  proposed_by: string | null;
  suggested_by: string | null;
  status: ChangeStatus;
  // Optional: B6's goal versions and G6's seeded rows set only what they use.
  pushback?: { reason: string; sources?: number[] } | null;
  basis?: { intake_id: string; finding_id: string }[];
  result_ref?: Record<string, unknown> | null;
  decision_note?: string | null;
  override_reason?: string | null;
  /** A private discussion's Stage: the reason everyone who can see the subject reads. */
  reason?: string | null;
  from_message_id?: string | null;
  lock_version: number;
  created_at: string;
};
/** G6: a person's Invited or Mentioned row (the API's discussion_inbox_items). */
type InboxItemRow = {
  id: string;
  user_id: string;
  discussion_id: string;
  kind: "invited" | "mentioned";
  message_id: string | null;
  by_user_id: string | null;
  created_at: string;
  done_at: string | null;
};

export type DiscussionsDb = {
  discussions: DiscussionRow[];
  participants: ParticipantRow[];
  messages: MessageRow[];
  /** G6 (the "discussions" scenario): Inbox rows and the changes discussions ended in. */
  inbox?: InboxItemRow[];
  changes?: ChangeRow[];
};

/** A subject as the mock resolves it: its key, label, link and document or run. */
export type SubjectInfo = { key: string; label: string; url: string; document_id?: string | null; run_id?: string | null };

export type DiscussionsContext = {
  db: DiscussionsDb;
  members: Member[];
  me: { id: string; role: Role };
  /** The subject's key, label and link; a string is the refusal (status, detail). */
  resolve: (kind: Kind, subject: Record<string, unknown>) => SubjectInfo | { status: number; detail: string };
  uuid: () => string;
  now: () => string;
  /** Writes after the response (a streaming reply): applied to the saved state in turn. */
  persist?: (change: (db: DiscussionsDb) => void) => Promise<void>;
  /** The saved state now (a streaming reply checks for Stop). */
  current?: () => DiscussionsDb;
  /** B6: Oracle's scripted reply to a person's message (a goals interview); null: the canned one. */
  replyScript?: (d: DiscussionRow, asked: MessageRow) => { pieces: string[]; citations: Record<string, unknown>[] } | null;
  /** G8 POST/DELETE …/slack on a discussion the caller may read (./slack.ts). */
  slack?: (d: DiscussionRow, req: Request) => Promise<Response | null>;
  /** The gateway's refusal while the Claude account pool is spent, worded; null otherwise. */
  refusal?: () => string | null;
  /** G2 §4: the runs' refusal of a research start, worded; null when they start it. */
  researchRefusal?: () => string | null;
  /** The address the research's web citation carries instead of its own; null: its own. */
  researchLink?: () => string | null;
  /** #406: the text of the document version a discussion is on, the section it is on first. */
  documentText?: (d: DiscussionRow) => DocumentSection[];
  /** F3 Date bases' rights for me (leads.date_rights): verify, propose, or none. */
  dateRights?: () => "verify" | "propose" | null;
  /** F3's schedule-basis route (./roadmap.ts POST /v1/schedule-bases): Record writes through it. */
  recordBasis?: (body: Schemas["ScheduleBasisCreate"]) => Promise<Response>;
};

/** A section of the document a discussion is on, as Oracle reads it (markers stripped). */
export type DocumentSection = { document_id: string; key: string; heading: string; text: string; url: string };

/** G2: the gateway's message when no Claude account can take a call (approvers and owners). */
export const NO_ACCOUNT_MESSAGE =
  "No Claude account: an owner adds one on Settings > Claude accounts (or sets a fallback setup-token or API key there)";
/** The mock's canned reply, citing the seed's "Raise activation" goal. */
export const CANNED_REPLY = ["Yes, if caps ", "read the plan thresholds only ", "[c:1]. Detection can follow ", "once activation holds; ", "the goal does not depend on it."];
/** G2 §4: one discussion_research run, the researcher at quick depth (the API's cost table). */
export const RESEARCH_USD = 2;
export const RESEARCH_ANSWER =
  "Teams on the starter plan asked for caps in the last two check-ins [c:1]. Others cap by seat on their starter plans [c:2]. Nothing Oracle can read says detection has to ship first.";
/** The "research-refused" scenario: the runs refuse the first research start (as a spent budget or one build at a time would). */
export const RESEARCH_REFUSED_SCENARIO = "research-refused";
export const RESEARCH_REFUSED = "The company's monthly run budget is spent.";
/** What a commenter or a viewer reads of a refused start (the API's research.START_FAILED): approvers read why. */
export const RESEARCH_START_FAILED = "Oracle couldn't start this research.";
/** The "research-unsafe-link" scenario: the web page the research cites has an address that is not http(s) (#606 re-review). */
export const RESEARCH_UNSAFE_LINK_SCENARIO = "research-unsafe-link";
export const RESEARCH_UNSAFE_LINK = "javascript:alert(document.domain)";
const CANNED_CITATIONS = [{ n: 1, kind: "entity", ref: "g.activation", title: "Goal: Raise activation", url: "/baseline", confidence: 0.82, low_confidence: false }];
/** The web page the mock's research read (read:web): a `web` citation linking to it. */
const RESEARCH_CITATIONS: Record<string, unknown>[] = [
  ...CANNED_CITATIONS,
  { n: 2, kind: "web", ref: "w-1", title: "Caps at Example", url: "https://news.example/caps" },
];
const STOPWORDS = new Set(["what", "when", "where", "which", "does", "this", "that", "draft", "document", "about", "with", "from", "have", "there", "their", "they"]);
const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));

/**
 * #406: the mock's stand-in for the model reading the document. The sentence of the version
 * (the section first, then the rest) that shares the most words with the question, at least
 * two; its citation's marker comes split across two pieces, as a model's often is.
 */
export function documentReply(question: string, sections: DocumentSection[]): { pieces: string[]; citations: Record<string, unknown>[] } | null {
  const asked = words(question);
  let best: { n: number; sentence: string; score: number } | null = null;
  sections.forEach((sec, i) => {
    for (const sentence of sec.text.split(/\n+|(?<=[.!?])\s+/)) {
      if (!sentence.trim() || sentence.trim().startsWith("|")) continue;
      const score = [...words(sentence)].filter((w) => asked.has(w)).length;
      if (score >= 2 && (!best || score > best.score)) best = { n: i + 1, sentence: sentence.trim().replace(/[.!?]$/, ""), score };
    }
  });
  if (!best) return null;
  const { n, sentence } = best as { n: number; sentence: string };
  const sec = sections[n - 1];
  const said = sentence[0].toLowerCase() + sentence.slice(1);
  return {
    pieces: ["The draft says ", `${said} `, "[c:", `${n}]`, ", in ", `“${sec.heading}”.`],
    citations: [{ n, kind: "section", ref: `${sec.document_id}:${sec.key}`, title: sec.heading, url: sec.url }],
  };
}

/** The first piece waits a little ("Oracle is thinking…"), the rest come 150 ms apart. */
const FIRST_MS = 500;
const DELTA_MS = 150;

export const emptyDiscussions = (): DiscussionsDb => ({ discussions: [], participants: [], messages: [], changes: [] });

/** G3: each kind's main action (the registry, G1 §3.3). */
const KIND_VERB: Record<string, ChangeVerb> = {
  item_horizon: "Stage",
  item_outcome: "Stage",
  section_edit: "Stage",
  goal_measure: "Propose",
  entity_edit: "Propose",
  conflict_pick: "Resolve",
  answer: "Use as answer",
  basis_record: "Record",
  priority_move: "Apply",
  priority_pin: "Apply",
  ask_person: "Ask",
};
const VERB_OF_ROUTE: Record<string, ChangeVerb> = {
  stage: "Stage",
  propose: "Propose",
  resolve: "Resolve",
  answer: "Use as answer",
  verify: "Record",
  apply: "Apply",
  ask: "Ask",
};
const VERB_PAST: Record<ChangeVerb, string> = {
  Stage: "staged",
  Propose: "proposed",
  Resolve: "resolved",
  "Use as answer": "answered",
  Record: "recorded",
  Apply: "applied",
  Ask: "asked",
};
/** The kinds each subject offers in the mock, as the API's kinds.available_for does (G1 §3.3). */
const SUBJECT_KINDS: Record<string, string[]> = {
  document: ["section_edit", "answer"],
  section: ["section_edit", "answer"],
  roadmap_item: ["item_horizon", "item_outcome", "basis_record"],
  checkpoint: ["item_horizon", "item_outcome", "conflict_pick"],
  checkpoint_item: ["item_horizon", "item_outcome", "basis_record"],
  entity: ["goal_measure", "entity_edit"],
  conflict: ["conflict_pick"],
  question: ["answer"],
};
const TEXT = { type: "string", minLength: 1 };
const KIND_SCHEMA: Record<string, Record<string, unknown>> = {
  item_horizon: { type: "object", required: ["item_key", "horizon"], properties: { item_key: TEXT, horizon: { enum: ["now", "next", "later"] } } },
  item_outcome: { type: "object", required: ["item_key", "outcome"], properties: { item_key: TEXT, outcome: TEXT } },
  section_edit: { type: "object", required: ["section_key", "instruction"], properties: { section_key: TEXT, instruction: TEXT } },
  goal_measure: { type: "object", required: ["metric", "target"], properties: { metric: TEXT, target: TEXT, horizon: { type: "string" } } },
  entity_edit: { type: "object", properties: {} },
  conflict_pick: { type: "object", required: ["claim_index"], properties: { claim_index: { type: "integer", minimum: 0 } } },
  answer: { type: "object", required: ["body"], properties: { body: TEXT } },
  basis_record: {
    type: "object",
    required: ["prd_document_id", "kind", "reference", "supports_date"],
    properties: { prd_document_id: TEXT, kind: { enum: ["estimate", "capacity", "commitment"] }, reference: TEXT, supports_date: { type: "string", format: "date" }, item_key: { type: "string" } },
  },
};
export const STAGE_WHY_NOT = "Approvers stage changes. You can suggest it.";
const APPROVERS_ACT = "Approvers take this action. You can suggest it.";
/** F3: who has no date rights (oracle.discussions.changes.RECORDERS). */
export const RECORDERS = "Engineering leads and approvers record date bases";
const VIEWERS_READ = "Viewers can read discussions but not write in them";
const STALE = "Someone else changed this since you loaded it; reload and try again";
const HORIZON_LABEL: Record<string, string> = { now: "Now", next: "Next", later: "Later" };
const isOpenStatus = (s: ChangeStatus) => s === "proposed" || s === "suggested";
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A change's plain sentence from its kind and payload. */
export function changeLabel(kind: string, p: Record<string, unknown>): string {
  const clip = (t: string) => (t.length > 100 ? `${t.slice(0, 99)}…` : t);
  const lower = (t: string) => t.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
  if (kind === "item_horizon") return `Move ${str(p.item_key)} to ${HORIZON_LABEL[str(p.horizon)] ?? str(p.horizon)}`;
  if (kind === "item_outcome") return clip(`Set ${str(p.item_key)}'s outcome: ${lower(str(p.outcome))}`);
  if (kind === "section_edit") return clip(`Edit ${str(p.section_key)}: ${lower(str(p.instruction))}`);
  if (kind === "goal_measure") return clip(`Measure the goal by ${str(p.metric)}: ${str(p.target)}${str(p.horizon) ? ` by ${str(p.horizon)}` : ""}`);
  if (kind === "conflict_pick") return `Settle the conflict with claim ${Number(p.claim_index)}`;
  if (kind === "answer") return clip(`Answer: ${str(p.body)}`);
  if (kind === "basis_record") return clip(`Record a date basis: ${str(p.reference)} supports ${str(p.supports_date)}`);
  return kind.replace(/_/g, " ");
}

/** What a payload lacks for its kind, or null. */
function incomplete(kind: string, p: Record<string, unknown>): string | null {
  const required = (KIND_SCHEMA[kind]?.required as string[] | undefined) ?? [];
  return required.some((k) => (kind === "conflict_pick" ? !Number.isInteger(p[k]) : !str(p[k]))) ? "The change is incomplete" : null;
}

/**
 * The 2 changes the canned reply proposes, of the kinds its discussion's subject offers (as the
 * API drops any other): on a section or document, an edit of the section and one of the
 * solution; on an item, a move to Next.
 */
function cannedChanges(d: DiscussionRow, from: string, uuid: () => string, at: string): ChangeRow[] {
  const section = str(d.subject.section_key) || "problem";
  const row = (kind: string, target: Record<string, unknown>, payload: Record<string, unknown>, rationale: string): ChangeRow => ({
    id: uuid(),
    discussion_id: d.id,
    kind,
    label: changeLabel(kind, payload),
    target,
    payload,
    edited_payload: null,
    rationale,
    proposed_by_kind: "oracle",
    proposed_by: null,
    suggested_by: null,
    status: "proposed",
    pushback: null,
    basis: [],
    result_ref: null,
    decision_note: null,
    override_reason: null,
    reason: null,
    from_message_id: from,
    lock_version: 1,
    created_at: at,
  });
  const edit = (key: string, instruction: string, rationale: string) =>
    row("section_edit", { document_id: d.document_id, version: d.subject.version ?? null, section_key: key }, { section_key: key, instruction }, rationale);
  const offered = SUBJECT_KINDS[d.subject_kind] ?? [];
  if (offered.includes("section_edit"))
    return [
      edit(section, "Say that detection follows once activation holds.", "The goal does not depend on detection [c:1]."),
      edit(section === "solution" ? "problem" : "solution", "Read the caps from the plan thresholds.", "Caps can ship on the plan thresholds alone [c:1]."),
    ];
  if (offered.includes("item_horizon"))
    return [row("item_horizon", { document_id: d.document_id, item_key: "usage-caps" }, { item_key: "usage-caps", horizon: "next" }, "Caps can ship on the plan thresholds alone [c:1].")];
  return [];
}

/** Oracle's new proposals replace its open ones of the same kind and target; a person's suggestion stays. */
function addProposals(rows: ChangeRow[], made: ChangeRow[]) {
  for (const c of made) {
    for (const old of rows)
      if (
        old.discussion_id === c.discussion_id &&
        old.kind === c.kind &&
        old.proposed_by_kind === "oracle" &&
        old.status === "proposed" &&
        JSON.stringify(old.target) === JSON.stringify(c.target)
      ) {
        old.status = "superseded";
        old.lock_version += 1;
      }
    rows.push(structuredClone(c));
  }
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

/** "first.last@example.com" -> "First Last" (oracle.members.names). */
export function displayName(email: string): string {
  const words = email.split("@")[0].split(/[._+-]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : email;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, detail: string) => json(status, { detail });


/**
 * The "discussions" scenario: one private discussion the commenter started with the
 * approver on a section of `documentId`, with 3 messages from the 2 of them.
 */
export function seedDiscussions(ctx: Omit<DiscussionsContext, "me" | "db">, documentId: string, label: string, url: string): DiscussionsDb {
  const db = emptyDiscussions();
  const by = (email: string) => ctx.members.find((m) => m.email === email)!.id;
  const commenter = by("commenter@example.com");
  const approver = by("approver@example.com");
  const id = ctx.uuid();
  const at = (min: number) => `2026-10-20T09:${String(min).padStart(2, "0")}:00Z`;
  db.discussions.push({
    id,
    subject_kind: "section",
    subject: { document_id: documentId, version: 2, section_key: "problem" },
    subject_key: `section:${documentId}:problem`,
    subject_label: label,
    subject_url: url,
    document_id: documentId,
    run_id: null,
    title: "Problem: who owns the admin role?",
    visibility: "private",
    author_only: false,
    status: "open",
    origin: "discuss",
    started_by: commenter,
    summary: null,
    summary_status: "none",
    summary_shared: false,
    last_message_at: at(12),
    lock_version: 1,
    created_at: at(0),
    updated_at: at(12),
  });
  for (const [user_id, added_via] of [
    [commenter, "started"],
    [approver, "added"],
  ] as const)
    db.participants.push({ discussion_id: id, user_id, added_via, left_at: null, last_read_at: null, created_at: at(0) });
  const lines: [string, string][] = [
    [commenter, "Should the first admin be whoever creates the workspace?"],
    [approver, "Only if they can hand it over later; otherwise support gets the tickets."],
    [commenter, "Agreed. I'll ask for a handover step in Scope."],
  ];
  lines.forEach(([author, body], i) =>
    db.messages.push({
      id: ctx.uuid(),
      discussion_id: id,
      author_kind: "person",
      author_id: author,
      body,
      mentions: [],
      mentions_oracle: false,
      reply_to: null,
      created_at: at(4 * (i + 1)),
      edited_at: null,
      deleted_at: null,
    }),
  );
  return db;
}

/**
 * G6, the "discussions" scenario only: the commenter's open discussion on the Saved carts PRD.
 * Its first message mentions the viewer (who is invited), the approver replies, then the
 * commenter mentions the approver (already in it); Oracle proposed one change and the
 * commenter suggested another, so 2 wait on the approver.
 */
export function seedDiscussionInbox(ctx: Omit<DiscussionsContext, "me" | "db">, db: DiscussionsDb, documentId: string, label: string, url: string) {
  const by = (email: string) => ctx.members.find((m) => m.email === email)!.id;
  const commenter = by("commenter@example.com");
  const approver = by("approver@example.com");
  const viewer = by("viewer@example.com");
  const id = ctx.uuid();
  const at = (min: number) => `2026-10-21T08:${String(min).padStart(2, "0")}:00Z`;
  db.discussions.push({
    id,
    subject_kind: "document",
    subject: { document_id: documentId, version: 2 },
    subject_key: `document:${documentId}`,
    subject_label: label,
    subject_url: url,
    document_id: documentId,
    run_id: null,
    title: "Saved carts: keep carts for guests?",
    visibility: "open",
    author_only: false,
    status: "open",
    origin: "discuss",
    started_by: commenter,
    summary: null,
    summary_status: "none",
    summary_shared: true,
    last_message_at: at(20),
    lock_version: 1,
    created_at: at(0),
    updated_at: at(20),
  });
  for (const [user_id, added_via] of [
    [commenter, "started"],
    [viewer, "mention"],
    [approver, "posted"],
  ] as const)
    db.participants.push({ discussion_id: id, user_id, added_via, left_at: null, last_read_at: null, created_at: at(0) });
  const lines: [string, string, string[]][] = [
    [commenter, "Viewer, guests lose their cart today. Should we keep it?", [viewer]],
    [approver, "Only with a clear expiry.", []],
    [commenter, "Approver, can guests keep a cart for 30 days?", [approver]],
  ];
  const ids = lines.map(([author, body, mentions], i) => {
    const mid = ctx.uuid();
    db.messages.push({
      id: mid,
      discussion_id: id,
      author_kind: "person",
      author_id: author,
      body,
      mentions,
      mentions_oracle: false,
      reply_to: null,
      created_at: at(10 * i),
      edited_at: null,
      deleted_at: null,
    });
    return mid;
  });
  const item = { discussion_id: id, by_user_id: commenter, done_at: null };
  db.inbox = [
    { ...item, id: ctx.uuid(), user_id: viewer, kind: "invited", message_id: null, created_at: at(0) },
    { ...item, id: ctx.uuid(), user_id: approver, kind: "mentioned", message_id: ids[2], created_at: at(20) },
  ];
  const change = {
    discussion_id: id,
    kind: "section_edit" as const,
    target: { section_key: "scope" },
    edited_payload: null,
    rationale: null,
    proposed_by: null,
    created_at: at(21),
    lock_version: 1,
  };
  db.changes = [
    {
      ...change,
      id: ctx.uuid(),
      label: "Scope: keep a guest's cart for 30 days",
      payload: { section_key: "scope", instruction: "Keep a guest's cart for 30 days." },
      proposed_by_kind: "oracle",
      suggested_by: null,
      status: "proposed",
    },
    {
      ...change,
      id: ctx.uuid(),
      label: "Scope: show the expiry on the cart",
      payload: { section_key: "scope", instruction: "Show the expiry on the cart." },
      proposed_by_kind: "oracle",
      suggested_by: commenter,
      status: "suggested",
    },
  ];
}

/**
 * G6: my discussion rows for GET /v1/inbox, as the API derives them (oracle.discussions.inbox):
 * Invited and Mentioned rows of discussions I can read, and for approvers the changes waiting
 * on them (participants: proposed and suggested; others, of open discussions: suggested).
 */
export function discussionInboxRows(db: DiscussionsDb, members: Member[], me: { id: string; role: Role }, seen: string | null): Schemas["InboxDiscussionItem"][] {
  const name = (id: string | null) => {
    const m = id ? members.find((x) => x.id === id) : undefined;
    return m ? displayName(m.email) : null;
  };
  const active = (d: DiscussionRow) => db.participants.filter((x) => x.discussion_id === d.id && !x.left_at);
  const fresh = (at: string) => (seen === null || at > seen ? "new" : "open") as "new" | "open";
  const link = (d: DiscussionRow) => {
    const [path, ...anchor] = d.subject_url.split("#");
    return `${path}${path.includes("?") ? "&" : "?"}discussion=${d.id}${anchor.length ? `#${anchor.join("#")}` : ""}`;
  };
  const base = (d: DiscussionRow) => {
    const names = active(d).map((p) => name(p.user_id)).filter((n): n is string => !!n);
    return {
      discussion_id: d.id,
      title: d.title,
      visibility: d.visibility,
      subject_label: d.subject_label,
      subject_url: link(d),
      people: names.slice(0, 3),
      people_more: Math.max(names.length - 3, 0),
      can_write: atLeast(me.role, "commenter"),
    };
  };
  const readable = (d: DiscussionRow) => d.visibility === "open" || active(d).some((p) => p.user_id === me.id);
  const out: Schemas["InboxDiscussionItem"][] = [];
  for (const r of db.inbox ?? []) {
    const d = db.discussions.find((x) => x.id === r.discussion_id);
    if (r.user_id !== me.id || !d || !readable(d)) continue;
    const msg = r.message_id ? db.messages.find((x) => x.id === r.message_id) : undefined;
    const by = name(r.by_user_id);
    out.push({
      ...base(d),
      id: `${r.kind === "invited" ? "inv" : "men"}_${r.id}`,
      kind: r.kind,
      by: r.by_user_id && by ? { user_id: r.by_user_id, name: by } : null,
      excerpt: msg ? msg.body.slice(0, 140) : null,
      count: null,
      at: r.created_at,
      state: r.done_at ? "done" : fresh(r.created_at),
    });
  }
  if (atLeast(me.role, "approver")) {
    for (const d of db.discussions) {
      if (!readable(d)) continue;
      const inIt = active(d).some((p) => p.user_id === me.id);
      const waiting = (db.changes ?? []).filter(
        (c) => c.discussion_id === d.id && (c.status === "suggested" || (inIt && c.status === "proposed")),
      );
      if (!waiting.length) continue;
      const at = waiting.map((c) => c.created_at).sort().at(-1)!;
      out.push({ ...base(d), id: `chg_${d.id}`, kind: "changes_proposed", by: null, excerpt: null, count: waiting.length, at, state: fresh(at) });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The "discussion-replies" scenario (G2): the "discussions" seed, plus an open discussion
 * whose Oracle reply failed for want of a Claude account, and one on the Problem whose
 * intake has 2 of the commenter's private findings.
 */
export function seedDiscussionReplies(ctx: Omit<DiscussionsContext, "me" | "db">, documentId: string, label: string, url: string): DiscussionsDb {
  const db = seedDiscussions(ctx, documentId, label, url);
  const commenter = ctx.members.find((m) => m.email === "commenter@example.com")!.id;
  const base = db.discussions[0];
  const at = "2026-10-21T10:00:00Z";
  const open = { visibility: "open" as const, summary_shared: true, created_at: at, updated_at: at };
  const failed: DiscussionRow = { ...base, ...open, id: ctx.uuid(), title: "Caps: ship without detection?", last_message_at: at };
  const notice: DiscussionRow = {
    ...base,
    ...open,
    id: ctx.uuid(),
    title: "Saved addresses: what the intake found",
    last_message_at: null,
    private_findings: { author: commenter, count: 2, intake_id: ctx.uuid() },
  };
  db.discussions.push(failed, notice);
  for (const d of [failed, notice])
    db.participants.push({ discussion_id: d.id, user_id: commenter, added_via: "started", left_at: null, last_read_at: null, created_at: at });
  const asked = ctx.uuid();
  const row = { discussion_id: failed.id, mentions: [], mentions_oracle: false, created_at: at, edited_at: null, deleted_at: null };
  db.messages.push(
    { ...row, id: asked, author_kind: "person", author_id: commenter, body: "Can caps ship without detection?", reply_to: null },
    { ...row, id: ctx.uuid(), author_kind: "oracle", author_id: null, body: "", reply_to: asked, status: "failed", error_reason: "no_account" },
  );
  return db;
}

export async function routeDiscussions(ctx: DiscussionsContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "discussions" && p[1] !== "discussion-changes") return null;
  const { db, me } = ctx;
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const member = (id: string) => ctx.members.find((x) => x.id === id);
  const parts = (d: DiscussionRow) => db.participants.filter((x) => x.discussion_id === d.id);
  const active = (d: DiscussionRow) => parts(d).filter((x) => !x.left_at);
  const isIn = (d: DiscussionRow, user = me.id) => active(d).some((x) => x.user_id === user);
  const starter = (d: DiscussionRow) => d.started_by === me.id;
  const readable = (d: DiscussionRow) => d.visibility === "open" || isIn(d);
  const counted = (d: DiscussionRow) => db.messages.filter((x) => x.discussion_id === d.id && !x.deleted_at && x.author_kind !== "system");
  const exposure = (d: DiscussionRow) => {
    const rows = counted(d);
    return { messages: rows.length, people: new Set(rows.filter((x) => x.author_kind === "person").map((x) => x.author_id)).size };
  };
  const ref = (id: string) => ({ user_id: id, name: displayName(member(id)?.email ?? "someone") });
  const writes = (x?: Member) => !!x && x.status !== "disabled" && atLeast(x.role, "commenter");
  const touch = (d: DiscussionRow) => {
    d.lock_version += 1;
    d.updated_at = ctx.now();
  };

  const changesOf = (d: DiscussionRow) => (db.changes ?? []).filter((c) => c.discussion_id === d.id);
  /** G3: a change as this reader sees it: the kind's action, what else they may do, and whether Stage asks for a reason. */
  const changeOut = (c: ChangeRow, d: DiscussionRow): ChangeOut => {
    const verb = KIND_VERB[c.kind] ?? "Stage";
    const open = isOpenStatus(c.status);
    const writer = atLeast(me.role, "commenter") && readable(d) && d.status === "open";
    const anyWriter = verb === "Propose" || verb === "Ask";
    // Record: F3's date rights decide, not the role (as the API's action_for).
    const records = verb === "Record" ? !!ctx.dateRights?.() : null;
    const allowed = writer && open && (records ?? (anyWriter || atLeast(me.role, "approver")));
    const whyNot =
      allowed || !open ? null : d.status !== "open" ? "This discussion is closed" : verb === "Record" ? RECORDERS : verb === "Stage" ? STAGE_WHY_NOT : APPROVERS_ACT;
    return {
      id: c.id,
      discussion_id: c.discussion_id,
      kind: c.kind,
      label: c.label,
      target: c.target,
      payload: c.payload,
      edited_payload: c.edited_payload,
      rationale: c.rationale,
      proposed_by_kind: c.proposed_by_kind,
      proposed_by: c.proposed_by ? ref(c.proposed_by) : null,
      suggested_by: c.suggested_by ? ref(c.suggested_by) : null,
      status: c.status,
      action: atLeast(me.role, "commenter") ? { verb, allowed, why_not: whyNot } : null,
      can: {
        suggest: writer && c.status === "proposed" && !allowed,
        edit: writer && open,
        withdraw: writer && c.status === "suggested" && c.suggested_by === me.id,
        dismiss: writer && open && atLeast(me.role, "approver"),
      },
      pushback: c.pushback ?? null,
      needs_reason: open && verb === "Stage" && d.visibility === "private",
      basis: c.basis ?? [],
      result_ref: c.result_ref ?? null,
      decision_note: c.decision_note ?? null,
      lock_version: c.lock_version,
      created_at: c.created_at,
    };
  };

  const summary = (d: DiscussionRow): Schemas["DiscussionSummary"] => {
    const s = member(d.started_by);
    const mine = active(d).find((x) => x.user_id === me.id);
    return {
      id: d.id,
      subject_kind: d.subject_kind,
      subject_key: d.subject_key,
      subject_label: d.subject_label,
      subject_url: d.subject_url,
      title: d.title,
      visibility: d.visibility,
      author_only: d.author_only,
      status: d.status,
      origin: d.origin,
      started_by: { ...ref(d.started_by), role: s?.role ?? "viewer" },
      started_on_version: typeof d.subject.version === "number" ? d.subject.version : null,
      message_count: counted(d).length,
      last_message_at: d.last_message_at,
      summary: d.summary,
      summary_status: d.summary_status,
      summary_shared: d.summary_shared,
      changes: {
        proposed: changesOf(d).filter((c) => c.status === "proposed").length,
        suggested: changesOf(d).filter((c) => c.status === "suggested").length,
        staged: changesOf(d).filter((c) => c.status === "staged").length,
      },
      me: {
        participant: !!mine,
        can_write: readable(d) && atLeast(me.role, "commenter"),
        unread: mine ? counted(d).filter((x) => x.author_id !== me.id && (!mine.last_read_at || x.created_at > mine.last_read_at)).length : 0,
      },
      lock_version: d.lock_version,
      created_at: d.created_at,
      updated_at: d.updated_at,
    };
  };
  const out = (d: DiscussionRow): Schemas["DiscussionOut"] => {
    const s = summary(d);
    return {
      ...s,
      subject: d.subject,
      participants: active(d).map((x) => {
        const who = member(x.user_id);
        return { ...ref(x.user_id), role: who?.role ?? "viewer", can_write: writes(who), added_via: x.added_via };
      }),
      me: {
        ...s.me,
        can_manage: starter(d) && readable(d),
        can_research: canResearch(d),
        research_usd: canResearch(d) ? RESEARCH_USD : null,
        ...(d.private_findings?.author === me.id ? { private_findings: { count: d.private_findings.count, intake_id: d.private_findings.intake_id } } : {}),
      },
      exposure: d.visibility === "private" && starter(d) ? exposure(d) : null,
      slack: d.slack ?? null,
    };
  };
  /** Who may post in it (the API's access.can_write): commenters and up who read it. */
  const canWrite = (d: DiscussionRow) => readable(d) && atLeast(me.role, "commenter");
  /** G2 §4: an approver or owner who can write in it, while it is open (as the API's research.can_research). */
  const canResearch = (d: DiscussionRow) => d.status === "open" && canWrite(d) && atLeast(me.role, "approver");
  /** A research run's state: done once its answer is in, failed when it could not start (with why), else running. */
  const researchOf = (x: MessageRow): Schemas["MessageResearch"] | null =>
    x.run_id
      ? x.research_error
        ? { run_id: x.run_id, status: "failed", error: atLeast(me.role, "approver") ? x.research_error : RESEARCH_START_FAILED }
        : { run_id: x.run_id, status: db.messages.some((y) => y.run_id === x.run_id && y.author_kind === "oracle") ? "done" : "running", error: null }
      : null;
  const messageOut = (x: MessageRow): Schemas["DiscussionMessageOut"] => ({
    id: x.id,
    discussion_id: x.discussion_id,
    author_kind: x.author_kind,
    author: x.author_kind === "person" && x.author_id ? ref(x.author_id) : null,
    via: x.via ?? "web",
    body: x.deleted_at ? "" : x.body,
    mentions: x.deleted_at ? [] : x.mentions.map(ref),
    mentions_oracle: x.mentions_oracle,
    reply_to: x.reply_to,
    status: x.status ?? "complete",
    citations: x.author_kind === "system" ? [] : (x.citations ?? []),
    created_at: x.created_at,
    edited_at: x.edited_at,
    deleted: !!x.deleted_at,
    error_reason: x.error_reason ?? null,
    error: x.status === "failed" ? (x.error_reason === "no_account" && atLeast(me.role, "approver") ? (ctx.refusal?.() ?? NO_ACCOUNT_MESSAGE) : "Oracle can't reply right now.") : null,
    pushback: x.pushback ?? null,
    usage: null,
    research: researchOf(x),
  });
  const add = (d: DiscussionRow, user_id: string, added_via: ParticipantRow["added_via"]) => {
    const row = parts(d).find((x) => x.user_id === user_id);
    if (row && !row.left_at) return false;
    if (row) Object.assign(row, { left_at: null, added_via });
    else db.participants.push({ discussion_id: d.id, user_id, added_via, left_at: null, last_read_at: null, created_at: ctx.now() });
    return true;
  };
  const notMember = (ids: string[]) => ids.find((id) => !member(id) || member(id)!.status === "disabled");
  /** Bring in the people not in it yet, as the caller may; a refusal, or null. */
  const bringIn = (d: DiscussionRow, ids: string[], via: ParticipantRow["added_via"]): Response | null => {
    const stranger = notMember(ids);
    if (stranger) return refuse(422, `${stranger} is not a member of this company`);
    const fresh = [...new Set(ids)].filter((id) => !isIn(d, id));
    if (!fresh.length) return null;
    if (d.origin === "panel") return refuse(422, "Share a panel chat with Share as discussion");
    if (d.author_only) return refuse(422, "Share this finding at Summary or above to add people");
    if (d.visibility === "private" && !(starter(d) && isIn(d))) return refuse(422, "Only the starter can add people to a private discussion");
    if (d.visibility === "open" && !atLeast(me.role, "commenter")) return refuse(403, "Viewers can read discussions but not write in them");
    for (const id of fresh) add(d, id, via);
    return null;
  };
  const push = (d: DiscussionRow, x: Omit<MessageRow, "id" | "discussion_id" | "created_at" | "edited_at" | "deleted_at">) => {
    const row: MessageRow = { ...x, id: ctx.uuid(), discussion_id: d.id, created_at: ctx.now(), edited_at: null, deleted_at: null };
    db.messages.push(row);
    d.last_message_at = row.created_at;
    return row;
  };
  const post = (d: DiscussionRow, input: Schemas["DiscussionMessageIn"]): Response => {
    if (input.body.length > 8000) return refuse(422, "A message can be at most 8,000 characters");
    if (!input.body.trim()) return refuse(422, "A message needs some text");
    const mentions = [...new Set(input.mentions ?? [])];
    const refused = bringIn(d, mentions, "mention");
    if (refused) return refused;
    if (d.visibility === "open") add(d, me.id, "posted");
    const row = push(d, {
      author_kind: "person",
      author_id: me.id,
      body: input.body,
      mentions,
      mentions_oracle: !!input.mention_oracle,
      reply_to: input.reply_to ?? null,
    });
    return json(201, messageOut(row));
  };
  /** G2: always while it is just one person; else only when Oracle is addressed. */
  const wantsReply = (d: DiscussionRow, x: MessageRow) => {
    if (x.mentions_oracle || /(^|[^\w@])@oracle\b/i.test(x.body)) return true;
    const people = new Set([
      ...active(d).map((y) => y.user_id),
      ...db.messages.filter((y) => y.discussion_id === d.id && y.author_kind === "person" && y.author_id).map((y) => y.author_id!),
    ]);
    return people.size <= 1;
  };
  const postWithReply = async (d: DiscussionRow, input: Schemas["DiscussionMessageIn"]): Promise<Response> => {
    const res = post(d, input);
    if (!res.ok) return res;
    const message = (await res.json()) as Schemas["DiscussionMessageOut"];
    const row = db.messages.find((x) => x.id === message.id)!;
    const script = wantsReply(d, row) ? (ctx.replyScript?.(d, row) ?? null) : null;
    const reply = wantsReply(d, row)
      ? push(d, {
          author_kind: "oracle",
          author_id: null,
          body: "",
          mentions: [],
          mentions_oracle: false,
          reply_to: row.id,
          status: "pending",
          citations: [],
          ...(script ? { script: script.pieces, script_citations: script.citations } : {}),
        })
      : null;
    if (reply) proposeSectionEdit(d, row);
    return json(201, { message, reply: reply ? messageOut(reply) : null });
  };
  /** G3 in the panel (mock): asked to rewrite or change a section, Oracle proposes a section_edit on it. */
  const proposeSectionEdit = (d: DiscussionRow, x: MessageRow) => {
    if (d.subject_kind !== "section" || !/\b(rewrite|change)\b/i.test(x.body)) return;
    const section_key = String(d.subject.section_key);
    const payload = { section_key, instruction: x.body.trim().slice(0, 2000) };
    (db.changes ??= []).push({
      id: ctx.uuid(),
      discussion_id: d.id,
      kind: "section_edit",
      label: `Change ${section_key}: ${payload.instruction}`,
      target: { document_id: d.subject.document_id, version: d.subject.version, section_key },
      payload,
      edited_payload: null,
      rationale: null,
      proposed_by_kind: "oracle",
      proposed_by: null,
      suggested_by: null,
      status: "proposed",
      pushback: null,
      basis: [],
      result_ref: null,
      decision_note: null,
      override_reason: null,
      reason: null,
      from_message_id: null,
      created_at: ctx.now(),
      lock_version: 1,
    });
  };
  /** GET …/stream: the canned answer in 5 deltas, then citations and done; Stop ends it. */
  const streamReply = (x: MessageRow): Response => {
    const enc = new TextEncoder();
    const event = (name: string, data: unknown) => enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const final = (r: MessageRow) =>
      r.status === "failed" ? event("error", { reason: r.error_reason ?? "failed", message: messageOut(r).error, retry: true }) : event("done", messageOut(r));
    const runs = x.status === "pending";
    if (runs) x.status = "streaming";
    const id = x.id;
    const now = () => (ctx.current?.() ?? db).messages.find((y) => y.id === id) ?? x;
    const write = (change: Partial<MessageRow>) => ctx.persist?.((saved) => Object.assign(saved.messages.find((y) => y.id === id)!, change));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!runs) {
          // Another reader runs it, or it ended: what it has, then its end.
          let sent = 0;
          for (;;) {
            const r = now();
            if (r.body.length > sent) controller.enqueue(event("delta", { text: r.body.slice(sent) }));
            sent = r.body.length;
            if (r.status !== "pending" && r.status !== "streaming") {
              if (r.citations?.length) controller.enqueue(event("citations", r.citations));
              controller.enqueue(final(r));
              break;
            }
            await new Promise((ok) => setTimeout(ok, 500));
          }
          controller.close();
          return;
        }
        // #406: Oracle reads the document the discussion is on; else the canned answer.
        const d = db.discussions.find((y) => y.id === x.discussion_id);
        const asked = [...db.messages].reverse().find((y) => y.discussion_id === x.discussion_id && y.author_kind === "person");
        const read = d && asked ? documentReply(asked.body, ctx.documentText?.(d) ?? []) : null;
        // B6: a goals interview's scripted reply comes first.
        const pieces = x.script ?? read?.pieces ?? CANNED_REPLY;
        const citations = x.script ? (x.script_citations ?? []) : (read?.citations ?? CANNED_CITATIONS);
        let text = "";
        let cited = 0;
        for (const [i, piece] of pieces.entries()) {
          await new Promise((ok) => setTimeout(ok, i === 0 ? FIRST_MS : DELTA_MS));
          if (now().cancel_requested) {
            await write({ status: "cancelled", body: text, cancel_requested: false });
            controller.enqueue(event("done", messageOut({ ...x, status: "cancelled", body: text })));
            controller.close();
            return;
          }
          text += piece;
          controller.enqueue(event("delta", { text: piece }));
          // As the API: a citation is sent as soon as its marker is complete.
          const used = citations.filter((c) => text.includes(`[c:${c.n}]`));
          if (used.length > cited) {
            cited = used.length;
            controller.enqueue(event("citations", used));
          }
          await write({ body: text });
        }
        await write({ status: "complete", body: text, citations });
        controller.enqueue(event("citations", citations));
        // G3: the reply's changes, stored as it ends and sent before done.
        // A panel chat's change comes from G7's stub above (proposeSectionEdit), not the canned two.
        if (d && d.origin !== "panel") {
          const made = cannedChanges(d, id, ctx.uuid, ctx.now());
          if (ctx.persist) await ctx.persist((saved) => addProposals((saved.changes ??= []), made));
          else addProposals((db.changes ??= []), made);
          controller.enqueue(event("changes", made.map((c) => changeOut(c, d))));
        }
        controller.enqueue(event("done", messageOut({ ...x, status: "complete", body: text, citations })));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  };

  // G3: /v1/discussion-changes/{id}[/{action}]
  if (p[1] === "discussion-changes") {
    const c = (db.changes ?? []).find((x) => x.id === p[2]);
    const d = c && db.discussions.find((x) => x.id === c.discussion_id);
    if (!c || !d || (d.author_only && !isIn(d))) return refuse(404, "Change not found");
    if (!readable(d)) return refuse(403, "This discussion is private");
    const step = m === "PATCH" && !p[3] ? "edit" : m === "POST" && p[3] && !p[4] ? p[3] : null;
    if (!step) return null;
    const input = (await body<Record<string, unknown>>()) ?? {};
    if (!atLeast(me.role, "commenter")) return refuse(403, VIEWERS_READ);
    const verb = VERB_OF_ROUTE[step];
    if (verb) {
      if (KIND_VERB[c.kind] !== verb) return refuse(422, "This change does not take this action");
      if (verb === "Record") {
        if (!ctx.dateRights?.()) return refuse(403, RECORDERS);
      } else if (verb !== "Propose" && verb !== "Ask" && !atLeast(me.role, "approver")) return refuse(403, verb === "Stage" ? STAGE_WHY_NOT : APPROVERS_ACT);
    } else if (step === "dismiss" && !atLeast(me.role, "approver")) return refuse(403, "Approvers dismiss changes");
    else if (!["edit", "suggest", "withdraw", "dismiss"].includes(step)) return null;
    if (d.status === "closed") return refuse(409, "This discussion is closed");
    if (input.lock_version !== c.lock_version) return refuse(409, STALE);
    if (!isOpenStatus(c.status)) return refuse(409, "This change was already handled");
    const name = displayName(member(me.id)?.email ?? "someone");
    const line = (said: string) => push(d, { author_kind: "system", author_id: null, body: said, mentions: [], mentions_oracle: false, reply_to: null });
    if (step === "suggest") {
      if (c.status !== "proposed") return refuse(409, "This change is already suggested");
      Object.assign(c, { status: "suggested", suggested_by: me.id });
    } else if (step === "edit") {
      const payload = input.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return refuse(422, "The change is incomplete");
      const gap = incomplete(c.kind, payload as Record<string, unknown>);
      if (gap) return refuse(422, gap);
      c.edited_payload = payload as Record<string, unknown>;
      c.label = changeLabel(c.kind, c.edited_payload);
      if (typeof input.rationale === "string") c.rationale = input.rationale.trim() || null;
      // A commenter's edit becomes their suggestion; an approver's keeps the status.
      if (!atLeast(me.role, "approver")) Object.assign(c, { status: "suggested", suggested_by: me.id });
    } else if (step === "withdraw") {
      if (c.status !== "suggested" || c.suggested_by !== me.id) return refuse(403, "Only the person who suggested it can withdraw it");
      Object.assign(c, { status: c.proposed_by_kind === "oracle" ? "proposed" : "dismissed", suggested_by: null });
    } else if (step === "dismiss") {
      Object.assign(c, { status: "dismissed", decision_note: str(input.note) || null });
    } else if (verb === "Stage") {
      if (c.pushback && !str(input.override_reason)) return refuse(422, "Oracle pushed back on this. Give a reason to stage it anyway.");
      if (d.visibility === "private" && !str(input.reason)) return refuse(422, "Write the reason everyone will see");
      Object.assign(c, {
        status: "staged",
        override_reason: str(input.override_reason) || null,
        reason: d.visibility === "private" ? str(input.reason) : null,
        result_ref: { kind: c.target.run_id ? "checkpoint_action" : "next_draft_change", id: ctx.uuid() },
      });
      line(`${name} staged: ${c.label}`);
    } else if (verb === "Record") {
      // F3's own write: verified for a lead or an owner (an approver while no lead is named), proposed otherwise.
      if (!ctx.recordBasis) return refuse(422, "A basis_record change is not used this way");
      const p = c.edited_payload ?? c.payload;
      const res = await ctx.recordBasis({
        kind: p.kind as Schemas["ScheduleBasisCreate"]["kind"], reference: str(p.reference), supports_date: str(p.supports_date),
        prd: str(p.prd_document_id), item_key: str(p.item_key) || null, detail: str(p.detail) || null,
      });
      if (res.status !== 201) return res;
      const basis = (await res.json()) as { id: string; status: string };
      Object.assign(c, { status: "done", result_ref: { basis_id: basis.id } });
      line(`${name} ${VERB_PAST[verb]}: ${c.label}`);
      c.lock_version += 1;
      return json(200, { change: changeOut(c, d), result: { basis_id: basis.id, status: basis.status } });
    } else if (verb) {
      Object.assign(c, { status: "done", result_ref: { id: ctx.uuid() } });
      line(`${name} ${VERB_PAST[verb]}: ${c.label}`);
    }
    c.lock_version += 1;
    return json(200, { change: changeOut(c, d), result: null });
  }

  // GET/POST /v1/discussions
  if (!p[2]) {
    if (m === "GET") {
      const named = q.get("subject_key") || q.get("document_id") || q.get("run_id");
      const mine = q.get("mine") === "true";
      const rows = db.discussions
        .filter((d) => !q.get("subject_key") || d.subject_key === q.get("subject_key"))
        .filter((d) => !q.get("document_id") || d.document_id === q.get("document_id"))
        .filter((d) => !q.get("run_id") || d.run_id === q.get("run_id"))
        .filter((d) => !q.get("status") || d.status === q.get("status"))
        .filter((d) => !mine || isIn(d))
        .filter((d) => !q.get("origin") || d.origin === q.get("origin"))
        .filter((d) => !(d.author_only && !isIn(d)))
        .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
      const items = rows.flatMap<Schemas["DiscussionSummary"] | Schemas["HiddenDiscussion"]>((d) =>
        readable(d)
          ? [summary(d)]
          : named && !mine
            ? [{ id: d.id, visibility: "private" as const, hidden: true as const, summary: d.summary_shared ? d.summary : null }]
            : [],
      );
      return json(200, { items: items.slice(0, Number(q.get("limit") ?? 50)), next: null });
    }
    if (m === "POST") {
      if (!atLeast(me.role, "commenter")) return refuse(403, "Requires the commenter role");
      const input = await body<Schemas["DiscussionCreate"]>();
      const info = ctx.resolve(input.subject_kind, input.subject ?? {});
      if ("status" in info) return refuse(info.status, info.detail);
      const picked = [...new Set(input.participants ?? [])].filter((id) => id !== me.id);
      const stranger = notMember(picked);
      if (stranger) return refuse(422, `${stranger} is not a member of this company`);
      // G7 "Panel chats": only you, until shared.
      const panel = input.origin === "panel";
      if (panel && (picked.length || input.message?.mentions?.length)) return refuse(422, "A panel chat is just you and Oracle");
      const visibility = panel ? "private" : (input.visibility ?? "open");
      const at = ctx.now();
      const d: DiscussionRow = {
        id: ctx.uuid(),
        subject_kind: input.subject_kind,
        subject: input.subject ?? {},
        subject_key: info.key,
        subject_label: info.label,
        subject_url: info.url,
        document_id: info.document_id ?? null,
        run_id: info.run_id ?? null,
        title: (input.title ?? "").trim() || info.label.slice(0, 200),
        visibility,
        author_only: false,
        status: "open",
        origin: panel ? "panel" : "discuss",
        started_by: me.id,
        summary: null,
        summary_status: "none",
        summary_shared: visibility === "open",
        last_message_at: null,
        lock_version: 1,
        created_at: at,
        updated_at: at,
      };
      db.discussions.push(d);
      add(d, me.id, "started");
      for (const id of picked) add(d, id, visibility === "private" ? "added" : "mention");
      let reply: Schemas["DiscussionMessageOut"] | null = null;
      if (input.message) {
        const res = await postWithReply(d, input.message);
        if (!res.ok) return res;
        reply = ((await res.json()) as Schemas["DiscussionMessagePosted"]).reply ?? null;
      }
      return json(201, { ...out(d), reply });
    }
    return null;
  }

  const d = db.discussions.find((x) => x.id === p[2]);
  if (!d || (d.author_only && !isIn(d))) return refuse(404, "Discussion not found");
  if (!readable(d)) return refuse(403, "This discussion is private");
  const closed = () => d.status === "closed";

  if (!p[3]) {
    if (m === "GET") return json(200, out(d));
    if (m !== "PATCH") return null;
    const patch = await body<Schemas["DiscussionPatch"]>();
    if (patch.lock_version !== d.lock_version) return refuse(409, "Someone else changed this since you loaded it; reload and try again");
    if (patch.status && patch.status !== d.status) {
      if (!(starter(d) || atLeast(me.role, "approver"))) return refuse(403, "Only the starter or an approver can close or reopen it");
      d.status = patch.status;
    }
    const manages = patch.title != null || patch.summary !== undefined || patch.summary_shared != null;
    if ((manages || (patch.visibility && patch.visibility !== d.visibility)) && closed()) return refuse(409, "This discussion is closed");
    if (patch.visibility === "open" && d.visibility === "private") {
      if (!starter(d)) return refuse(403, "Only the starter can make a private discussion open");
      if (d.author_only) return refuse(422, "Share this finding at Summary or above first");
      if (d.origin === "panel") return refuse(422, "Share a panel chat with Share as discussion");
      const now = exposure(d);
      if (!patch.exposes || patch.exposes.messages !== now.messages || patch.exposes.people !== now.people)
        return json(409, { detail: "Confirm what this exposes", ...now });
      d.visibility = "open";
      push(d, {
        author_kind: "system",
        author_id: null,
        body: `${displayName(member(me.id)!.email)} made this discussion open on ${companyDayInWords(ctx.now())}`,
        mentions: [],
        mentions_oracle: false,
        reply_to: null,
      });
    } else if (patch.visibility === "private" && d.visibility === "open") {
      if (!starter(d)) return refuse(403, "Only the starter can make a discussion private");
      const writers = new Set(db.messages.filter((x) => x.discussion_id === d.id).map((x) => x.author_id));
      for (const x of active(d)) if (x.added_via === "followed" && !writers.has(x.user_id)) x.left_at = ctx.now();
      d.visibility = "private";
      d.summary_shared = false;
      // G8: a private discussion never mirrors; the thread gets its closing line, without the link.
      d.slack = null;
    }
    if (manages && !starter(d)) return refuse(403, "Only the starter can change this");
    if (patch.title) d.title = patch.title.trim().slice(0, 200) || d.title;
    if (patch.summary !== undefined) {
      const text = (patch.summary ?? "").trim();
      if (text.length > 1200) return refuse(422, "A summary can be at most 1,200 characters");
      d.summary = text || null;
      d.summary_status = text ? "confirmed" : "none";
    }
    if (patch.summary_shared != null) d.summary_shared = patch.summary_shared;
    touch(d);
    return json(200, out(d));
  }

  const writer = () => {
    if (!atLeast(me.role, "commenter")) return refuse(403, "Viewers can read discussions but not write in them");
    if (closed()) return refuse(409, "This discussion is closed");
    return null;
  };

  if (p[3] === "research" && m === "POST") {
    const refused = writer();
    if (refused) return refused;
    if (!atLeast(me.role, "approver")) return refuse(403, "Approvers and owners start research");
    const { message_id } = await body<Schemas["ResearchIn"]>();
    const asked = db.messages.find((x) => x.id === message_id && x.discussion_id === d.id && !x.deleted_at);
    if (!asked) return refuse(404, "Message not found");
    if (asked.author_kind !== "person") return refuse(422, "Only a person's message can be researched");
    const lines = db.messages.filter((x) => x.reply_to === asked.id && x.author_kind === "system" && x.run_id);
    if (lines.some((x) => researchOf(x)?.status === "running")) return refuse(409, "Oracle is already researching this");
    // The runs refuse the first start in the "research-refused" scenario: the line says why, and the next ask starts.
    const refusal = lines.some((x) => x.research_error) ? null : (ctx.researchRefusal?.() ?? null);
    const line = push(d, {
      author_kind: "system",
      author_id: null,
      body: `${displayName(member(me.id)!.email)} asked Oracle to research this`,
      mentions: [],
      mentions_oracle: false,
      reply_to: asked.id,
      run_id: ctx.uuid(),
      research_reads: 0,
      ...(refusal ? { research_error: refusal } : {}),
    });
    return json(201, messageOut(line));
  }

  if (p[3] === "messages") {
    if (!p[4] && m === "GET") {
      // The mock's research run answers on the thread's second read after it started.
      for (const x of db.messages.filter((y) => y.discussion_id === d.id && y.author_kind === "system" && y.run_id)) {
        if (researchOf(x)?.status !== "running" || (x.research_reads = (x.research_reads ?? 0) + 1) < 2) continue;
        push(d, {
          author_kind: "oracle",
          author_id: null,
          body: RESEARCH_ANSWER,
          mentions: [],
          mentions_oracle: false,
          reply_to: x.reply_to,
          status: "complete",
          citations: RESEARCH_CITATIONS.map((c) => (c.kind === "web" && ctx.researchLink?.() ? { ...c, url: ctx.researchLink() } : c)),
          run_id: x.run_id,
        });
      }
      const rows = db.messages.filter((x) => x.discussion_id === d.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return json(200, { items: rows.map(messageOut), has_more: false });
    }
    if (!p[4] && m === "POST") return writer() ?? postWithReply(d, await body<Schemas["DiscussionMessageIn"]>());
    const row = db.messages.find((x) => x.id === p[4] && x.discussion_id === d.id && !x.deleted_at);
    if (!row) return refuse(404, "Message not found");
    if (row.author_kind === "oracle" && p[5]) {
      if (p[5] === "stream" && m === "GET") return streamReply(row);
      const asked = db.messages.find((x) => x.id === row.reply_to);
      if (!(asked?.author_id === me.id || atLeast(me.role, "approver"))) return refuse(403, "Only the person who asked, or an approver, can");
      if (p[5] === "cancel" && m === "POST") {
        if (row.status === "pending") row.status = "cancelled";
        else if (row.status === "streaming") row.cancel_requested = true;
        return json(200, messageOut(row));
      }
      if (p[5] === "retry" && m === "POST") {
        if (row.status !== "failed" && row.status !== "cancelled") return refuse(409, "Only a failed or stopped reply can be retried");
        Object.assign(row, { status: "pending", body: "", citations: [], error_reason: null, cancel_requested: false });
        return json(200, messageOut(row));
      }
      return null;
    }
    const refused = writer();
    if (refused) return refused;
    if (row.author_kind !== "person" || row.author_id !== me.id) return refuse(403, "Only its author can change a message");
    if (m === "PATCH") {
      const { body: text } = await body<Schemas["DiscussionMessageEdit"]>();
      if (text.length > 8000) return refuse(422, "A message can be at most 8,000 characters");
      Object.assign(row, { body: text, edited_at: ctx.now() });
      return json(200, messageOut(row));
    }
    if (m === "DELETE") {
      Object.assign(row, { body: "", deleted_at: ctx.now() });
      return json(204, null);
    }
    return null;
  }

  if (p[3] === "participants") {
    if (m === "POST" && !p[4]) {
      if (closed()) return refuse(409, "This discussion is closed");
      const { user_ids } = await body<Schemas["DiscussionParticipantsIn"]>();
      if (user_ids.length === 1 && user_ids[0] === me.id && d.visibility === "open") add(d, me.id, "followed");
      else {
        const refused = bringIn(
          d,
          user_ids.filter((id) => id !== me.id),
          "added",
        );
        if (refused) return refused;
      }
      return json(200, out(d).participants);
    }
    if (m === "DELETE" && p[4]) {
      const target = p[4];
      if (target === me.id) {
        if (d.visibility === "private" && starter(d) && !closed())
          return refuse(422, "The starter cannot leave a private discussion while it is open");
      } else if (!(d.visibility === "private" && starter(d))) {
        return refuse(403, "Only the starter can remove people from a private discussion");
      }
      const row = active(d).find((x) => x.user_id === target);
      if (row) row.left_at = ctx.now();
      return json(204, null);
    }
    return null;
  }

  if (p[3] === "read" && m === "POST") {
    const { message_id } = await body<Schemas["DiscussionReadIn"]>();
    const row = db.messages.find((x) => x.id === message_id);
    const mine = active(d).find((x) => x.user_id === me.id);
    if (row && mine && (!mine.last_read_at || mine.last_read_at < row.created_at)) mine.last_read_at = row.created_at;
    // G6: the invitation and the mentions read past are done.
    if (row)
      for (const item of db.inbox ?? []) {
        const at = item.message_id ? db.messages.find((x) => x.id === item.message_id)?.created_at : null;
        if (item.user_id === me.id && item.discussion_id === d.id && !item.done_at && (item.kind === "invited" || (at && at <= row.created_at)))
          item.done_at = ctx.now();
      }
    return json(204, null);
  }
  if (p[3] === "changes" && !p[4]) {
    if (m === "GET") {
      const rows = changesOf(d).filter((c) => !q.get("status") || c.status === q.get("status"));
      return json(200, rows.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => changeOut(c, d)));
    }
    if (m !== "POST") return null;
    const refused = writer();
    if (refused) return refused;
    const input = (await body<{ kind?: string; target?: Record<string, unknown>; payload?: Record<string, unknown>; rationale?: string | null }>()) ?? {};
    const kind = input.kind ?? "";
    if (!(SUBJECT_KINDS[d.subject_kind] ?? []).includes(kind)) return refuse(422, "This kind of change is not available here");
    const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
    const gap = incomplete(kind, payload);
    if (gap) return refuse(422, gap);
    // A commenter's change is their suggestion; an approver's is proposed, ready to stage.
    const approver = atLeast(me.role, "approver");
    const c: ChangeRow = {
      id: ctx.uuid(),
      discussion_id: d.id,
      kind,
      label: changeLabel(kind, payload),
      target: input.target ?? { ...d.subject },
      payload,
      edited_payload: null,
      rationale: str(input.rationale) || null,
      proposed_by_kind: "person",
      proposed_by: me.id,
      suggested_by: approver ? null : me.id,
      status: approver ? "proposed" : "suggested",
      pushback: null,
      basis: [],
      result_ref: null,
      decision_note: null,
      override_reason: null,
      reason: null,
      from_message_id: null,
      lock_version: 1,
      created_at: ctx.now(),
    };
    (db.changes ??= []).push(c);
    return json(201, { change: changeOut(c, d), result: null });
  }
  if (p[3] === "change-kinds" && m === "GET")
    return json(
      200,
      (SUBJECT_KINDS[d.subject_kind] ?? []).map((kind) => ({ kind, verb: KIND_VERB[kind], schema: KIND_SCHEMA[kind] ?? { type: "object" } })),
    );
  if (p[3] === "summary" && m === "POST") {
    const refused = writer();
    if (refused) return refused;
    const input = (await body<{ replace?: boolean }>()) ?? {};
    if (d.summary_status === "confirmed" && !(starter(d) && input.replace))
      return refuse(409, "The starter confirmed this summary. They can ask Oracle for a new draft.");
    const rows = changesOf(d);
    const decided = rows.filter((c) => c.status === "staged" || c.status === "done").map((c) => c.label);
    const open = rows.filter((c) => isOpenStatus(c.status)).map((c) => c.label);
    d.summary = [
      `Decided: ${decided.length ? decided.join("; ") : "nothing yet"}.`,
      `Open: ${open.length ? open.join("; ") : "no open questions"}.`,
      `Context: the team discussed ${d.subject_label}.`,
    ]
      .join("\n")
      .slice(0, 1200);
    d.summary_status = "draft";
    touch(d);
    return json(200, out(d));
  }
  // G7 Share as discussion: a new open discussion on the chat's subject from its edited summary.
  if (p[3] === "share" && m === "POST") {
    if (d.origin !== "panel") return refuse(422, "Only a panel chat is shared as a discussion");
    if (!starter(d)) return refuse(403, "Only the person who started this chat can share it");
    const input = await body<Schemas["DiscussionShareIn"]>();
    if (!input.first_message.trim()) return refuse(422, "A message needs some text");
    const at = ctx.now();
    const shared: DiscussionRow = {
      ...d,
      id: ctx.uuid(),
      title: (input.title ?? "").trim() || d.subject_label.slice(0, 200),
      visibility: "open",
      origin: "discuss",
      summary: null,
      summary_status: "none",
      summary_shared: true,
      last_message_at: null,
      lock_version: 1,
      created_at: at,
      updated_at: at,
    };
    db.discussions.push(shared);
    add(shared, me.id, "started");
    push(shared, { author_kind: "person", author_id: me.id, body: input.first_message.trim(), mentions: [], mentions_oracle: false, reply_to: null });
    // As the API: the chat's open changes, of whatever kind, are copied as suggested by the sharer.
    for (const c of changesOf(d).filter((x) => x.status === "proposed" || x.status === "suggested" || x.status === "staged"))
      db.changes!.push({ ...c, id: ctx.uuid(), discussion_id: shared.id, status: "suggested", suggested_by: me.id, from_message_id: null, decision_note: null, override_reason: null, reason: null, result_ref: null, lock_version: 1, created_at: at });
    return json(201, out(shared));
  }
  if (p[3] === "slack" && !p[4] && ctx.slack) return ctx.slack(d, req);
  return null;
}

/** G5 "run-discussions": the discussion links a run's agents are given open these. */
export const RUN_DISCUSSION_OPEN = "d15c0000-0000-4000-8000-0000000000a1";
export const RUN_DISCUSSION_PRIVATE = "d15c0000-0000-4000-8000-0000000000a2";

/**
 * The "run-discussions" scenario (G5): on the feature-set run's checkpoint, an open discussion
 * the approver started on bulk-address-edit, and a private one the approver started with the
 * owner on saved-addresses (the commenter is not in it), one message each.
 */
export function seedRunDiscussions(
  ctx: Omit<DiscussionsContext, "me" | "db">,
  run: { id: string; label: string; checkpoint_id: string; checkpoint_kind: string },
): DiscussionsDb {
  const db = emptyDiscussions();
  const by = (email: string) => ctx.members.find((m) => m.email === email)!.id;
  const approver = by("approver@example.com");
  const owner = ctx.members.find((m) => m.role === "owner")!.id;
  const at = "2026-10-21T09:00:00Z";
  const row = (id: string, item: string, title: string, visibility: "open" | "private"): DiscussionRow => ({
    id,
    subject_kind: "checkpoint_item",
    subject: { run_id: run.id, checkpoint_id: run.checkpoint_id, checkpoint_kind: run.checkpoint_kind, item_key: item },
    subject_key: `run_item:${run.id}:${run.checkpoint_kind}:${item}`,
    subject_label: `${run.label} · ${item}`,
    subject_url: `/runs/${run.id}`,
    document_id: null,
    run_id: run.id,
    title,
    visibility,
    author_only: false,
    status: "open",
    origin: "discuss",
    started_by: approver,
    summary: null,
    summary_status: "none",
    summary_shared: visibility === "open",
    last_message_at: at,
    lock_version: 1,
    created_at: at,
    updated_at: at,
  });
  const open = row(RUN_DISCUSSION_OPEN, "bulk-address-edit", "Bulk edit: keep it without the export?", "open");
  const hidden = row(RUN_DISCUSSION_PRIVATE, "saved-addresses", "Saved addresses: who pays for storage?", "private");
  db.discussions.push(open, hidden);
  db.participants.push(
    { discussion_id: open.id, user_id: approver, added_via: "started", left_at: null, last_read_at: null, created_at: at },
    { discussion_id: hidden.id, user_id: approver, added_via: "started", left_at: null, last_read_at: null, created_at: at },
    { discussion_id: hidden.id, user_id: owner, added_via: "added", left_at: null, last_read_at: null, created_at: at },
  );
  for (const [d, body] of [
    [open, "Can bulk edit ship before the export does?"],
    [hidden, "Storage costs are still open with finance."],
  ] as const)
    db.messages.push({
      id: ctx.uuid(),
      discussion_id: d.id,
      author_kind: "person",
      author_id: approver,
      body,
      mentions: [],
      mentions_oracle: false,
      reply_to: null,
      created_at: at,
      edited_at: null,
      deleted_at: null,
    });
  return db;
}

/** G3 "discussion-record": the open discussion on a PRD's roadmap item where Oracle proposed recording a date basis. */
export const DISCUSSION_RECORD = "d15c0000-0000-4000-8000-0000000000b1";

/**
 * The "discussion-record" scenario (G3 Record with F3 Date bases): the approver's open
 * discussion on the PRD's guest-checkout item, Oracle's reply, and the basis_record change it
 * proposed (a team estimate that supports 2026-12-15).
 */
export function seedDiscussionRecord(ctx: Omit<DiscussionsContext, "me" | "db">, prd: { id: string; title: string; slug: string }, version: number): DiscussionsDb {
  const db = emptyDiscussions();
  const approver = ctx.members.find((m) => m.email === "approver@example.com")!.id;
  const at = "2026-10-22T10:00:00Z";
  const item = "guest-checkout";
  db.discussions.push({
    id: DISCUSSION_RECORD,
    subject_kind: "roadmap_item",
    subject: { document_id: prd.id, version, item_key: item },
    subject_key: `roadmap_item:${prd.id}:${item}`,
    subject_label: `${prd.title} · ${item}`,
    subject_url: `/documents/${prd.slug}/v/${version}/items`,
    document_id: prd.id,
    run_id: null,
    title: "Guest checkout: what date can we hold?",
    visibility: "open",
    author_only: false,
    status: "open",
    origin: "discuss",
    started_by: approver,
    summary: null,
    summary_status: "none",
    summary_shared: true,
    last_message_at: at,
    lock_version: 1,
    created_at: at,
    updated_at: at,
  });
  db.participants.push({ discussion_id: DISCUSSION_RECORD, user_id: approver, added_via: "started", left_at: null, last_read_at: null, created_at: at });
  const asked = ctx.uuid();
  const reply = ctx.uuid();
  const row = { discussion_id: DISCUSSION_RECORD, mentions: [], created_at: at, edited_at: null, deleted_at: null };
  db.messages.push(
    { ...row, id: asked, author_kind: "person", author_id: approver, body: "@Oracle the team estimated mid-December. Can we hold that date?", mentions_oracle: true, reply_to: null },
    { ...row, id: reply, author_kind: "oracle", author_id: null, body: "The team's estimate supports December 15; record it as the date's basis.", mentions_oracle: false, reply_to: asked, status: "complete" },
  );
  const payload = { prd_document_id: prd.id, kind: "estimate", reference: "Team estimate", supports_date: "2026-12-15", item_key: item };
  db.changes!.push({
    id: ctx.uuid(), discussion_id: DISCUSSION_RECORD, kind: "basis_record", label: changeLabel("basis_record", payload), target: {}, payload,
    edited_payload: null, rationale: "The team estimated the item for mid-December.", proposed_by_kind: "oracle", proposed_by: null,
    suggested_by: null, status: "proposed", from_message_id: reply, lock_version: 1, created_at: at,
  });
  return db;
}
