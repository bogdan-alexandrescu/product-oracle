/**
 * Mock of the customer interview routes (api/oracle/interviews, C3 lane 1) for
 * NEXT_PUBLIC_API_MOCKS=1: members create an interview, Oracle drafts its guide (a queued job
 * that finishes on its own a moment later), members edit it while it is a Draft, create the
 * one-time link and withdraw it; the customer answers through the public routes, served
 * without a member's session and keyed by the link's token.
 *
 * Deterministic stand-ins for Oracle's model: the guide is a fixed guide of four story-based
 * questions and a one-line intro; a turn follows up once per question when the answer has
 * fewer than 12 words; the acknowledgement is a short fixed sentence; finishing writes a
 * snapshot from the customer's own words and files each need as a New, unverified,
 * interview-channel request.
 *
 * Single use: the first GET of a link records it opened and sets a cookie holding the opener's
 * id; a call without that cookie answers 410 "used" (a fresh browser context reseeds the whole
 * mock, so a spec stands in for a second browser by clearing the cookies of this one).
 *
 * H9: `preset: "pricing"` fills the guide at once with the six fixed pricing questions (no
 * guide job, no model cost), GET filters by `?preset=`, and redrafting such a guide is a 409.
 *
 * Seed: one invited interview of the fixture's customer, Ana Lima of Example Co, whose link
 * token is `i-mock-token`. Synthetic placeholders only.
 */
import { displayName } from "@/lib/names";
import type {
  GuideItem,
  InterviewMessage,
  InterviewLink,
  InterviewOut,
  InterviewPatch,
  InterviewSnapshot,
  InterviewSummary,
  JobState,
  PublicInterview,
  PublicMessage,
  PublicTurn,
} from "@/lib/api/interviews";

import { mockUuid } from "./ids";
import { SPENT } from "./llm-jobs";
import { jobOut } from "./refusal";

type Role = "viewer" | "commenter" | "approver" | "owner";
/** H9: the one interview preset (the API's `preset` column). */
export type Preset = "pricing";
/** The API's InterviewOut and InterviewSummary carry the preset; ../interviews.ts does not yet. */
type WithPreset<T> = T & { preset: Preset | null };

/** An interview as the mock stores it: the API's row plus its link and turn state. */
interface Row extends Omit<InterviewOut, "can_manage" | "created_by_name"> {
  /** The link's token (the API keeps only its sha256). */
  token: string | null;
  /** Tokens a new link replaced (the API keeps their sha256): opening one says so. Absent on rows stored before. */
  replaced_tokens?: string[];
  /** The id in the first opener's cookie. */
  opener: string | null;
  /** Index of the current guide question. */
  position: number;
  /** Oracle has followed up on the current question. */
  followed_up: boolean;
  customer_messages: number;
  /** When the queued guide job finishes. */
  guide_ready_at: string | null;
  /** A team interview's member (lane 2). */
  interviewee_user_id?: string | null;
  /** H9: absent on rows stored before the preset. */
  preset?: Preset | null;
}

export interface InterviewsDb {
  interviews: Row[];
  /** #604 re-review, the "stored-refusals" scenario: the Claude pool refuses every guide job. */
  refuse?: boolean;
}

export interface InterviewsContext {
  userId: string;
  role: Role;
  /** The company's name, as the customer page shows it. */
  company: string;
  memberEmail: (id: string) => string | null;
  intakeTitle: (id: string) => string | null;
  themeTitle: (id: string) => string | null;
  /** Files a need as a request; returns its id. */
  fileRequest: (input: { title: string; body: string; requester_name: string; interview_id: string; intake_id: string | null; theme_id: string | null }) => string;
}

/** Builds a mock link token at runtime from its prefix and the rest (not a credential). */
const linkToken = (rest: string): string => ["i", rest].join("-");
/** The fixture's link token; its customer page works on a freshly seeded mock. */
export const MOCK_INTERVIEW_TOKEN = linkToken("mock-token");
export const MOCK_COMPANY = "Example Co";
/** The cookie that binds a link to its first browser (the API's is HttpOnly, path-scoped). */
const COOKIE = "po-interview";
/** How long the mock's guide job takes. */
const GUIDE_MS = 1_200;
const LINK_DAYS = 7;
const MAX_MESSAGES = 40;
const THIN_WORDS = 12;

const INTRO = "Thanks for making time. I'll ask four short questions about your recent experience; it takes about ten minutes.";
export const MOCK_GUIDE: { prompt: string; purpose: string }[] = [
  { prompt: "Tell me about the last time you ran into this. What happened?", purpose: "A recent, real story" },
  { prompt: "What did you do to get around it that time?", purpose: "The workaround used today" },
  { prompt: "Tell me about something you tried before that did not work out. Why not?", purpose: "Alternatives already tried" },
  { prompt: "Think of the last time it cost you time or money. How much was it?", purpose: "How much it matters" },
];
/** H9: the pricing guide, as api/oracle/interviews/service.py PRICING_GUIDE; 1 to 4 are Van Westendorp's. */
export const PRICING_GUIDE: { prompt: string; purpose: string }[] = [
  { prompt: "At what price would this be so cheap you would doubt its quality?", purpose: "Too cheap" },
  { prompt: "At what price would it start to feel like a bargain?", purpose: "Bargain" },
  { prompt: "At what price would it start to feel expensive, though you would still consider it?", purpose: "Expensive" },
  { prompt: "At what price would it be too expensive to consider?", purpose: "Too expensive" },
  { prompt: "What would you stop using or paying for if you bought this?", purpose: "What it replaces" },
  { prompt: "Who approves a purchase like this, and from which budget?", purpose: "Budget owner" },
];
const PRICING_FIXED = "A pricing interview's guide is fixed; edit it instead";
/** As api/oracle/interviews/service.py NEW_LINK_REFUSED. */
const NEW_LINK_REFUSED: Partial<Record<InterviewOut["status"], string>> = {
  finished: "This interview is finished, so it can't get a new link.",
  expired: "This interview's link expired, so it can't get a new link. Interview them again.",
  revoked: "This interview was withdrawn, so it can't get a new link.",
};
const ACK = "Thank you, that helps.";
export const MOCK_FOLLOW_UP = "Could you tell me about one specific time? What happened, step by step?";
export const MOCK_CLOSING = "That was my last question. Press Send my answers when you're ready.";

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });
/** As service.REPLACED_LINKS_KEPT: older replaced links read as expired. */
const REPLACED_LINKS_KEPT = 5;
const refuse = (status: number, reason: "used" | "expired" | "withdrawn" | "replaced") => json(status, { reason });

function guideItems(preset: Preset | null = null): GuideItem[] {
  return (preset === "pricing" ? PRICING_GUIDE : MOCK_GUIDE).map((g, i) => ({ id: `q${i + 1}`, prompt: g.prompt, purpose: g.purpose }));
}

function message(role: InterviewMessage["role"], kind: InterviewMessage["kind"], body: string, guide_item: string | null): InterviewMessage {
  return { id: mockUuid(), role, kind, body, guide_item, created_at: now() };
}

/** The seeded interview: invited, its four questions approved, its link `i-mock-token`. */
export function seedInterviews(input: { ownerId: string }): InterviewsDb {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const row: Row = {
    id: mockUuid(), kind: "customer", status: "invited", title: "Paying suppliers", intake_id: null, theme_id: null,
    topic: "Paying suppliers", intro: INTRO, guide: guideItems(), guide_job: { id: mockUuid(), status: "succeeded", error: null },
    interviewee_name: "Ana Lima", interviewee_company: "Example Co", link_expires_at: later(6 * 86_400_000),
    link_created_at: at, link_opened_at: null, created_by: input.ownerId, created_at: at, finished_at: null, lock_version: 2, messages: [],
    snapshot: {}, snapshot_job: null, request_ids: [], token: MOCK_INTERVIEW_TOKEN, opener: null, position: 0,
    followed_up: false, customer_messages: 0, guide_ready_at: null,
  };
  return { interviews: [row] };
}

/** The guide job finishes on its own; an open link past its date expires. */
function settle(r: Row, refuse = false) {
  if (r.guide_job && (r.guide_job.status === "queued" || r.guide_job.status === "running") && r.guide_ready_at) {
    if (Date.now() >= Date.parse(r.guide_ready_at) && refuse) {
      r.guide_job = { ...r.guide_job, status: "failed", error: SPENT, finished_at: r.guide_ready_at };
      r.guide_ready_at = null;
    } else if (Date.now() >= Date.parse(r.guide_ready_at)) {
      r.guide_job = { ...r.guide_job, status: "succeeded", finished_at: r.guide_ready_at };
      r.intro = INTRO;
      r.guide = guideItems();
      r.guide_ready_at = null;
    } else r.guide_job = { ...r.guide_job, status: "running" };
  }
  if ((r.status === "invited" || r.status === "in_progress") && r.link_expires_at && Date.parse(r.link_expires_at) < Date.now()) {
    r.status = "expired";
  }
}

function cookieOf(token: string): string | null {
  if (typeof document === "undefined") return null;
  const name = `${COOKIE}-${token}=`;
  const hit = document.cookie.split("; ").find((c) => c.startsWith(name));
  return hit ? decodeURIComponent(hit.slice(name.length)) : null;
}

function setCookie(token: string, value: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}-${token}=${encodeURIComponent(value)}; path=/; SameSite=Strict`;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function progress(r: Row) {
  return { asked: Math.min(r.position + 1, r.guide.length), total: r.guide.length };
}

function publicMessages(list: InterviewMessage[]): PublicMessage[] {
  return list
    .filter((m) => m.kind !== "skip" && m.kind !== "intro")
    .map((m) => ({ role: m.role === "oracle" ? "oracle" : "customer", body: m.body, at: m.created_at }));
}

/** Moves to the next question, or posts the closing line after the last one. */
function advance(r: Row): InterviewMessage[] {
  r.position += 1;
  r.followed_up = false;
  const next = r.guide[r.position];
  const m = next ? message("oracle", "question", next.prompt, next.id) : message("oracle", "closing", MOCK_CLOSING, null);
  r.messages.push(m);
  return [m];
}

/** The snapshot, written from the customer's own words (each quote an exact substring). */
function writeSnapshot(r: Row): InterviewSnapshot {
  const answers = r.messages.filter((m) => m.kind === "answer");
  const firstByQuestion = new Map<string, InterviewMessage>();
  for (const a of answers) if (a.guide_item && !firstByQuestion.has(a.guide_item)) firstByQuestion.set(a.guide_item, a);
  const quoteOf = (text: string) => {
    const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
    return sentence.length <= 200 ? sentence : sentence.slice(0, 200);
  };
  const titleOf = (text: string) => {
    const first = text.split(/\s+/).slice(0, 8).join(" ").replace(/[.,;:!?]+$/, "");
    return first.charAt(0).toUpperCase() + first.slice(1);
  };
  const answered = [...firstByQuestion.values()];
  const skipped = r.messages.filter((m) => m.kind === "skip").length;
  const who = r.interviewee_company ? `${r.interviewee_name} at ${r.interviewee_company}` : (r.interviewee_name ?? "The customer");
  return {
    quick_facts: [`${who} answered ${answered.length} of ${r.guide.length} questions`, ...(skipped ? [`Skipped ${skipped}`] : [])],
    quotes: answered.slice(0, 3).map((a) => ({ text: quoteOf(a.body), question_id: a.guide_item })),
    needs: answered.slice(0, 3).map((a) => ({ title: titleOf(a.body), quote: quoteOf(a.body), question_id: a.guide_item })),
    insights: answered.length ? ["Told concrete stories from recent work"] : [],
  };
}

function finish(r: Row, ctx: InterviewsContext) {
  r.status = "finished";
  r.finished_at = now();
  if (r.messages.some((m) => m.kind === "answer")) {
    r.snapshot = writeSnapshot(r);
    r.snapshot_job = { id: mockUuid(), status: "succeeded", error: null, finished_at: now() };
    const requester = r.interviewee_company ? `${r.interviewee_name} (${r.interviewee_company})` : (r.interviewee_name ?? "A customer");
    r.request_ids = (r.snapshot.needs ?? []).map((n) =>
      ctx.fileRequest({ title: n.title, body: n.quote, requester_name: requester, interview_id: r.id, intake_id: r.intake_id, theme_id: r.theme_id }),
    );
  }
}

/** The public routes: no member session, the token and the opener's cookie only. */
export async function routePublicInterviews(db: InterviewsDb, ctx: InterviewsContext, req: Request, p: string[]): Promise<Response | null> {
  if (p[0] !== "v1" || p[1] !== "public" || p[2] !== "interviews" || !p[3]) return null;
  const token = p[3];
  const m = req.method;
  const r = db.interviews.find((x) => x.token === token || x.replaced_tokens?.includes(token));
  if (!r) return refuse(404, "expired");
  settle(r);
  // A closed interview says why it closed, whichever of its links is opened (public._check).
  if (r.status === "revoked") return refuse(410, "withdrawn");
  if (r.status === "expired") return refuse(410, "expired");
  if (r.status === "finished") return refuse(410, "used");
  if (r.token !== token) return refuse(410, "replaced");
  const cookie = cookieOf(token);

  if (p.length === 4 && m === "GET") {
    if (r.opener && cookie !== r.opener) return refuse(410, "used");
    if (!r.opener) {
      r.opener = mockUuid();
      setCookie(token, r.opener);
      r.link_opened_at = now();
      const first = r.guide[0];
      // A new link on an interview in progress carries it on.
      if (first && r.status === "invited") r.messages.push(message("oracle", "question", first.prompt, first.id));
      r.status = "in_progress";
    }
    const out: PublicInterview = {
      company: ctx.company,
      interviewee_name: r.interviewee_name ?? "",
      intro: r.intro ?? "",
      status: r.status as PublicInterview["status"],
      messages: publicMessages(r.messages),
      progress: progress(r),
    };
    return json(200, out);
  }
  if (!r.opener || cookie !== r.opener) return refuse(410, "used");
  if (m !== "POST" || p.length !== 5) return fail(404, "Route not found");

  if (p[4] === "messages") {
    const { body } = (JSON.parse((await req.text()) || "null") ?? {}) as { body?: string };
    const text = (body ?? "").trim();
    if (!text) return fail(422, "Write something first");
    if (text.length > 2000) return fail(422, "At most 2000 characters");
    const current = r.guide[r.position];
    const own = message("interviewee", "answer", text, current?.id ?? null);
    r.messages.push(own);
    r.customer_messages += 1;
    const added: InterviewMessage[] = [own];
    if (r.customer_messages >= MAX_MESSAGES) {
      finish(r, ctx);
      return json(200, { messages: publicMessages(added), progress: progress(r), done: true } satisfies PublicTurn);
    }
    const ack = message("oracle", "ack", ACK, current?.id ?? null);
    r.messages.push(ack);
    added.push(ack);
    if (current && words(text) < THIN_WORDS && !r.followed_up) {
      r.followed_up = true;
      const follow = message("oracle", "follow_up", MOCK_FOLLOW_UP, current.id);
      r.messages.push(follow);
      added.push(follow);
    } else if (current) added.push(...advance(r));
    return json(200, { messages: publicMessages(added), progress: progress(r), done: false } satisfies PublicTurn);
  }
  if (p[4] === "skip") {
    const current = r.guide[r.position];
    if (!current) return json(200, { messages: [], progress: progress(r), done: false } satisfies PublicTurn);
    r.messages.push(message("interviewee", "skip", "", current.id));
    const added = advance(r);
    return json(200, { messages: publicMessages(added), progress: progress(r), done: false } satisfies PublicTurn);
  }
  if (p[4] === "finish") {
    finish(r, ctx);
    return json(200, { done: true });
  }
  return fail(404, "Route not found");
}

const canManageRow = (r: Row, ctx: InterviewsContext) => r.created_by === ctx.userId || atLeast(ctx.role, "approver");

function outOf(r: Row, ctx: InterviewsContext): WithPreset<InterviewOut> {
  const { token: _t, replaced_tokens: _r, opener: _o, position: _p, followed_up: _f, customer_messages: _c, guide_ready_at: _g, interviewee_user_id: _u, ...rest } = r;
  void [_t, _r, _o, _p, _f, _c, _g, _u];
  const email = ctx.memberEmail(r.created_by);
  // As the API's InterviewOut: a job's stored error read through the refusal rewrite (#604 re-review).
  const job = (j: JobState | null) => (j ? jobOut({ finished_at: null, ...j }) : null);
  return { ...rest, link_created_at: rest.link_created_at ?? null, guide_job: job(rest.guide_job), snapshot_job: job(rest.snapshot_job), preset: r.preset ?? null, created_by_name: email ? displayName(email) : null, can_manage: canManageRow(r, ctx) };
}

/** The members' routes (/v1/interviews...); null when the path is not one of them. */
export async function routeInterviews(db: InterviewsDb, ctx: InterviewsContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[0] !== "v1" || p[1] !== "interviews") return null;
  const m = req.method;
  const body = async <T>() => (JSON.parse((await req.text()) || "null") ?? {}) as T;
  const canManage = (r: Row) => canManageRow(r, ctx);
  const out = (r: Row): WithPreset<InterviewOut> => outOf(r, ctx);
  const summary = (r: Row): WithPreset<InterviewSummary> => ({
    id: r.id, kind: r.kind, status: r.status, preset: r.preset ?? null, title: r.title, interviewee_name: r.interviewee_name,
    interviewee_company: r.interviewee_company, created_by: r.created_by, created_by_name: out(r).created_by_name,
    created_at: r.created_at, finished_at: r.finished_at, request_count: r.request_ids.length,
  });
  db.interviews.forEach((r) => settle(r, db.refuse));

  if (p.length === 2 && m === "GET") {
    const rows = db.interviews
      .filter((r) => !q.get("status") || r.status === q.get("status"))
      .filter((r) => !q.get("intake_id") || r.intake_id === q.get("intake_id"))
      .filter((r) => !q.get("theme_id") || r.theme_id === q.get("theme_id"))
      .filter((r) => !q.get("kind") || r.kind === q.get("kind"))
      .filter((r) => !q.get("preset") || r.preset === q.get("preset"))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json(200, rows.map(summary));
  }
  if (p.length === 2 && m === "POST") {
    if (!atLeast(ctx.role, "commenter")) return fail(403, "Requires the commenter role");
    const input = await body<{ kind?: string; interviewee_name?: string; interviewee_company?: string | null; subject?: Record<string, string>; preset?: string | null }>();
    const name = (input.interviewee_name ?? "").trim();
    const company = (input.interviewee_company ?? "").trim() || null;
    if (input.kind !== "customer") return fail(422, "kind must be customer");
    if (input.preset != null && input.preset !== "pricing") return fail(422, "preset must be pricing");
    const preset: Preset | null = input.preset === "pricing" ? "pricing" : null;
    if (!name || name.length > 120) return fail(422, "Customer name: 1 to 120 characters");
    if (company && company.length > 120) return fail(422, "Company: at most 120 characters");
    const s = input.subject ?? {};
    const keys = Object.keys(s).filter((k) => s[k]);
    if (keys.length !== 1) return fail(422, "Pick one subject: a PRD idea, a request theme or a topic");
    let title: string | null = null;
    if (s.intake_id) title = ctx.intakeTitle(s.intake_id);
    else if (s.theme_id) title = ctx.themeTitle(s.theme_id);
    else if (s.topic) {
      if (s.topic.trim().length > 300) return fail(422, "Topic: at most 300 characters");
      title = s.topic.trim();
    }
    if (!title) return fail(404, s.intake_id ? "Intake not found" : "Theme not found");
    const row: Row = {
      id: mockUuid(), kind: "customer", status: "draft", title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
      intake_id: s.intake_id ?? null, theme_id: s.theme_id ?? null, topic: s.topic?.trim() ?? null, intro: null,
      // The preset is the guide: no guide job, no model cost.
      guide: preset ? guideItems(preset) : [], preset,
      guide_job: preset ? null : ({ id: mockUuid(), status: "queued", error: null } satisfies JobState), interviewee_name: name,
      interviewee_company: company, link_expires_at: null, link_created_at: null, link_opened_at: null, created_by: ctx.userId, created_at: now(),
      finished_at: null, lock_version: 1, messages: [], snapshot: {}, snapshot_job: null, request_ids: [], token: null,
      opener: null, position: 0, followed_up: false, customer_messages: 0, guide_ready_at: preset ? null : later(GUIDE_MS),
    };
    db.interviews.push(row);
    return json(201, out(row));
  }
  const r = db.interviews.find((x) => x.id === p[2]);
  if (!r) return fail(404, "Interview not found");
  if (p.length === 3 && m === "GET") return json(200, out(r));
  if (!atLeast(ctx.role, "commenter") || !canManage(r)) return fail(403, "Only the interview's creator or an approver can change it");
  if (p.length === 3 && m === "PATCH") {
    const patch = await body<InterviewPatch>();
    if (r.status !== "draft") return fail(409, "Only a draft interview can be edited");
    if (patch.lock_version !== r.lock_version) return fail(409, "Someone else changed this since you loaded it; reload and try again");
    if (patch.intro !== undefined) {
      if (patch.intro.trim().length > 300) return fail(422, "Intro: at most 300 characters");
      r.intro = patch.intro.trim();
    }
    if (patch.guide !== undefined) {
      if (patch.guide.length < 1 || patch.guide.length > 8) return fail(422, "1 to 8 questions");
      if (patch.guide.some((g) => !g.prompt.trim() || g.prompt.trim().length > 300)) return fail(422, "Each question: 1 to 300 characters");
      const used = new Set<string>();
      r.guide = patch.guide.map((g) => {
        let id = g.id && !used.has(g.id) ? g.id : "";
        for (let n = 1; !id; n++) if (!used.has(`q${n}`) && !patch.guide!.some((x) => x.id === `q${n}`)) id = `q${n}`;
        used.add(id);
        return { id, prompt: g.prompt.trim(), purpose: g.purpose?.trim() || null };
      });
    }
    if (patch.interviewee_name !== undefined) {
      const name = patch.interviewee_name.trim();
      if (!name || name.length > 120) return fail(422, "Customer name: 1 to 120 characters");
      r.interviewee_name = name;
    }
    if (patch.interviewee_company !== undefined) r.interviewee_company = patch.interviewee_company?.trim() || null;
    r.lock_version += 1;
    return json(200, out(r));
  }
  if (p.length === 4 && m === "POST" && p[3] === "guide") {
    if (r.status !== "draft") return fail(409, "Only a draft interview can be redrafted");
    if (r.preset) return fail(409, PRICING_FIXED);
    r.guide_job = { id: mockUuid(), status: "queued", error: null };
    r.guide_ready_at = later(GUIDE_MS);
    r.lock_version += 1;
    return json(200, out(r));
  }
  if (p.length === 4 && m === "POST" && p[3] === "link") {
    if (r.token) return fail(409, "A link exists; withdraw it first");
    if (r.status !== "draft") return fail(409, "Only a draft interview gets a link");
    if (!r.guide.length) return fail(409, "Draft the questions first");
    r.token = linkToken(mockUuid().replace(/-/g, ""));
    r.status = "invited";
    r.link_created_at = now();
    r.link_expires_at = later(LINK_DAYS * 86_400_000);
    r.lock_version += 1;
    return json(201, { url: `${window.location.origin}/i/${r.token}`, expires_at: r.link_expires_at, created_at: r.link_created_at } satisfies InterviewLink);
  }
  // Make a new link (qa-work-43), as api/oracle/interviews/service.py new_link.
  if (p.length === 4 && m === "POST" && p[3] === "new-link") {
    const refused = NEW_LINK_REFUSED[r.status];
    if (refused) return fail(409, refused);
    if (!r.token || (r.status !== "invited" && r.status !== "in_progress")) return fail(409, "This interview has no link yet; create its link first.");
    if (r.link_expires_at && Date.parse(r.link_expires_at) <= Date.now()) return fail(409, NEW_LINK_REFUSED.expired!);
    r.replaced_tokens = [...(r.replaced_tokens ?? []), r.token].slice(-REPLACED_LINKS_KEPT);
    r.token = linkToken(mockUuid().replace(/-/g, ""));
    r.link_created_at = now();
    r.link_expires_at = later(LINK_DAYS * 86_400_000);
    r.link_opened_at = null;
    r.opener = null;
    r.lock_version += 1;
    return json(201, { url: `${window.location.origin}/i/${r.token}`, expires_at: r.link_expires_at, created_at: r.link_created_at } satisfies InterviewLink);
  }
  if (p.length === 4 && m === "POST" && p[3] === "revoke") {
    if (r.status !== "invited" && r.status !== "in_progress") return fail(409, "Only an open link can be withdrawn");
    r.status = "revoked";
    r.lock_version += 1;
    return json(200, out(r));
  }
  return fail(404, "Route not found");
}

// --- team interviews (C3 lane 2) -----------------------------------------------------------

/** What a team turn needs of the intake mock (./intake.ts): its questions and the answer path. */
export interface TeamContext extends InterviewsContext {
  intakeExists: (id: string) => boolean;
  question: (id: string) => { intake_id?: string | null; status: string; asked_to?: string | null } | null;
  /** The next open question of the intake asked of this member, oldest batch first. */
  nextQuestion: (intakeId: string, after: string) => string | null;
  /** Records the answer through POST /v1/questions/{id}/answers. */
  recordAnswer: (questionId: string, body: string) => Promise<Response>;
}

export const MOCK_TEAM_FOLLOW_UP = "Could you be more specific? Name the one that matters most, and who confirmed it.";
const RECORDED = "Answer recorded.";

/**
 * POST /v1/intakes/{id}/interview (the member's team interview, created on first call) and
 * POST /v1/interviews/{id}/turns: a follow-up when the answer has fewer than 12 words, once per
 * question; then the member's messages, joined with a blank line, are recorded as their answer.
 */
export async function routeTeamInterviews(db: InterviewsDb, ctx: TeamContext, req: Request, p: string[]): Promise<Response | null> {
  if (req.method !== "POST" || p.length !== 4) return null;
  if (p[1] === "intakes" && p[3] === "interview") {
    if (!atLeast(ctx.role, "commenter")) return fail(403, "Requires the commenter role");
    if (!ctx.intakeExists(p[2])) return fail(404, "Intake not found");
    let r = db.interviews.find((x) => x.kind === "team" && x.intake_id === p[2] && x.interviewee_user_id === ctx.userId);
    if (!r) {
      r = {
        id: mockUuid(), kind: "team", status: "in_progress", title: ctx.intakeTitle(p[2]) ?? "", intake_id: p[2], theme_id: null,
        topic: null, intro: null, guide: [], guide_job: null, interviewee_name: null, interviewee_company: null,
        link_expires_at: null, link_created_at: null, link_opened_at: null, created_by: ctx.userId, created_at: now(), finished_at: null,
        lock_version: 1, messages: [], snapshot: {}, snapshot_job: null, request_ids: [], token: null, opener: null,
        position: 0, followed_up: false, customer_messages: 0, guide_ready_at: null, interviewee_user_id: ctx.userId,
      };
      db.interviews.push(r);
    }
    return json(200, outOf(r, ctx));
  }
  if (p[1] !== "interviews" || p[3] !== "turns") return null;
  if (!atLeast(ctx.role, "commenter")) return fail(403, "Requires the commenter role");
  const r = db.interviews.find((x) => x.id === p[2]);
  if (!r) return fail(404, "Interview not found");
  if (r.kind !== "team") return fail(409, "Only a team interview takes team turns");
  if (r.interviewee_user_id !== ctx.userId) return fail(403, "Only its interviewee answers in this interview");
  const input = (JSON.parse((await req.text()) || "null") ?? {}) as { question_id?: string; body?: string | null; skip_follow_up?: boolean };
  const qid = input.question_id ?? "";
  const question = ctx.question(qid);
  if (!question || (question.intake_id ?? null) !== r.intake_id) return fail(404, "Question not found");
  if (!["asked", "delegated", "deferred", "researching", "draft"].includes(question.status)) return fail(409, "This question is answered; it is not asked again");
  if (question.asked_to && question.asked_to !== ctx.userId) return fail(403, "This question was asked of someone else");

  // This question's messages since Oracle last recorded an answer to it.
  const mineOf = r.messages.filter((m) => m.question_id === qid);
  const round = mineOf.slice(mineOf.map((m) => m.kind).lastIndexOf("closing") + 1);
  const said = round.filter((m) => m.role === "interviewee" && m.kind === "answer").map((m) => m.body);
  const text = (input.body ?? "").trim();
  if (!text && !(input.skip_follow_up && said.length)) return fail(422, "An answer needs a body");
  const added: InterviewMessage[] = [];
  const add = (role: InterviewMessage["role"], kind: InterviewMessage["kind"], body: string) => {
    const m = { ...message(role, kind, body, null), question_id: qid };
    r.messages.push(m);
    added.push(m);
  };
  if (text) {
    said.push(text);
    add("interviewee", "answer", text);
  } else add("interviewee", "skip", "Skip, record my answer");
  if (!round.some((m) => m.kind === "follow_up") && !input.skip_follow_up && words(text) < THIN_WORDS) {
    add("oracle", "follow_up", MOCK_TEAM_FOLLOW_UP);
    return json(200, { messages: added, recorded: null, next_question_id: null });
  }
  const res = await ctx.recordAnswer(qid, said.join("\n\n"));
  if (!res.ok) {
    r.messages = r.messages.filter((m) => !added.includes(m));
    return res;
  }
  const recorded = await res.json();
  add("oracle", "closing", RECORDED);
  return json(200, { messages: added, recorded, next_question_id: ctx.nextQuestion(r.intake_id ?? "", qid) });
}
