/**
 * Mock of the requests routes (api/oracle/requests/router.py, C1) for
 * NEXT_PUBLIC_API_MOCKS=1: the request queue with its tab counts and channel facet, a
 * request with what was merged into it, edits, qualify (needs a confirmed goal), merge
 * (to the root, no cycles), disqualify (Other needs a note), reopen, accepting or declining
 * Oracle's suggestion (#348), and themes. It keeps the API's shapes and role rules.
 *
 * It also stands in for Oracle's triage (GET and POST /v1/requests/triage: Classify now
 * starts a run that finishes on its own a few seconds later, suggesting a goal and theme for
 * every New request with none; PUT /v1/requests/triage/daily: the "Daily triage at 07:00 PT"
 * switch, off by default, approver+, and who the daily run acts as while it is on) and for the requests Oracle found in the signed-in person's
 * own sources (GET /v1/request-candidates, file, dismiss). Each found item is its owner's
 * alone; filing one shares the item's title, link and a 400-character excerpt (C1 "Found
 * items"). The mock has no source items: a found item carries that copy itself.
 *
 * Seed: 12 requests over 4 channels, 3 themes, 2 merged, 1 disqualified, 1 with a
 * suggestion, 2 found items for the seed owner. Synthetic placeholders only. The
 * "triage-skipped" scenario (po-mock-scenario) adds the reason Oracle's daily run did not
 * start (no active member to run it as), shown until a run, with the daily triage on.
 *
 * H10 Reasoned no (#515): Disqualify with a basis; a no (every answering reason, and Won't do
 * with a note) captures a decision in the decision log (`ctx.decisions`) and one reply per
 * asker (the request's and each merged into it), drafted by a stand-in for Oracle's
 * `why_not_reply` job a couple of seconds later; the reply routes (edit, mark sent, skip, Tell
 * them in Oracle, draft again, tell them after a Reopen, keep the no); merging into a
 * declined request (asked again); theme problems (confirm, dismiss, edit); the Replies to send
 * filter and the Inbox rows. The "requests-why-not" scenario seeds a request with two merged
 * askers (one a member), a stop choice on its feature and a theme with a suggested problem.
 */
import type { Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";
import { mockUuid } from "./ids";

type Role = "viewer" | "commenter" | "approver" | "owner";
type RequestOut = Schemas["RequestOut"];
type ThemeOut = Schemas["RequestThemeOut"];
type Channel = RequestOut["channel"];
type State = RequestOut["state"];
type Part = Schemas["AcceptSuggestionIn"]["parts"][number];
type Reason = NonNullable<RequestOut["disqualify_reason"]>;
type ReplyOut = Schemas["ReplyOut"];
type Basis = { kind: "goal" | "strategy_choice" | "feature" | "none"; id?: string | null };

/** A reply as stored (H10): the API's row, before the decision number and names are joined. */
export interface ReplyRow extends Omit<ReplyOut, "decision_number" | "sent_by_name" | "drafting"> {
  decision_id: string | null;
  sent_by: string | null;
  /** When Oracle's drafting job started for it; null when no job runs for it. */
  job_at: string | null;
  created_at: string;
}

export type CandidateOut = Schemas["CandidateOut"];

/** Oracle's latest triage run, as the mock keeps it. */
interface TriageRun {
  id: string;
  created_by: string;
  started_at: string;
  finished_at: string | null;
}

/** A request as stored: the API's row, before themes, PRDs and mentions are joined. */
// H10 Reasoned no: what a no adds to a request (decision, basis, asked again, replies);
// optional on stored rows, defaulted by out(). Lane 2 fills them in the requests-why-not scenario.
type H10Fields = "asked_again" | "replies" | "decision_number" | "decision_title" | "decision_status" | "basis" | "no_reply_reason";
interface Row extends Omit<RequestOut, "theme" | "document" | "intake" | "mentions" | "source" | H10Fields> {
  theme_id: string | null;
  document_id: string | null;
  source: RequestOut["source"];
  /** The decision a no captured (kept after a Reopen, reversed). */
  decision_id?: string | null;
  basis_in?: Basis | null;
  asked_again_since?: string | null;
}

type Theme = Omit<ThemeOut, "request_count" | "archived" | "problem_state"> & {
  problem_state?: ThemeOut["problem_state"];
};

export interface RequestsDb {
  requests: Row[];
  themes: Theme[];
  candidates: CandidateOut[];
  triage?: TriageRun | null;
  /** "Daily triage at 07:00 PT": who last turned it on or off, and when; absent is off. */
  daily?: { on: boolean; by: string; at: string } | null;
  /** H10: the replies to the people who asked for a request said no to. */
  replies?: ReplyRow[];
}

/** The decision log, as the requests mock records a no in it (./decisions.ts). */
export interface RequestDecisions {
  capture: (input: { title: string; question: string; rationale: string; entity_ids: string[]; request_id: string; request_title: string }) => { id: string; number: number };
  get: (id: string) => { number: number; title: string; status: string; approver_id: string | null } | null;
  /** Reopen: the decision is reversed, reviewed by the person who reopened. */
  reverse: (id: string, note: string) => void;
  /** Keep the no: a reaffirmed review. */
  reaffirm: (id: string, note: string) => void;
}

interface Person {
  id: string;
  email: string;
  role: Role;
  disabled_at?: string | null;
  created_at: string;
}

interface GoalRef {
  id: string;
  key: string;
  title: string;
  status: string;
}

interface DocumentRef {
  id: string;
  slug: string;
  title: string;
  latest_version: number | null;
  sections: number;
  reviewed_sections: number;
}

export interface RequestsContext {
  userId: string;
  role: Role;
  /** Baseline goals; only confirmed ones link to requests and themes. */
  goals: () => GoalRef[];
  /** Baseline features (not rejected). */
  features: () => { id: string; key: string; title: string }[];
  /** PRDs a request may link to, with their review progress. */
  documents: () => DocumentRef[];
  /** The company's members: whom the daily triage runs as (none when not given). */
  people?: () => Person[];
  /** Baseline entities and edges: stop choices and what they affect (H10 basis). */
  entities?: () => { id: string; type: string; title: string; status: string; attrs?: Record<string, unknown> | null }[];
  edges?: () => { src_id: string; dst_id: string; type: string; status: string }[];
  decisions?: RequestDecisions;
  /** The Company time zone. */
  zone?: () => string;
  /** C1 lane 2: a brief's title by its id; null when it is gone. */
  intakeTitle?: (id: string) => string | null;
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const STATES: State[] = ["new", "qualified", "merged", "disqualified"];
const CHANNELS: Channel[] = ["support", "sales", "team", "interview", "slack", "meeting", "doc", "other", "in_app"];
const REASONS: Reason[] = ["no_goal", "out_of_scope", "duplicate", "not_a_request", "wont_do", "other", "strategy_stop", "already_exists", "few_customers"];
// H10 (api/oracle/requests/replies.py): the reasons that answer the asker, the basis each takes.
const ANSWERING: Reason[] = ["no_goal", "out_of_scope", "strategy_stop", "already_exists", "few_customers", "other"];
const HOUSEKEEPING: Reason[] = ["duplicate", "not_a_request"];
const BASIS_KINDS: Record<Reason, Basis["kind"][]> = {
  no_goal: ["goal", "none"], out_of_scope: ["strategy_choice", "none"], strategy_stop: ["strategy_choice"],
  already_exists: ["feature"], few_customers: ["none"], wont_do: ["none"], other: ["none"], duplicate: ["none"], not_a_request: ["none"],
};
const BASIS_NEEDED: Partial<Record<Reason, string>> = { strategy_stop: "Pick the stop choice", already_exists: "Pick the feature" };
const REASON_TITLE: Record<Reason, string> = {
  no_goal: "Serves no goal", out_of_scope: "Outside what the product does", strategy_stop: "On the stop list",
  already_exists: "Already possible", few_customers: "Too few would use it", wont_do: "Won't do", other: "Other",
  duplicate: "Duplicate", not_a_request: "Not a request",
};
const UNNAMED = "Unnamed asker";
const WORDS_MAX = 160;
const REPLY_MAX = 2000;
/** How long the mock's why_not_reply job takes. */
const DRAFT_MS = 2_000;
const ASKED_AGAIN_THRESHOLD = 3;
export const WHY_NOT_SCENARIO = "requests-why-not";
const DONE_REPLY: ReplyOut["status"][] = ["sent", "notified", "skipped", "withdrawn"];

const isNo = (reason: string | null | undefined, note: string | null | undefined) =>
  !!reason && (ANSWERING.includes(reason as Reason) || (reason === "wont_do" && !!(note ?? "").trim()));

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// The API's promise check (replies.promise_warnings): a date, "later", "soon", "next quarter", "on the roadmap".
// Whole words (a hyphen or slash joins a word), a day without a year is a month and a day ("24/7" is not a date),
// and the asker's own words quoted back are theirs, not a promise.
const PROMISES = new RegExp(
  "(?<![\\w/-])(?:later|soon|someday|eventually|next (?:week|month|quarter|year|release|sprint)|on (?:the|our) roadmap|in the (?:near )?future|coming (?:weeks|months)" +
    `|q[1-4]|h[12] 20\\d\\d|20\\d\\d-\\d\\d-\\d\\d|\\d{1,2}/\\d{1,2}/\\d{2,4}|(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\\d|3[01])|${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)? ${MONTH}|(?:by|in|until) ${MONTH})(?![\\w/-])`,
  "i",
);
const QUOTED = /"([^"\n]{1,2000})"|\u201c([^\u201d\n]{1,2000})\u201d/g;
const plain = (text: string) => text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
export const promiseWarnings = (body: string | null | undefined, asked?: string | null): ReplyOut["warnings"] => {
  if (!body) return [];
  const said = plain(asked ?? "");
  const theirs = (all: string, a?: string, b?: string) => {
    const quote = plain(a ?? b ?? "").replace(/…+$/, "").trim();
    return said && quote && said.includes(quote) ? " " : all;
  };
  return PROMISES.test(body.replace(QUOTED, theirs)) ? ["sounds_like_a_promise"] : [];
};

/** Today (YYYY-MM-DD) in `zone`. */
function todayIn(zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const n = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${n("year")}-${n("month")}-${n("day")}`;
}
const OWNER_NAMES_REQUESTER = "Only an owner files a request in someone else's name";
const NEEDS_GOAL = "Link a confirmed goal first, or disqualify it as 'No goal'";
/** How long the mock's triage run takes. */
const TRIAGE_MS = 3_000;
const EXCERPT_MAX = 400;
const SKIPPED_SCENARIO = "triage-skipped";
const SKIPPED =
  "Oracle's daily triage did not run on 2026-10-22: it runs as the approver who turned it on or else an owner, and none of them is an active member";

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });
const forbidden = (min: Role) => fail(403, `Requires the ${min} role`);
const stale = () => fail(409, "Someone else changed this since you loaded it; reload and try again");

function excerpt(text: string | null): string | null {
  const flat = (text ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!flat) return null;
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

/** The seeded company's requests; none for a company with no confirmed goal yet. */
export function seedRequests(input: { ownerId: string; goals: { id: string }[]; features: { id: string }[] }): RequestsDb {
  const db: RequestsDb = { requests: [], themes: [], candidates: [] };
  if (input.goals.length === 0) return db;
  const g0 = input.goals[0].id;
  const g1 = (input.goals[1] ?? input.goals[0]).id;
  const feature = input.features[0]?.id ?? null;
  const theme = (title: string, goal_ids: string[], days: number): Theme => ({
    id: mockUuid(), title, description: null, goal_ids, origin: "person", archived_at: null,
    created_by: input.ownerId, created_at: daysAgo(days), updated_at: daysAgo(days), lock_version: 1,
  });
  const checkout = theme("Faster check-out", [g0], 30);
  const sharing = theme("Team sharing", [g1], 28);
  const reporting = theme("Reporting", [], 25);
  db.themes.push(checkout, sharing, reporting);

  const add = (days: number, title: string, channel: Channel, extra: Partial<Row> = {}): Row => {
    const row: Row = {
      id: mockUuid(), title, body: null, channel, origin: channel === "interview" ? "interview" : "person",
      requester_name: null, requester_kind: "unknown", verified: channel !== "interview", state: "new",
      merged_into_id: null, disqualify_reason: null, decision_note: null, theme_id: null, goal_ids: [],
      feature_id: null, document_id: null, intake_id: null, interview_id: null, source: null, suggestion: null,
      filed_by: input.ownerId, decided_by: null, decided_at: null, created_at: daysAgo(days),
      updated_at: daysAgo(days), lock_version: 1, ...extra,
    };
    db.requests.push(row);
    return row;
  };
  const decided = { decided_by: input.ownerId, decided_at: daysAgo(2) };
  const address = add(20, "Keep the delivery address between orders", "support", {
    body: "Returning buyers retype their address at every order.", requester_name: "A buyer at a retail customer",
    requester_kind: "customer", state: "qualified", theme_id: checkout.id, goal_ids: [g0], feature_id: feature, ...decided,
  });
  add(15, "Remember my address", "sales", { requester_kind: "customer", state: "merged", merged_into_id: address.id, ...decided });
  add(4, "Address autofill at check-out", "slack", { requester_kind: "team", state: "merged", merged_into_id: address.id, ...decided });
  add(18, "Invite a whole team at once", "support", { state: "qualified", theme_id: sharing.id, goal_ids: [g1], ...decided });
  add(12, "Share a board read-only", "sales", { requester_kind: "customer", state: "qualified", theme_id: sharing.id, goal_ids: [g1], ...decided });
  add(10, "Weekly summary email", "support", { state: "qualified", theme_id: reporting.id, goal_ids: [g0], ...decided });
  add(6, "Pay by bank transfer", "interview", { body: "We pay suppliers by transfer; cards are a problem for us.", requester_kind: "customer" });
  add(3, "Save my card for the next order", "support", {
    body: "Asked twice in the support channel this month.", requester_kind: "customer",
    suggestion: {
      theme_id: checkout.id, theme_title: checkout.title, goal_ids: [g0], duplicate_of: null, feature_id: feature,
      confidence: 0.72, rationale: "Same need as saved addresses: less typing at every order", run_id: null, at: daysAgo(1), accepted: [],
    },
  });
  add(2, "Dark mode", "slack", { requester_kind: "team" });
  add(5, "Export orders to a spreadsheet", "sales", { theme_id: reporting.id });
  add(1, "Bulk edit prices", "support", { requester_name: "A shop owner", requester_kind: "customer" });
  add(22, "A custom domain for the shop", "interview", {
    requester_kind: "customer", state: "disqualified", disqualify_reason: "out_of_scope",
    decision_note: "Hosting is not part of the product", ...decided,
  });

  const found = (days: number, title: string, channel: CandidateOut["channel"], item: string, text: string): CandidateOut => ({
    id: mockUuid(), owner_user_id: input.ownerId, run_id: null, title, body: null, requester_name: "A customer", channel,
    theme_title: checkout.title, goal_ids: [g0], confidence: 0.6, rationale: "A request, not a bug report",
    status: "open", request_id: null, created_at: daysAgo(days), updated_at: daysAgo(days),
    source: { item_id: mockUuid(), title: item, url: `https://chat.example.com/archives/C1/p${days}`, kind: "slack", excerpt: excerpt(text) },
  });
  db.candidates.push(
    found(1, "Reorder last week's basket", "support", "#support thread",
      "Could I reorder what I bought last week in one click? I order the same things every Monday and build the basket again by hand each time."),
    found(2, "Pick a delivery slot", "slack", "#sales notes",
      "Two prospects asked whether buyers can choose a delivery slot at check-out. Both said it would decide whether they switch this quarter."),
  );
  return db;
}

/**
 * The "requests-why-not" scenario (H10): a New request with two merged askers, one of them a
 * member who asked in the app in their own name, on a feature a stop choice affects (the
 * server adds the stop choice); three more New requests to say no to or merge; a theme with
 * a problem Oracle suggested; and a request Oracle suggests saying no to. Made-up askers only.
 */
export function seedWhyNot(db: RequestsDb, input: { ownerId: string; member: { id: string; name: string }; featureId: string | null }) {
  const theme: Theme = {
    id: mockUuid(), title: "Board exports", description: null, goal_ids: [], origin: "oracle", archived_at: null,
    created_by: input.ownerId, created_at: daysAgo(9), updated_at: daysAgo(9), lock_version: 1, problem: null, success: null,
    constraints: null, problem_state: "suggested", problem_confirmed_at: null,
    problem_suggestion: {
      problem: "Finance leads need every board's totals in their own spreadsheet each month, and copy them by hand, one board at a time.",
      success: "A month-end report takes minutes, not an afternoon.",
      constraints: null,
    },
  };
  db.themes.push(theme);
  const add = (days: number, title: string, channel: Channel, extra: Partial<Row> = {}): Row => {
    const row: Row = {
      id: mockUuid(), title, body: null, channel, origin: "person", requester_name: null, requester_kind: "unknown", verified: true,
      state: "new", merged_into_id: null, disqualify_reason: null, decision_note: null, theme_id: null, goal_ids: [], feature_id: null,
      document_id: null, intake_id: null, interview_id: null, source: null, suggestion: null, filed_by: input.ownerId, decided_by: null,
      decided_at: null, created_at: daysAgo(days), updated_at: daysAgo(days), lock_version: 1, ...extra,
    };
    db.requests.push(row);
    return row;
  };
  const root = add(9, "Export every board at once", "sales", {
    body: "Can we export all boards at once?", requester_name: "An ops lead at a customer", requester_kind: "customer",
    theme_id: theme.id, feature_id: input.featureId,
  });
  const merged = { state: "merged" as const, merged_into_id: root.id, decided_by: input.ownerId, decided_at: daysAgo(3), theme_id: theme.id };
  add(8, "Bulk export to a spreadsheet", "support", { requester_name: "A finance manager at a shop", requester_kind: "customer", ...merged });
  add(7, "Download all my boards", "in_app", { requester_name: input.member.name, requester_kind: "team", filed_by: input.member.id, ...merged });
  add(6, "Print a board as a poster", "support", { requester_name: "A teacher at a school", requester_kind: "customer" });
  add(5, "Animated board backgrounds", "slack", { requester_kind: "team" });
  add(4, "Export one board to CSV", "slack", { requester_name: "A support lead at a studio", requester_kind: "customer", theme_id: theme.id });
  add(3, "Seasonal board colours", "support", {
    requester_name: "A shop assistant", requester_kind: "customer",
    suggestion: {
      theme_id: null, theme_title: null, goal_ids: [], duplicate_of: null, feature_id: null, confidence: 0.6,
      rationale: "Asked once this year", run_id: null, at: daysAgo(1), accepted: [],
      decline: { reason: "few_customers", basis: { kind: "none" }, why: "One person has asked for it in a year" },
    },
  });
}

/**
 * C3: a need from a customer interview's snapshot, filed as a request: New, channel and origin
 * Interview, the customer's name as given, unverified, linked to the interview and to its
 * intake or theme (oracle.requests.service). Returns its id.
 */
export function addInterviewRequest(
  db: RequestsDb,
  input: { title: string; body: string; requester_name: string; interview_id: string; intake_id: string | null; theme_id: string | null },
): string {
  const at = now();
  const row: Row = {
    id: mockUuid(), title: input.title, body: input.body, channel: "interview", origin: "interview",
    requester_name: input.requester_name, requester_kind: "customer", verified: false, state: "new",
    merged_into_id: null, disqualify_reason: null, decision_note: null, theme_id: input.theme_id, goal_ids: [],
    feature_id: null, document_id: null, intake_id: input.intake_id, interview_id: input.interview_id, source: null,
    suggestion: null, filed_by: null, decided_by: null, decided_at: null, created_at: at, updated_at: at, lock_version: 1,
  };
  db.requests.push(row);
  return row.id;
}

/**
 * The daily triage's switch: off unless someone turned it on (the "triage-skipped" scenario has
 * it on with no one to run as). While on it runs as whoever turned it on, while an active
 * approver or owner, else as the longest-standing active owner.
 */
function dailyStatus(db: RequestsDb, ctx: RequestsContext, scenario: boolean) {
  const people = ctx.people?.() ?? [];
  const name = (id: string | undefined) => {
    const person = people.find((x) => x.id === id);
    return person ? displayName(person.email) : null;
  };
  if (!db.daily) return { daily_on: scenario, daily_as: null, daily_changed_by: null, daily_changed_at: null };
  const active = people.filter((x) => !x.disabled_at);
  const enabler = active.find((x) => x.id === db.daily?.by && atLeast(x.role, "approver"));
  const owner = active.filter((x) => x.role === "owner").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  const member = enabler ?? owner;
  return {
    daily_on: db.daily.on,
    daily_as: db.daily.on && member ? displayName(member.email) : null,
    daily_changed_by: name(db.daily.by),
    daily_changed_at: db.daily.at,
  };
}

/** The request mock's routes; null when the path is not one of them. */
export async function routeRequests(db: RequestsDb, ctx: RequestsContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[0] !== "v1" || !["requests", "request-themes", "request-candidates", "request-replies"].includes(p[1])) return null;
  const m = req.method;
  const body = async <T>() => (JSON.parse((await req.text()) || "null") ?? {}) as T;
  const confirmed = new Set(ctx.goals().filter((g) => g.status === "confirmed").map((g) => g.id));
  const badGoals = (ids: string[] | null | undefined) => (ids ?? []).filter((id) => !confirmed.has(id));
  const liveTheme = (id: string) => db.themes.find((t) => t.id === id && !t.archived_at);
  const byTitle = (title: string) => db.themes.find((t) => !t.archived_at && t.title.toLowerCase() === title.trim().toLowerCase());

  const parents = () => new Map(db.requests.filter((r) => r.merged_into_id).map((r) => [r.id, r.merged_into_id!]));
  const descendants = (id: string): Row[] => {
    const out: Row[] = [];
    const stack = db.requests.filter((r) => r.merged_into_id === id);
    while (stack.length) {
      const r = stack.pop()!;
      if (out.includes(r) || r.id === id) continue;
      out.push(r);
      stack.push(...db.requests.filter((x) => x.merged_into_id === r.id));
    }
    return out;
  };
  const rootOf = (id: string): string | null => {
    const up = parents();
    const seen = new Set([id]);
    let at = id;
    while (up.has(at)) {
      at = up.get(at)!;
      if (seen.has(at)) return null;
      seen.add(at);
    }
    return at;
  };
  const out = (r: Row): RequestOut => {
    const { theme_id, document_id, ...rest } = r;
    const theme = theme_id ? db.themes.find((t) => t.id === theme_id) : undefined;
    const doc = document_id ? ctx.documents().find((d) => d.id === document_id) : undefined;
    const { decision_id, basis_in, asked_again_since, ...shown } = rest;
    void asked_again_since;
    // Only a standing no shows: a decision reversed on Reopen stays off a later decline.
    const logged = decision_id ? ctx.decisions?.get(decision_id) : null;
    const decision = r.state === "disqualified" && logged?.status === "decided" ? logged : null;
    const own = rootReplies(r);
    const reason = r.state === "disqualified" ? r.disqualify_reason : null;
    return {
      ...shown,
      decision_number: decision?.number ?? null,
      decision_title: decision?.title ?? null,
      decision_status: decision?.status ?? null,
      basis: basis_in && basis_in.kind !== "none" ? { kind: basis_in.kind, id: basis_in.id ?? null, title: entity(basis_in.id)?.title ?? null } : null,
      asked_again: askedAgain(r),
      replies: { total: own.length, open: own.filter((x) => x.status === "drafted").length },
      no_reply_reason: !reason ? null : HOUSEKEEPING.includes(reason) ? "housekeeping" : isNo(reason, r.decision_note) ? null : "no_note",
      loop_closed_on: shown.loop_closed_on ?? null,
      theme: theme ? { id: theme.id, title: theme.title } : null,
      document: doc ? { id: doc.id, slug: doc.slug, title: doc.title } : null,
      intake: r.intake_id && ctx.intakeTitle?.(r.intake_id) ? { id: r.intake_id, title: ctx.intakeTitle(r.intake_id)! } : null,
      mentions: 1 + descendants(r.id).length,
    };
  };
  const themeOut = (t: Theme): ThemeOut => ({
    ...t,
    problem: t.problem ?? null,
    success: t.success ?? null,
    constraints: t.constraints ?? null,
    problem_suggestion: t.problem_suggestion ?? null,
    problem_state: t.problem_state ?? "none",
    archived: !!t.archived_at,
    request_count: db.requests.filter((r) => r.theme_id === t.id && r.state !== "merged").length,
  });
  const decide = (r: Row) => {
    r.decided_by = ctx.userId;
    r.decided_at = now();
  };
  const bump = (r: Row | Theme) => {
    r.lock_version += 1;
    r.updated_at = now();
  };

  // --- H10 Reasoned no ---------------------------------------------------------------------
  const replies = (db.replies ??= []);
  const zone = ctx.zone?.() ?? "America/Los_Angeles";
  const entity = (id: string | null | undefined) => (id ? ctx.entities?.().find((e) => e.id === id) : undefined);
  const nameOf = (id: string | null | undefined) => {
    const person = ctx.people?.().find((x) => x.id === id);
    return person ? displayName(person.email) : null;
  };
  const isMine = (r: Row) => !!r.filed_by && r.filed_by === ctx.userId;
  // Approvers and owners, and the member who filed the request (h10-reply-senders).
  const mayAct = (root: Row) => atLeast(ctx.role, "approver") || (atLeast(ctx.role, "commenter") && isMine(root));
  const askedAgain = (r: Row) =>
    r.state === "disqualified" && r.asked_again_since
      ? descendants(r.id).filter((d) => d.decided_at && d.decided_at > r.asked_again_since!).length
      : 0;
  const rootReplies = (r: Row) => replies.filter((x) => x.root_request_id === r.id && x.decision_id === (r.decision_id ?? null));
  const reasonSentence = (r: Row, basisTitle: string | null) => {
    const reason = r.disqualify_reason!;
    if (reason === "no_goal") {
      const goals = ctx.goals().filter((g) => g.status === "confirmed").map((g) => g.title);
      return goals.length ? `the company is focused on ${goals.slice(0, 3).join(", ")} now, and this does not move it` : "it does not serve what the company is focused on now";
    }
    if (reason === "out_of_scope") return basisTitle ? `the product focuses on ${basisTitle}, and this sits outside it` : "it sits outside what the product does";
    if (reason === "strategy_stop") return `the company has chosen to stop work on ${basisTitle ?? "this kind of work"}`;
    if (reason === "already_exists") return "you can already do this today";
    if (reason === "few_customers") {
      const n = 1 + descendants(r.id).length;
      return `so far ${n} ${n === 1 ? "person has" : "people have"} asked for it, too few for us to build it well`;
    }
    const text = (r.decision_note ?? "").split(/\s+/).filter(Boolean).join(" ").replace(/\.$/, "");
    return text ? text[0].toLowerCase() + text.slice(1) : "it is not something we will build";
  };
  // The template draft (free), and what the stand-in for Oracle's model writes.
  const draft = (root: Row, reply: ReplyRow, source: "oracle" | "template") => {
    const basis = entity(root.basis_in?.id);
    const words = reply.asked ?? "";
    if (reply.kind === "reopened") return `Thanks again for asking for "${words}". We are looking at it again. We will let you know what we decide.`;
    const sentence = reasonSentence(root, basis?.title ?? null);
    const alt = root.basis_in?.kind === "feature" && basis ? ` You can already do this with ${basis.title}.` : "";
    if (source === "template") return `Thanks for asking for "${words}". We've decided not to build it: ${sentence}.${alt}`;
    return `You asked for "${words}", and we've decided not to build it. The reason: ${sentence}.${alt} Thank you for telling us what you need.`;
  };
  // The why_not_reply job ends DRAFT_MS after it starts: each reply it drafts gets Oracle's words.
  const settle = () => {
    for (const reply of replies.filter((x) => x.job_at && Date.now() - Date.parse(x.job_at) >= DRAFT_MS)) {
      const root = db.requests.find((r) => r.id === reply.root_request_id);
      reply.job_at = null;
      if (!root || reply.status !== "drafted") continue;
      reply.body = draft(root, reply, "oracle");
      reply.draft_source = "oracle";
      reply.warnings = promiseWarnings(reply.body, reply.asked);
      reply.lock_version += 1;
    }
  };
  settle();
  const asker = (r: Row) => {
    const me = r.filed_by ? nameOf(r.filed_by) : null;
    const member = r.channel === "in_app" && !!r.filed_by && !!r.requester_name && r.requester_name === me;
    return { asker: r.requester_name || UNNAMED, member_id: member ? r.filed_by : null };
  };
  const addReply = (root: Row, asked: Row, kind: ReplyOut["kind"]): ReplyRow => {
    const reply: ReplyRow = {
      id: mockUuid(), request_id: asked.id, root_request_id: root.id, kind, decision_id: root.decision_id ?? null,
      ...asker(asked), asker_kind: asked.requester_kind, channel_asked: asked.channel,
      asked: asked.title.length > WORDS_MAX ? `${asked.title.slice(0, WORDS_MAX - 1)}…` : asked.title,
      body: null, draft_source: null, warnings: [], status: "drafted", channel: null, sent_on: null, sent_by: null,
      skip_reason: null, notified_at: null, opened_at: null, job_at: now(), created_at: now(), lock_version: 1,
    };
    replies.push(reply);
    return reply;
  };
  // Loop closed: every reply of the no is Sent, Told, Skipped or Withdrawn.
  const updateLoop = (root: Row) => {
    const own = rootReplies(root).filter((x) => x.kind === "no");
    root.loop_closed_on = own.length && own.every((x) => DONE_REPLY.includes(x.status)) ? (root.loop_closed_on ?? todayIn(zone)) : null;
  };
  const replyOut = (x: ReplyRow): ReplyOut => {
    const { decision_id, sent_by, job_at, created_at, ...rest } = x;
    void created_at;
    return {
      ...rest,
      decision_number: decision_id ? (ctx.decisions?.get(decision_id)?.number ?? null) : null,
      sent_by_name: nameOf(sent_by),
      // While the job runs, also on Draft again over words already there.
      drafting: !!job_at && x.status === "drafted" && x.draft_source !== "person",
    };
  };
  const suggestedBasis = (r: Row): Record<string, Schemas["BasisOut"]> => {
    const feature = entity(r.feature_id);
    if (!feature) return {};
    const out: Record<string, Schemas["BasisOut"]> = { already_exists: { kind: "feature", id: feature.id, title: feature.title } };
    const stop = (ctx.edges?.() ?? [])
      .filter((e) => e.dst_id === feature.id && e.type === "affects" && e.status === "confirmed")
      .map((e) => entity(e.src_id))
      .filter((e) => e && e.type === "strategy_choice" && e.status === "confirmed" && e.attrs?.stance === "stop")
      .sort((a, b) => a!.title.localeCompare(b!.title))[0];
    if (stop) out.strategy_stop = { kind: "strategy_choice", id: stop.id, title: stop.title };
    return out;
  };

  // --- requests ---------------------------------------------------------------------
  if (p[1] === "requests" && p.length === 2) {
    if (m === "GET") {
      const state = q.get("state");
      const theme = q.get("theme_id");
      const goal = q.get("goal_id");
      const channel = q.get("channel");
      const text = q.get("q")?.trim().toLowerCase();
      const limit = Number(q.get("limit") ?? 50);
      const offset = Number(q.get("offset") ?? 0);
      if (!(limit >= 1 && limit <= 200) || !(offset >= 0)) return fail(422, "limit is 1-200, offset 0 or more");
      const tests: Record<string, (r: Row) => boolean> = {};
      if (state) tests.state = (r) => r.state === state;
      if (theme) tests.theme = (r) => (theme === "none" ? r.theme_id === null : r.theme_id === theme);
      if (goal) tests.goal = (r) => r.goal_ids.includes(goal);
      if (channel) tests.channel = (r) => r.channel === channel;
      const intakeId = q.get("intake_id");
      if (intakeId) tests.intake = (r) => r.intake_id === intakeId;
      if (text) tests.q = (r) => r.title.toLowerCase().includes(text) || (r.body ?? "").toLowerCase().includes(text);
      if (q.get("replies_to_send") === "true") tests.replies = (r) => r.state === "disqualified" && rootReplies(r).some((x) => x.status === "drafted");
      const where = (...but: string[]) =>
        db.requests.filter((r) => Object.entries(tests).every(([k, t]) => but.includes(k) || t(r)));
      const rows = where().sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
      const byState = where("state");
      const byChannel: Record<string, number> = {};
      for (const r of where("channel")) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
      const week = Date.now() - 7 * 86_400_000;
      const body: Schemas["RequestList"] = {
        items: rows.slice(offset, offset + limit).map(out),
        total: rows.length,
        counts: {
          all: byState.length,
          ...(Object.fromEntries(STATES.map((s) => [s, byState.filter((r) => r.state === s).length])) as Record<State, number>),
        },
        by_channel: Object.fromEntries(Object.entries(byChannel).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
        new_this_week: db.requests.filter((r) => Date.parse(r.created_at) >= week).length,
      };
      return json(200, body);
    }
    if (m === "POST") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      const input = await body<Schemas["RequestCreate"]>();
      const created = createRow(input, null);
      return created instanceof Response ? created : json(201, out(created));
    }
  }

  // Shared by POST /v1/requests and filing a found item.
  function createRow(input: Partial<Schemas["RequestCreate"]>, source: RequestOut["source"]): Row | Response {
    const title = (input.title ?? "").trim();
    if (!title || title.length > 200) return fail(422, "A title of 1-200 characters");
    if ((input.body ?? "").length > 4000) return fail(422, "At most 4000 characters");
    if (!input.channel || !CHANNELS.includes(input.channel)) return fail(422, "channel");
    if (input.channel === "interview") return fail(422, "Interview requests come from interviews");
    if (input.source_item_id) return fail(422, "source_item_id is not one of your own source items");
    const bad = badGoals(input.goal_ids);
    if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
    if (input.theme_id && !liveTheme(input.theme_id)) return fail(422, `Unknown theme: ${input.theme_id}`);
    let requesterName = input.requester_name?.trim() || null;
    let requesterKind = input.requester_kind ?? "unknown";
    if (input.channel === "in_app") {
      // New request in the app (#329): the signed-in member, as team; an owner may name someone else.
      const email = ctx.people?.().find((x) => x.id === ctx.userId)?.email;
      const me = email ? displayName(email) : null;
      if (requesterName && requesterName !== me) {
        if (ctx.role !== "owner") return fail(403, OWNER_NAMES_REQUESTER);
      } else {
        requesterName = me;
        requesterKind = "team";
      }
    }
    const row: Row = {
      id: mockUuid(), title, body: input.body?.trim() || null, channel: input.channel, origin: "person",
      requester_name: requesterName, requester_kind: requesterKind,
      verified: true, state: "new", merged_into_id: null, disqualify_reason: null, decision_note: null,
      theme_id: input.theme_id ?? null, goal_ids: [...new Set(input.goal_ids ?? [])], feature_id: null,
      document_id: null, intake_id: null, interview_id: null, source, suggestion: null, filed_by: ctx.userId,
      decided_by: null, decided_at: null, created_at: now(), updated_at: now(), lock_version: 1,
    };
    db.requests.push(row);
    return row;
  }

  // --- triage (Classify now and the header's status line) --------------------------------
  if (p[1] === "requests" && p[2] === "triage" && p.length === 3) {
    const run = db.triage ?? null;
    if (run && !run.finished_at && Date.now() - Date.parse(run.started_at) >= TRIAGE_MS) {
      // The run ends: a suggestion for every New request with none (data only; nothing decided).
      const goal = [...confirmed][0];
      for (const r of db.requests.filter((x) => x.state === "new" && !x.suggestion)) {
        const theme = db.themes.find((t) => !t.archived_at && goal && t.goal_ids.includes(goal));
        r.suggestion = {
          theme_id: theme?.id ?? null, theme_title: theme?.title ?? null, goal_ids: goal ? [goal] : [], duplicate_of: null,
          feature_id: null, confidence: 0.55, rationale: "Asked for in the same words as this theme's requests",
          run_id: run.id, at: now(), accepted: [],
        };
      }
      run.finished_at = now();
    }
    if (m === "GET") {
      const scenario = localStorage.getItem("po-mock-scenario") === SKIPPED_SCENARIO;
      const daily = dailyStatus(db, ctx, scenario);
      // As the API: no skip reason while the daily triage is off.
      const skipped = !run && scenario && daily.daily_on ? SKIPPED : null;
      const status: Schemas["TriageStatus"] = run
        ? {
            ...daily,
            run_id: run.id, status: run.finished_at ? "succeeded" : "running", active: !run.finished_at,
            automatic: false, started_at: run.started_at, finished_at: run.finished_at,
            suggestions: db.requests.filter((r) => r.suggestion?.run_id === run.id).length,
            found: db.candidates.filter((c) => c.run_id === run.id && c.owner_user_id === ctx.userId).length, error: null,
          }
        : {
            ...daily,
            run_id: null, status: null, active: false, automatic: false, started_at: null, finished_at: null,
            suggestions: 0, found: 0, error: null, daily_skipped: skipped,
          };
      return json(200, status);
    }
    if (m === "POST") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      if (run && !run.finished_at) return fail(409, "Oracle is already classifying requests");
      db.triage = { id: mockUuid(), created_by: ctx.userId, started_at: now(), finished_at: null };
      return json(201, { id: db.triage.id, flow: "request_triage", status: "running", estimate_usd: 1.5 });
    }
  }

  if (p[1] === "requests" && p[2] === "triage" && p[3] === "daily" && p.length === 4 && m === "PUT") {
    if (!atLeast(ctx.role, "approver")) return forbidden("approver");
    const body = (await req.json()) as Schemas["TriageDailyIn"];
    db.daily = { on: body.on, by: ctx.userId, at: now() };
    return routeRequests(db, ctx, new Request(req.url, { method: "GET" }), p.slice(0, 3), q);
  }

  if (p[1] === "requests" && p[2]) {
    const row = db.requests.find((r) => r.id === p[2]);
    if (!row) return fail(404, "Request not found");
    if (p.length === 3 && m === "GET") {
      const doc = row.document_id ? ctx.documents().find((d) => d.id === row.document_id) : undefined;
      const detail: Schemas["RequestDetail"] = {
        ...out(row),
        merged: descendants(row.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(out),
        document: doc ?? null,
        suggested_basis: suggestedBasis(row),
        drafting: rootReplies(row).some((x) => !!x.job_at),
      };
      return json(200, detail);
    }
    if (p.length === 3 && m === "PATCH") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      const patch = await body<Schemas["RequestPatch"]>();
      if (patch.lock_version !== row.lock_version) return stale();
      const fields = Object.keys(patch).filter((k) => k !== "lock_version");
      if (fields.some((f) => f === "title" || f === "body")) {
        if (row.origin === "interview") return fail(403, "A request from an interview keeps the customer's words");
        if (row.filed_by !== ctx.userId) return fail(403, "Only the person who filed a request edits its words");
        if (row.state !== "new") return fail(409, "A request's words change only while it is New");
        if ("title" in patch && !(patch.title ?? "").trim()) return fail(422, "A request needs a title");
      }
      if (fields.some((f) => ["goal_ids", "theme_id", "feature_id", "document_id"].includes(f))) {
        if (!atLeast(ctx.role, "approver")) return forbidden("approver");
        const bad = badGoals(patch.goal_ids);
        if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
        if (patch.theme_id && !liveTheme(patch.theme_id)) return fail(422, `Unknown theme: ${patch.theme_id}`);
        if (patch.feature_id && !ctx.features().some((f) => f.id === patch.feature_id)) return fail(422, `Unknown feature: ${patch.feature_id}`);
        if (patch.document_id && !ctx.documents().some((d) => d.id === patch.document_id)) return fail(422, `Unknown document: ${patch.document_id}`);
      }
      if (patch.title != null) row.title = patch.title.trim();
      if ("body" in patch) row.body = patch.body?.trim() || null;
      if ("goal_ids" in patch) row.goal_ids = [...new Set(patch.goal_ids ?? [])];
      if ("theme_id" in patch) row.theme_id = patch.theme_id ?? null;
      if ("feature_id" in patch) row.feature_id = patch.feature_id ?? null;
      if ("document_id" in patch) {
        const had = row.document_id;
        row.document_id = patch.document_id ?? null;
        // C1: unlinking its PRD takes the request off its brief too (the API's _apply_patch).
        if (had && !row.document_id) row.intake_id = null;
      }
      if (fields.length) bump(row);
      return json(200, out(row));
    }
    if (p[3] === "replies" && p.length === 4 && m === "GET") {
      return json(200, replies.filter((x) => x.root_request_id === row.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(replyOut));
    }
    if (m === "POST" && p[3] === "replies" && p[4] === "draft" && p.length === 5) {
      if (!mayAct(row)) return forbidden("approver");
      const open = rootReplies(row).filter((x) => x.status === "drafted");
      if (open.some((x) => x.job_at)) return fail(409, "Oracle is drafting these replies already");
      for (const x of open) x.job_at = now();
      return json(202, { job_id: mockUuid() });
    }
    if (m === "POST" && p[3] === "replies" && p[4] === "reopened" && p.length === 5) {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      if (row.state === "disqualified" || !row.decision_id) return fail(409, "Tell the people who asked only after a Reopen");
      const told = rootReplies(row).filter((x) => x.kind === "no" && (x.status === "sent" || x.status === "notified"));
      const made = told
        .filter((x) => !rootReplies(row).some((y) => y.kind === "reopened" && y.request_id === x.request_id))
        .map((x) => addReply(row, db.requests.find((r) => r.id === x.request_id) ?? row, "reopened"));
      return json(200, made.map(replyOut));
    }
    if (m === "POST" && p[3] === "keep-no" && p.length === 4) {
      const input = await body<Schemas["KeepNoIn"]>();
      const decision = row.decision_id ? ctx.decisions?.get(row.decision_id) : null;
      if (!decision || row.state !== "disqualified") return fail(409, "This request has no logged no to keep");
      if (decision.approver_id !== ctx.userId) return fail(403, "Only the decision's approver keeps the no");
      if (!(input.note ?? "").trim()) return fail(422, "Say why you keep the no");
      ctx.decisions!.reaffirm(row.decision_id!, input.note.trim());
      row.asked_again_since = now();
      bump(row);
      return json(200, out(row));
    }
    if (m === "POST" && p.length >= 4) {
      const verb = p.slice(3).join("/");
      if (!["qualify", "merge", "disqualify", "reopen", "suggestion/accept", "suggestion/decline"].includes(verb)) return null;
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      const input = await body<{ lock_version: number } & Record<string, unknown>>();
      if (input.lock_version !== row.lock_version) return stale();
      const mergeInto = (into: string): Response | null => {
        if (row.state !== "new" && row.state !== "qualified") return fail(409, "Only a New or Qualified request can be merged");
        if (!db.requests.some((r) => r.id === into)) return fail(404, "Request to merge into not found");
        const root = rootOf(into);
        if (root === null || root === row.id) return fail(409, "That merge would form a cycle");
        row.state = "merged";
        row.merged_into_id = root;
        decide(row);
        // Asked again (H10): joining a request said no to gives its asker the same reasoned reply.
        const declined = db.requests.find((r) => r.id === root);
        if (declined?.state === "disqualified" && declined.decision_id && ctx.decisions?.get(declined.decision_id)?.status === "decided") {
          addReply(declined, row, "no");
          for (const d of descendants(row.id)) addReply(declined, d, "no");
          updateLoop(declined);
        }
        return null;
      };
      if (verb === "qualify") {
        if (row.state !== "new") return fail(409, "Only a New request can be qualified");
        const goals = (input.goal_ids as string[] | undefined) ?? row.goal_ids;
        const bad = input.goal_ids ? badGoals(goals) : [];
        if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
        if (!goals.some((g) => confirmed.has(g))) return fail(422, NEEDS_GOAL);
        row.goal_ids = [...new Set(goals)];
        row.state = "qualified";
        row.decision_note = ((input.note as string | undefined) ?? "").trim() || null;
        decide(row);
      } else if (verb === "merge") {
        const refused = mergeInto(String(input.into_id ?? ""));
        if (refused) return refused;
      } else if (verb === "disqualify") {
        const reason = String(input.reason ?? "") as Reason;
        const note = ((input.note as string | undefined) ?? "").trim();
        const basis = (input.basis as Basis | null | undefined) ?? null;
        if (!REASONS.includes(reason)) return fail(422, "reason");
        if (row.state !== "new" && row.state !== "qualified") return fail(409, "Only a New or Qualified request can be disqualified");
        if (reason === "other" && !note) return fail(422, "Say why in a note when the reason is Other");
        const kind = basis?.kind ?? "none";
        if (BASIS_NEEDED[reason] && (kind === "none" || !basis?.id)) return fail(422, BASIS_NEEDED[reason]!);
        if (!BASIS_KINDS[reason].includes(kind)) return fail(422, `A basis of kind ${kind} does not fit ${REASON_TITLE[reason]}`);
        const picked = kind === "none" ? null : entity(basis?.id);
        if (kind !== "none" && (!picked || picked.type !== kind)) return fail(422, `Unknown ${kind.replace("_", " ")}: ${basis?.id}`);
        if (reason === "strategy_stop" && (picked?.status !== "confirmed" || picked.attrs?.stance !== "stop")) return fail(422, "Pick a confirmed stop choice");
        row.state = "disqualified";
        row.disqualify_reason = reason;
        row.decision_note = note || null;
        row.basis_in = kind === "none" ? null : { kind, id: picked!.id };
        decide(row);
        row.asked_again_since = row.decided_at;
        row.loop_closed_on = null;
        if (isNo(reason, note) && ctx.decisions) {
          // A no: a decided decision in the log, and one reply per asker, drafted by Oracle's job.
          const d = ctx.decisions.capture({
            title: `Say no to ${row.title}`, question: `Build ${row.title}?`, rationale: note ? `${REASON_TITLE[reason]}: ${note}` : REASON_TITLE[reason],
            entity_ids: picked ? [picked.id] : [], request_id: row.id, request_title: row.title,
          });
          row.decision_id = d.id;
          for (const asked of [row, ...descendants(row.id).sort((a, b) => a.created_at.localeCompare(b.created_at))]) addReply(row, asked, "no");
        }
      } else if (verb === "reopen") {
        if (row.state !== "merged" && row.state !== "disqualified") return fail(409, "Only a Merged or Disqualified request can be reopened");
        const live = row.decision_id ? ctx.decisions?.get(row.decision_id) : null;
        if (row.state === "disqualified" && live?.status === "decided") {
          // The no is reversed (reviewed by the person who reopened); drafts are withdrawn.
          const why = ((input.reason as string | undefined) ?? "").trim();
          ctx.decisions!.reverse(row.decision_id!, `Request reopened${why ? `: ${why}` : ""}`);
          for (const x of rootReplies(row).filter((y) => y.status === "drafted")) Object.assign(x, { status: "withdrawn", job_at: null, lock_version: x.lock_version + 1 });
        }
        Object.assign(row, { state: "new", merged_into_id: null, disqualify_reason: null, decision_note: null, decided_by: null, decided_at: null, basis_in: null, asked_again_since: null, loop_closed_on: null });
      } else if (verb === "suggestion/decline") {
        if (row.state !== "new") return fail(409, "Only a New request takes Oracle's suggestions");
        if (!row.suggestion || row.suggestion.declined_at) return fail(422, "Oracle has no suggestion for this request");
        const email = ctx.people?.().find((x) => x.id === ctx.userId)?.email;
        row.suggestion = { ...row.suggestion, declined_at: now(), declined_by: ctx.userId, declined_by_name: email ? displayName(email) : null };
      } else {
        const parts = (input.parts as Part[] | undefined) ?? [];
        if (parts.length === 0) return fail(422, "parts: at least one");
        if (row.state !== "new") return fail(409, "Only a New request takes Oracle's suggestions");
        const s = row.suggestion;
        if (!s || s.declined_at) return fail(422, "Oracle has no suggestion for this request");
        // Every check first, as the API: a refused part changes nothing.
        if (parts.includes("theme") && !(s.theme_id ? liveTheme(s.theme_id) : s.theme_title?.trim())) return fail(422, "Oracle suggested no theme");
        if (parts.includes("goals") && (!s.goal_ids?.length || badGoals(s.goal_ids).length)) return fail(422, "Oracle suggested no confirmed goal");
        if (parts.includes("feature") && !(s.feature_id && ctx.features().some((f) => f.id === s.feature_id))) return fail(422, "Oracle suggested no feature");
        if (parts.includes("duplicate") && !s.duplicate_of) return fail(422, "Oracle suggested no duplicate");
        if (parts.includes("duplicate")) {
          const refused = mergeInto(s.duplicate_of!);
          if (refused) return refused;
        }
        if (parts.includes("theme")) {
          let theme = s.theme_id ? liveTheme(s.theme_id) : byTitle(s.theme_title!);
          if (!theme) {
            theme = {
              id: mockUuid(), title: s.theme_title!.trim(), description: null, goal_ids: (s.goal_ids ?? []).filter((g) => confirmed.has(g)),
              origin: "oracle", archived_at: null, created_by: ctx.userId, created_at: now(), updated_at: now(), lock_version: 1,
            };
            db.themes.push(theme);
          }
          row.theme_id = theme.id;
        }
        if (parts.includes("goals")) row.goal_ids = [...new Set(s.goal_ids!)];
        if (parts.includes("feature")) row.feature_id = s.feature_id ?? null;
        row.suggestion = { ...s, accepted: [...new Set([...(s.accepted ?? []), ...parts])].sort() };
      }
      bump(row);
      return json(200, out(row));
    }
  }

  // --- replies (H10) ---------------------------------------------------------------
  if (p[1] === "request-replies" && p[2]) {
    const reply = replies.find((x) => x.id === p[2]);
    const root = reply && db.requests.find((r) => r.id === reply.root_request_id);
    if (!reply || !root) return fail(404, "Reply not found");
    if (m === "POST" && p[3] === "opened") {
      // The member who asked opened Answer to your request: its Inbox row ends; again, nothing changes.
      if (reply.member_id !== ctx.userId) return fail(403, "Only the member who asked opens this answer");
      if (reply.status !== "notified") return fail(409, "Only a reply told in Oracle is opened");
      if (!reply.opened_at) {
        reply.opened_at = now();
        reply.lock_version += 1;
      }
      return json(200, replyOut(reply));
    }
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    if (!mayAct(root)) return fail(403, "Only the person who filed the request or an approver acts on its replies");
    const verb = p[3] ?? "";
    if (verb === "" && m === "PATCH") {
      const input = await body<Schemas["ReplyPatch"]>();
      if (input.lock_version !== reply.lock_version) return stale();
      if (reply.status !== "drafted") return fail(409, "Only a Drafted reply is edited");
      if ((input.body ?? "").length > REPLY_MAX) return fail(422, `At most ${REPLY_MAX} characters`);
      Object.assign(reply, { body: input.body, draft_source: "person", warnings: promiseWarnings(input.body, reply.asked), job_at: null });
    } else if (m === "POST" && verb === "sent") {
      const input = await body<Schemas["ReplySent"]>();
      if (reply.status !== "drafted") return fail(409, `This reply is already ${reply.status}`);
      if (!["email", "slack", "call", "in_app", "other"].includes(input.channel)) return fail(422, "channel");
      Object.assign(reply, { status: "sent", channel: input.channel, sent_on: input.sent_on || todayIn(zone), sent_by: ctx.userId, job_at: null });
    } else if (m === "POST" && verb === "skip") {
      const input = await body<Schemas["ReplySkip"]>();
      if (!(input.reason ?? "").trim()) return fail(422, "Say why you skip it");
      if (reply.status !== "drafted") return fail(409, `This reply is already ${reply.status}`);
      Object.assign(reply, { status: "skipped", skip_reason: input.reason.trim(), job_at: null });
    } else if (m === "POST" && verb === "notify") {
      if (!reply.member_id) return fail(409, "Only a member who asked in the app is told in Oracle");
      if (reply.status !== "drafted") return fail(409, `This reply is already ${reply.status}`);
      if (!(reply.body ?? "").trim()) return fail(409, "Write the reply first");
      Object.assign(reply, { status: "notified", notified_at: now(), job_at: null });
    } else return null;
    reply.lock_version += 1;
    updateLoop(root);
    bump(root);
    return json(200, replyOut(reply));
  }

  // --- themes -----------------------------------------------------------------------
  if (p[1] === "request-themes") {
    if (p.length === 2 && m === "GET") {
      const all = q.get("include_archived") === "true";
      const list = db.themes.filter((t) => all || !t.archived_at).sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
      return json(200, list.map(themeOut));
    }
    if (!atLeast(ctx.role, "approver")) return forbidden("approver");
    if (p.length === 2 && m === "POST") {
      const input = await body<Schemas["RequestThemeCreate"]>();
      const title = (input.title ?? "").trim();
      if (!title || title.length > 120) return fail(422, "A title of 1-120 characters");
      const bad = badGoals(input.goal_ids);
      if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
      if (byTitle(title)) return fail(409, "A theme with this title exists; pick another or use that one");
      const theme: Theme = {
        id: mockUuid(), title, description: input.description?.trim() || null, goal_ids: [...new Set(input.goal_ids ?? [])],
        origin: "person", archived_at: null, created_by: ctx.userId, created_at: now(), updated_at: now(), lock_version: 1,
      };
      db.themes.push(theme);
      return json(201, themeOut(theme));
    }
    const theme = db.themes.find((t) => t.id === p[2]);
    if (p[3] === "problem" && p.length === 5 && m === "POST") {
      if (!theme) return fail(404, "Theme not found");
      const input = await body<Schemas["ThemeProblemIn"]>();
      if (input.lock_version !== theme.lock_version) return stale();
      const s = theme.problem_suggestion;
      if (p[4] === "confirm") {
        if (theme.problem_state !== "suggested" || !s) return fail(409, "Oracle has no problem to confirm for this theme");
        Object.assign(theme, { problem: s.problem ?? null, success: s.success ?? null, constraints: s.constraints ?? null, problem_state: "confirmed", problem_confirmed_at: now(), problem_suggestion: null });
      } else if (p[4] === "dismiss") {
        if (theme.problem_state !== "suggested") return fail(409, "Oracle has no problem to dismiss for this theme");
        Object.assign(theme, { problem_state: theme.problem ? "confirmed" : "none", problem_suggestion: null });
      } else return null;
      bump(theme);
      return json(200, themeOut(theme));
    }
    if (p.length === 3 && m === "PATCH") {
      if (!theme) return fail(404, "Theme not found");
      const patch = await body<Schemas["RequestThemePatch"]>();
      if (patch.lock_version !== theme.lock_version) return stale();
      const title = patch.title?.trim() || theme.title;
      const archived = patch.archived ?? !!theme.archived_at;
      const bad = badGoals(patch.goal_ids);
      if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
      const taken = byTitle(title);
      if (!archived && taken && taken.id !== theme.id) return fail(409, "A theme with this title exists; pick another or use that one");
      theme.title = title;
      if ("description" in patch) theme.description = patch.description?.trim() || null;
      if (patch.goal_ids) theme.goal_ids = [...new Set(patch.goal_ids)];
      // A problem a person writes is confirmed by them (H10).
      const problem = (["problem", "success", "constraints"] as const).filter((k) => k in patch);
      for (const k of problem) theme[k] = patch[k]?.trim() || null;
      if (problem.length) Object.assign(theme, { problem_state: theme.problem ? "confirmed" : "none", problem_confirmed_at: now(), problem_suggestion: null });
      theme.archived_at = archived ? (theme.archived_at ?? now()) : null;
      bump(theme);
      return json(200, themeOut(theme));
    }
  }

  // --- found in your sources (the signed-in person's own) ------------------------------
  if (p[1] === "request-candidates") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const mine = db.candidates.filter((c) => c.owner_user_id === ctx.userId);
    if (p.length === 2 && m === "GET") {
      const status = q.get("status");
      return json(200, mine.filter((c) => !status || c.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }
    const candidate = mine.find((c) => c.id === p[2]);
    if (!candidate) return fail(404, "Found item not found");
    if (m !== "POST" || p.length !== 4) return null;
    if (candidate.status !== "open") return fail(409, `This item is already ${candidate.status}`);
    if (p[3] === "dismiss") {
      Object.assign(candidate, { status: "dismissed", updated_at: now() });
      return json(200, candidate);
    }
    if (p[3] === "file") {
      const input = await body<Partial<Schemas["RequestCreate"]>>();
      const created = createRow(
        {
          title: candidate.title, body: candidate.body, channel: candidate.channel, requester_name: candidate.requester_name,
          requester_kind: "unknown", goal_ids: candidate.goal_ids.filter((g) => confirmed.has(g)),
          theme_id: candidate.theme_title ? byTitle(candidate.theme_title)?.id ?? null : null, ...input, source_item_id: null,
        },
        { ...candidate.source, removed: false },
      );
      if (created instanceof Response) return created;
      Object.assign(candidate, { status: "filed", request_id: created.id, updated_at: now() });
      return json(201, out(created));
    }
  }
  return null;
}

/**
 * The Inbox's request rows (H10): Replies to send (the filer and the decider), Asked again at
 * the threshold (the decision's approver) and Answer to your request (the member who asked,
 * shown only, until they open it: POST /v1/request-replies/{id}/opened).
 */
export function requestInboxRows(db: RequestsDb | undefined, ctx: Pick<RequestsContext, "userId" | "decisions">): Schemas["InboxRequestReply"][] {
  if (!db) return [];
  const me = ctx.userId;
  const replies = db.replies ?? [];
  const rows: Schemas["InboxRequestReply"][] = [];
  for (const r of db.requests.filter((x) => x.state === "disqualified" && (x.filed_by === me || x.decided_by === me))) {
    const open = replies.filter((x) => x.root_request_id === r.id && x.decision_id === (r.decision_id ?? null) && x.status === "drafted").length;
    if (!open) continue;
    const d = r.decision_id ? ctx.decisions?.get(r.decision_id) : null;
    rows.push({ request_id: r.id, title: r.title, reason: "replies_to_send", count: open, decision_number: d?.number ?? null, at: r.decided_at, counts: true });
  }
  for (const r of db.requests.filter((x) => x.state === "disqualified" && x.decision_id && x.asked_again_since)) {
    const d = ctx.decisions?.get(r.decision_id!);
    if (!d || d.status !== "decided" || d.approver_id !== me) continue;
    const merged: Row[] = [];
    const stack = db.requests.filter((x) => x.merged_into_id === r.id);
    while (stack.length) {
      const x = stack.pop()!;
      if (merged.includes(x)) continue;
      merged.push(x);
      stack.push(...db.requests.filter((y) => y.merged_into_id === x.id));
    }
    const n = merged.filter((x) => x.decided_at && x.decided_at > r.asked_again_since!).length;
    if (n >= ASKED_AGAIN_THRESHOLD) rows.push({ request_id: r.id, title: r.title, reason: "asked_again", count: n, decision_number: d.number, at: r.decided_at, counts: true });
  }
  for (const x of replies.filter((y) => y.member_id === me && y.status === "notified" && !y.opened_at)) {
    const asked = db.requests.find((r) => r.id === x.request_id);
    rows.push({ request_id: x.request_id, title: asked?.title ?? x.asked ?? "", reason: "answer", body: x.body, reply_id: x.id, at: x.notified_at, counts: false });
  }
  return rows;
}

// --- Start a PRD (C1 lane 2, api/oracle/requests/service.py) ---------------------------------

/** Why the brief cannot take these requests, or null when it can: only qualified ones (422),
 * none already behind a brief or linked to a PRD (409, naming it), as put_behind_brief. */
export function behindBriefRefusal(
  db: RequestsDb,
  ids: string[],
  titles: { intake: (id: string) => string | null; document: (id: string) => string | null },
): { status: number; detail: string } | null {
  const rows = ids.map((id) => db.requests.find((r) => r.id === id));
  if (!rows.every((r) => r?.state === "qualified")) return { status: 422, detail: "Only qualified requests can be behind a PRD" };
  for (const r of rows as Row[]) {
    if (r.intake_id) return { status: 409, detail: `"${r.title}" is already behind the brief "${titles.intake(r.intake_id) ?? "another brief"}"` };
    if (r.document_id) return { status: 409, detail: `"${r.title}" is already linked to the PRD "${titles.document(r.document_id) ?? "another PRD"}"` };
  }
  return null;
}

/** The brief's "Requests behind it": each one gets the intake. */
export function putBehindBrief(db: RequestsDb, intakeId: string, ids: string[]) {
  for (const r of db.requests.filter((x) => ids.includes(x.id))) {
    r.intake_id = intakeId;
    r.lock_version += 1;
    r.updated_at = new Date().toISOString();
  }
}

/** Archiving a brief that made no PRD releases the requests behind it; one a PRD links keeps
 * both links (the API's release_brief, decided "Release on archive" 2026-10-25). */
export function releaseBrief(db: RequestsDb, intakeId: string) {
  for (const r of db.requests.filter((x) => x.intake_id === intakeId && !x.document_id)) {
    r.intake_id = null;
    r.lock_version += 1;
    r.updated_at = new Date().toISOString();
  }
}

/** The PRD made for a brief links the requests behind it; one already linked keeps its PRD. */
export function linkIntakeDocument(db: RequestsDb, intakeId: string, documentId: string) {
  for (const r of db.requests.filter((x) => x.intake_id === intakeId && !x.document_id)) {
    r.document_id = documentId;
    r.lock_version += 1;
    r.updated_at = new Date().toISOString();
  }
}
