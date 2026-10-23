/**
 * Discussions (G1) in the mock: every /v1/discussions route, with the API's rules
 * (oracle.discussions): open by default, private when the starter says so, only the starter
 * adds people to a private one, viewers read, and the starter alone makes a private one open
 * with the counts its warning showed (409 with the current counts otherwise, then a system
 * line). Seeded only in the "discussions" scenario.
 */
import type { Schemas } from "@/lib/api/client";

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
};
type ParticipantRow = {
  discussion_id: string;
  user_id: string;
  added_via: Schemas["DiscussionParticipantOut"]["added_via"];
  left_at: string | null;
  last_read_at: string | null;
  created_at: string;
};
type MessageRow = {
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
type ChangeRow = Schemas["DiscussionChangeOut"] & { discussion_id: string };

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
};

/** G2: the gateway's message when no Claude account can take a call (approvers and owners). */
export const NO_ACCOUNT_MESSAGE =
  "No Claude account: an owner adds one on Settings > Claude accounts (or sets a fallback setup-token or API key there)";
/** The mock's canned reply, citing the seed's "Raise activation" goal. */
export const CANNED_REPLY = ["Yes, if caps ", "read the plan thresholds only ", "[c:1]. Detection can follow ", "once activation holds; ", "the goal does not depend on it."];
const CANNED_CITATIONS = [{ n: 1, kind: "entity", ref: "g.activation", title: "Goal: Raise activation", url: "/baseline", confidence: 0.82, low_confidence: false }];
/** The first piece waits a little ("Oracle is thinking…"), the rest come 150 ms apart. */
const FIRST_MS = 500;
const DELTA_MS = 150;

export const emptyDiscussions = (): DiscussionsDb => ({ discussions: [], participants: [], messages: [] });

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  if (p[1] !== "discussions") return null;
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
      changes: { proposed: 0, suggested: 0, staged: 0 },
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
        ...(d.private_findings?.author === me.id ? { private_findings: { count: d.private_findings.count, intake_id: d.private_findings.intake_id } } : {}),
      },
      exposure: d.visibility === "private" && starter(d) ? exposure(d) : null,
    };
  };
  const messageOut = (x: MessageRow): Schemas["DiscussionMessageOut"] => ({
    id: x.id,
    discussion_id: x.discussion_id,
    author_kind: x.author_kind,
    author: x.author_kind === "person" && x.author_id ? ref(x.author_id) : null,
    via: "web",
    body: x.deleted_at ? "" : x.body,
    mentions: x.deleted_at ? [] : x.mentions.map(ref),
    mentions_oracle: x.mentions_oracle,
    reply_to: x.reply_to,
    status: x.status ?? "complete",
    citations: x.citations ?? [],
    created_at: x.created_at,
    edited_at: x.edited_at,
    deleted: !!x.deleted_at,
    error_reason: x.error_reason ?? null,
    error: x.status === "failed" ? (x.error_reason === "no_account" && atLeast(me.role, "approver") ? NO_ACCOUNT_MESSAGE : "Oracle can't reply right now.") : null,
    pushback: null,
    usage: null,
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
    const reply = wantsReply(d, row)
      ? push(d, { author_kind: "oracle", author_id: null, body: "", mentions: [], mentions_oracle: false, reply_to: row.id, status: "pending", citations: [] })
      : null;
    return json(201, { message, reply: reply ? messageOut(reply) : null });
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
        let text = "";
        for (const [i, piece] of CANNED_REPLY.entries()) {
          await new Promise((ok) => setTimeout(ok, i === 0 ? FIRST_MS : DELTA_MS));
          if (now().cancel_requested) {
            await write({ status: "cancelled", body: text, cancel_requested: false });
            controller.enqueue(event("done", messageOut({ ...x, status: "cancelled", body: text })));
            controller.close();
            return;
          }
          text += piece;
          controller.enqueue(event("delta", { text: piece }));
          await write({ body: text });
        }
        await write({ status: "complete", body: text, citations: CANNED_CITATIONS });
        controller.enqueue(event("citations", CANNED_CITATIONS));
        controller.enqueue(event("done", messageOut({ ...x, status: "complete", body: text, citations: CANNED_CITATIONS })));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  };

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
        .filter((d) => !(d.author_only && !isIn(d)))
        .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
      const items = rows.flatMap<Schemas["DiscussionSummary"] | Schemas["HiddenDiscussion"]>((d) =>
        readable(d)
          ? [summary(d)]
          : named && !mine
            ? [{ id: d.id, visibility: "private" as const, hidden: true as const, summary: d.summary_shared ? d.summary : null }]
            : [],
      );
      return json(200, { items, next: null });
    }
    if (m === "POST") {
      if (!atLeast(me.role, "commenter")) return refuse(403, "Requires the commenter role");
      const input = await body<Schemas["DiscussionCreate"]>();
      const info = ctx.resolve(input.subject_kind, input.subject ?? {});
      if ("status" in info) return refuse(info.status, info.detail);
      const picked = [...new Set(input.participants ?? [])].filter((id) => id !== me.id);
      const stranger = notMember(picked);
      if (stranger) return refuse(422, `${stranger} is not a member of this company`);
      const visibility = input.visibility ?? "open";
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
        origin: "discuss",
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
      if (input.message) {
        const res = post(d, input.message);
        if (!res.ok) return res;
      }
      return json(201, out(d));
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
      const day = new Date(ctx.now());
      push(d, {
        author_kind: "system",
        author_id: null,
        body: `${displayName(member(me.id)!.email)} made this discussion open on ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`,
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

  if (p[3] === "messages") {
    if (!p[4] && m === "GET") {
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
  if (p[3] === "changes" && m === "GET") {
    const status = q.get("status");
    return json(
      200,
      (db.changes ?? []).filter((c) => c.discussion_id === d.id && (!status || c.status === status)).map((c) => ({ ...c, discussion_id: undefined })),
    );
  }
  return null;
}
