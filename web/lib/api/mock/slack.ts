/**
 * The G8 Slack bridge in the mock: Oracle's Slack install as discussions see it (status),
 * the channels the app is in, a discussion's link to a Slack thread (Mirror to Slack, Stop
 * mirroring), and a test hook that brings a reply "from the Slack thread" into a mirrored
 * discussion. The install itself is F6's (./reports.ts keeps it); nothing here calls Slack.
 *
 * The "slack-bridge" scenario seeds the "discussion-replies" discussions, Oracle's Slack
 * install with the bridge's scopes, and one open discussion mirrored to #product.
 */
import type { Schemas } from "@/lib/api/client";

import { seedDiscussionReplies, type DiscussionRow, type DiscussionsContext, type DiscussionsDb } from "./discussions";

type Integration = Schemas["CompanyIntegrationOut"];
type Role = Schemas["MemberOut"]["role"];
type Link = Schemas["DiscussionSlackOut"];

export const SLACK_SCENARIO = "slack-bridge";
/** The seeded discussion that is mirrored to #product in the "slack-bridge" scenario. */
export const MIRRORED_TITLE = "Alert digests: daily or weekly?";
/** F6's bot scopes, then the ones G8 adds to read who replied (users:read.email). */
export const F6_SCOPES = ["chat:write", "chat:write.public", "channels:read"];
export const BRIDGE_SCOPES = [...F6_SCOPES, "groups:read", "users:read", "users:read.email"];

/** The channels Oracle's app is in: public ones, and a private one it was invited to. */
export const SLACK_CHANNELS: Schemas["NotificationChannelOut"][] = [
  { id: "C0ENG", name: "eng", is_private: false },
  { id: "G0LEADS", name: "leads", is_private: true },
  { id: "C0PLAN", name: "plan", is_private: false },
  { id: "C0PRODUCT", name: "product", is_private: false },
];

/** A made-up Slack thread link (never a real company's Slack). */
const threadUrl = (channelId: string, seq: number) => `https://example-co.slack.com/archives/${channelId}/p17610400000${String(seq).padStart(5, "0")}`;

/** Oracle's Slack install for the mock company ("Example Co"). */
export function slackInstall(installedBy: string, id: string, createdAt: string, scopes: string[] = BRIDGE_SCOPES): Integration {
  return {
    id,
    provider: "slack",
    purpose: "notifications",
    account_id: "T0EXAMPLE",
    account_label: "Example Co",
    scopes,
    status: "active",
    last_error: null,
    installed_by: installedBy,
    created_at: createdAt,
  };
}

/** True when the install lacks a scope the bridge needs: the card asks an owner to reconnect. */
export const needsReconnect = (i: Integration | null) => !!i && BRIDGE_SCOPES.some((s) => !(i.scopes ?? []).includes(s));

export function slackStatus(i: Integration | null): Schemas["SlackStatusOut"] {
  const reconnect = needsReconnect(i);
  return { connected: !!i, label: i ? (i.account_label ?? i.account_id) : null, mirroring: !!i && !reconnect, needs_reconnect: reconnect };
}

/** Disconnect: every mirrored thread gets its closing line and stops mirroring. */
export function unlinkAll(db: DiscussionsDb | undefined) {
  for (const d of db?.discussions ?? []) d.slack = null;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, detail: string) => json(status, { detail });
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

/** GET /v1/company-integrations/slack/status (any member) and …/slack/channels (commenters and up); null otherwise. */
export function slackRoute(integration: Integration | null, me: { role: Role }, req: Request, p: string[]): Response | null {
  if (p[1] !== "company-integrations" || p[2] !== "slack" || req.method !== "GET") return null;
  if (p[3] === "status") return json(200, slackStatus(integration));
  if (p[3] === "channels") {
    if (RANK[me.role] < RANK.commenter) return refuse(403, "Requires the commenter role");
    if (!integration) return refuse(409, "Connect Slack for notifications first");
    return json(200, SLACK_CHANNELS);
  }
  return null;
}

/**
 * POST/DELETE /v1/discussions/{id}/slack, after the discussions route found `d` and checked
 * the caller may read it: the starter or an approver, an open discussion, never a private one.
 */
export async function discussionSlackRoute(
  d: DiscussionRow,
  ctx: { me: { id: string; role: Role }; integration: Integration | null },
  req: Request,
): Promise<Response | null> {
  if (!(d.started_by === ctx.me.id || RANK[ctx.me.role] >= RANK.approver)) return refuse(403, "Only the starter or an approver can mirror it to Slack");
  if (req.method === "DELETE") {
    d.slack = null;
    return json(204, null);
  }
  if (req.method !== "POST") return null;
  if (d.status === "closed") return refuse(409, "This discussion is closed");
  if (d.visibility === "private") return refuse(422, "Private discussions stay in Oracle");
  if (!ctx.integration) return refuse(409, "An owner connects Oracle to Slack in Settings");
  if (needsReconnect(ctx.integration)) return refuse(409, "Reconnect Slack to allow mirroring discussions");
  if (d.slack) return refuse(409, `Already mirrored to #${d.slack.channel_name}`);
  const { channel_id } = (JSON.parse((await req.text()) || "{}") ?? {}) as Partial<Schemas["DiscussionSlackIn"]>;
  const channel = SLACK_CHANNELS.find((c) => c.id === channel_id);
  if (!channel) return refuse(422, "Invite @Product Oracle to the channel first");
  const link: Link = { channel_name: channel.name, thread_url: threadUrl(channel.id, d.lock_version), status: "live", error: null };
  d.slack = link;
  return json(201, link);
}

/**
 * The "slack-bridge" scenario: "discussion-replies", plus an open discussion the approver
 * started on the same Problem, already mirrored to #product.
 */
export function seedSlackBridge(ctx: Omit<DiscussionsContext, "me" | "db">, documentId: string, label: string, url: string): DiscussionsDb {
  const db = seedDiscussionReplies(ctx, documentId, label, url);
  const approver = ctx.members.find((m) => m.email === "approver@example.com")!.id;
  const at = "2026-10-21T11:00:00Z";
  const mirrored: DiscussionRow = {
    ...db.discussions[0],
    id: ctx.uuid(),
    title: MIRRORED_TITLE,
    visibility: "open",
    summary_shared: true,
    started_by: approver,
    private_findings: null,
    last_message_at: at,
    created_at: at,
    updated_at: at,
    slack: { channel_name: "product", thread_url: threadUrl("C0PRODUCT", 1), status: "live", error: null },
  };
  db.discussions.push(mirrored);
  db.participants.push({ discussion_id: mirrored.id, user_id: approver, added_via: "started", left_at: null, last_read_at: null, created_at: at });
  db.messages.push({
    id: ctx.uuid(),
    discussion_id: mirrored.id,
    author_kind: "person",
    author_id: approver,
    body: "Daily digests or weekly? Asking the team in #product too.",
    mentions: [],
    mentions_oracle: false,
    reply_to: null,
    created_at: at,
    edited_at: null,
    deleted_at: null,
  });
  return db;
}

/**
 * Test hook: a reply in the mirrored thread from the member with `email`, as the events
 * endpoint would store it (via "slack"). Refused, as the API would drop it, when the
 * discussion is not mirrored or the author cannot write in it.
 */
export function injectSlackReply(
  db: DiscussionsDb,
  members: { id: string; email: string; role: Role; status?: string | null }[],
  input: { title: string; email: string; text: string },
  at: string,
  id: string,
): string {
  const d = db.discussions.find((x) => x.title === input.title);
  if (!d?.slack) throw new Error(`"${input.title}" is not mirrored to Slack`);
  const who = members.find((m) => m.email === input.email);
  if (!who || who.status === "disabled" || RANK[who.role] < RANK.commenter) throw new Error(`${input.email} cannot write here: the reply is not kept`);
  db.messages.push({
    id,
    discussion_id: d.id,
    author_kind: "person",
    author_id: who.id,
    body: input.text,
    mentions: [],
    mentions_oracle: false,
    reply_to: null,
    created_at: at,
    edited_at: null,
    deleted_at: null,
    via: "slack",
  });
  d.last_message_at = at;
  if (!db.participants.some((x) => x.discussion_id === d.id && x.user_id === who.id && !x.left_at))
    db.participants.push({ discussion_id: d.id, user_id: who.id, added_via: "posted", left_at: null, last_read_at: null, created_at: at });
  return id;
}

/**
 * Test hook: Slack gave up on the first post of the discussion titled `title` (the outbox's
 * last try failed with `error`), so the mirror is failed: no thread, and Slack's reason.
 */
export function failSlackMirror(db: DiscussionsDb, input: { title: string; error: string }) {
  const d = db.discussions.find((x) => x.title === input.title);
  if (!d?.slack) throw new Error(`"${input.title}" is not mirrored to Slack`);
  d.slack = { ...d.slack, thread_url: null, status: "failed", error: input.error };
}

/**
 * Test hook: Slack has not taken the first post of the discussion titled `title` yet (the
 * outbox still holds it), so the mirror has no thread.
 */
export function holdSlackMirror(db: DiscussionsDb, input: { title: string }) {
  const d = db.discussions.find((x) => x.title === input.title);
  if (!d?.slack) throw new Error(`"${input.title}" is not mirrored to Slack`);
  d.slack = { ...d.slack, thread_url: null, status: "posting", error: null };
}
