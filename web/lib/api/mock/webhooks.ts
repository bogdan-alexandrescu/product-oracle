/**
 * I1 Settings › Webhooks in the mock, as oracle/webhooks/router.py answers: approvers and
 * owners (Q1; absent, 404, below approver), an approver's own webhooks and every one for an
 * owner, the signing secret once at create and rotate, owners-and-approvers content an
 * owner's change with a reason, take over, the delivery log, Send test event and Redeliver.
 *
 * The outbox posts to a stub receiver, never the network (the app's CSP allows `self`
 * only): a Playwright fixture exposes `window[WEBHOOK_RECEIVER]` (page.exposeFunction) and
 * answers each call; without one a delivery fails to connect and is retried, as an address
 * that refuses connections is. Bodies are signed as oracle/webhooks/sign.py signs them
 * (Standard Webhooks), with every secret in its 24-hour overlap.
 *
 * Runs' changes become run.* events (captureRunChanges, called around every mock call), sent
 * at once to each active webhook subscribed to them, as the minute tick would send them.
 *
 * The "webhooks" scenario seeds an approver's webhook paused for failing (with its 500s),
 * an approver's webhook an owner paused, and their Inbox rows (review-v2 notifications).
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["MemberOut"]["role"];
type WebhookOut = Schemas["WebhookOut"];
type DeliveryOut = Schemas["DeliveryOut"];
type Notification = Schemas["NotificationOut"] & { user_id: string };

export const WEBHOOKS_SCENARIO = "webhooks";
/** The window function the Playwright fixture's stub receiver is exposed as. */
export const WEBHOOK_RECEIVER = "__poWebhookReceiver";
export type ReceivedCall = { url: string; headers: Record<string, string>; body: string };
type Answer = { status: number; body: string };

const API_VERSION = "2026-10-25";
const MAX_PER_COMPANY = 10;
const OVERLAP_MS = 24 * 3600_000;
const TEST_MESSAGE = "Test from Product Oracle";

/** The registry (oracle/webhooks/events.py EVENT_TYPES), in its order. */
export const EVENT_TYPES: Schemas["EventTypeOut"][] = [
  ["run.awaiting_approval", "runs", "A run's estimate is over the limit and waits for an owner"],
  ["run.started", "runs", "A run started"],
  ["run.checkpoint_waiting", "runs", "A run is waiting at a checkpoint for a person"],
  ["run.checkpoint_decided", "runs", "A checkpoint was approved or sent back with changes"],
  ["run.checkpoint_voided", "runs", "A checkpoint decision was voided by a disable or demotion"],
  ["run.paused_overrun", "runs", "A run passed its spend limit; an owner must resume it"],
  ["run.resumed", "runs", "An owner resumed a run"],
  ["run.succeeded", "runs", "A run succeeded"],
  ["run.failed", "runs", "A run failed"],
  ["run.cancelled", "runs", "A run was cancelled"],
  ["draft.version_created", "drafts", "A new version of a document was imported"],
  ["draft.in_review", "drafts", "A document moved to In review"],
  ["approval.version_approved", "approvals", "A version was approved"],
  ["approval.approvals_invalidated", "approvals", "Approvals on a version lapsed or were voided"],
  ["approval.version_published", "approvals", "A version was published"],
].map(([type, group, label]) => ({ type, group: group as Schemas["EventTypeOut"]["group"], label, can_be_approvers_only: true }));

type HookRow = Omit<WebhookOut, "created_by" | "last_delivery" | "failing_since" | "can_take_over"> & {
  created_by: string;
  secret: string;
  previous_secret: string | null;
  previous_expires_at: string | null;
  /** When a person last resumed it: the failing count starts again there (API resumed_at). */
  resumed_at?: string | null;
};
type EventRow = { id: string; public_id: string; type: string; occurred_at: string; data: Record<string, unknown> };
type DeliveryRow = Omit<DeliveryOut, "event_id" | "event_type"> & { webhook_id: string; event: string };

export type WebhooksDb = { hooks: HookRow[]; events: EventRow[]; deliveries: DeliveryRow[] };

export type WebhooksContext = {
  db: WebhooksDb;
  me: { id: string; role: Role };
  members: { id: string; name: string; role: Role }[];
  notifications: Notification[];
  company: { id: string; name: string };
  uuid: () => string;
  now: () => string;
};

const ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ORDER.indexOf(role) >= ORDER.indexOf(min);
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, detail: string) => json(status, { detail });

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** whsec_ + 32 random bytes, base64: Oracle makes it; nobody picks it. */
function newSecret(): string {
  return `whsec_${b64(crypto.getRandomValues(new Uint8Array(32)))}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function publicId(): string {
  const r = crypto.getRandomValues(new Uint8Array(26));
  return `evt_${[...r].map((b) => CROCKFORD[b & 31]).join("")}`;
}

async function sign(secret: string, id: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return `v1,${b64(new Uint8Array(mac))}`;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** What _check_url refuses, in its words. */
function urlProblem(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "Not a URL";
  const v = url.trim();
  if (v.length > 2048) return "The URL is longer than 2048 characters";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Not a URL";
  }
  if (u.protocol !== "https:" || !u.hostname) return "Webhooks send to https:// addresses only";
  if (u.username || u.password) return "The URL may not hold a user name or password";
  return null;
}

function typesProblem(types: unknown): string | null {
  if (!Array.isArray(types) || types.length === 0) return "Pick at least one event";
  const unknown = types.filter((t) => !EVENT_TYPES.some((e) => e.type === t));
  return unknown.length ? `Unknown event types: ${unknown.join(", ")}` : null;
}
const ordered = (types: string[]) => EVENT_TYPES.map((e) => e.type).filter((t) => types.includes(t));

function nameOf(ctx: WebhooksContext, id: string) {
  return ctx.members.find((m) => m.id === id)?.name ?? "Someone";
}

function notify(ctx: WebhooksContext, to: string[], kind: Notification["kind"], title: string, hook: HookRow, actor: string, reason?: HookRow["paused_reason"]) {
  for (const user_id of new Set(to)) {
    if (actor === `user:${user_id}`) continue;
    ctx.notifications.push({
      id: ctx.uuid(), user_id, kind, title, document_id: null, version_number: null, section_key: null, comment_id: null, campaign_id: null,
      actor, data: { webhook_id: hook.id, href: "/settings/webhooks", ...(reason ? { reason } : {}) }, read_at: null, created_at: ctx.now(),
    });
  }
}
const owners = (ctx: WebhooksContext) => ctx.members.filter((m) => m.role === "owner").map((m) => m.id);

/**
 * The first failure of an unbroken run of failures, newest back; null after a success. A
 * resume starts the count again (outbox.failing_since): only tries after it count, and the
 * failing runs from the resume at the earliest.
 */
function failingSince(db: WebhooksDb, hook: HookRow): string | null {
  const resumed = hook.resumed_at ?? "";
  const ds = db.deliveries.filter((d) => d.webhook_id === hook.id && d.last_at && d.last_at > resumed).sort((a, b) => b.last_at!.localeCompare(a.last_at!));
  let since: string | null = null;
  for (const d of ds) {
    if (d.status === "succeeded") break;
    if (d.status === "failed" || d.status === "retrying") since = d.last_at;
  }
  return since && resumed > since ? resumed : since;
}

function hookOut(ctx: WebhooksContext, h: HookRow): WebhookOut {
  const rest: Partial<HookRow> = { ...h };
  for (const k of ["secret", "previous_secret", "previous_expires_at", "created_by", "resumed_at"] as const) delete rest[k];
  const created_by = h.created_by;
  const last = ctx.db.deliveries.filter((d) => d.webhook_id === h.id && d.last_at && d.status !== "withheld").sort((a, b) => b.last_at!.localeCompare(a.last_at!))[0];
  return {
    ...(rest as Omit<HookRow, "secret" | "previous_secret" | "previous_expires_at" | "created_by" | "resumed_at">),
    created_by: { name: nameOf(ctx, created_by) },
    last_delivery: last ? { status: last.status, at: last.last_at, http_status: last.http_status } : null,
    failing_since: failingSince(ctx.db, h),
    can_take_over: ctx.me.role === "owner" && h.status === "paused" && created_by !== ctx.me.id,
  };
}

function deliveryOut(db: WebhooksDb, d: DeliveryRow): DeliveryOut {
  const e = db.events.find((x) => x.id === d.event)!;
  const rest: Partial<DeliveryRow> = { ...d };
  delete rest.webhook_id;
  delete rest.event;
  return { ...(rest as Omit<DeliveryRow, "webhook_id" | "event">), event_id: e.public_id, event_type: e.type };
}

type Receiver = (call: ReceivedCall) => Promise<Answer>;
function receiver(): Receiver | null {
  const fn = (globalThis as Record<string, unknown>)[WEBHOOK_RECEIVER];
  return typeof fn === "function" ? (fn as Receiver) : null;
}

/** Send one delivery now (outbox.send_now): sign with every live secret, post, log it. */
async function sendNow(ctx: WebhooksContext, hook: HookRow, d: DeliveryRow): Promise<void> {
  const e = ctx.db.events.find((x) => x.id === d.event)!;
  const body = JSON.stringify({
    id: e.public_id, type: e.type, api_version: hook.api_version, occurred_at: e.occurred_at,
    company: ctx.company, data: e.data,
  });
  const started = Date.now();
  const ts = Math.floor(started / 1000);
  const secrets = [hook.secret];
  if (hook.previous_secret && hook.previous_expires_at && Date.parse(hook.previous_expires_at) > started) secrets.push(hook.previous_secret);
  const signature = (await Promise.all(secrets.map((s) => sign(s, e.public_id, ts, body)))).join(" ");
  const headers = {
    "webhook-id": e.public_id, "webhook-timestamp": String(ts), "webhook-signature": signature,
    "user-agent": "ProductOracle-Webhooks/1", "content-type": "application/json",
  };
  d.attempts += 1;
  d.last_at = new Date(started).toISOString();
  d.body = JSON.parse(body);
  const send = receiver();
  if (!send) {
    Object.assign(d, { status: "retrying", http_status: null, error: "connect", response_excerpt: null, duration_ms: 0, next_at: new Date(started + 60_000).toISOString() });
    return;
  }
  const answer = await send({ url: hook.url, headers, body });
  const ok = answer.status >= 200 && answer.status < 300;
  const retry = answer.status === 408 || answer.status === 429 || answer.status >= 500;
  Object.assign(d, {
    status: ok ? "succeeded" : retry ? "retrying" : "failed",
    http_status: answer.status,
    error: answer.status >= 300 && answer.status < 400 ? "redirect" : null,
    response_excerpt: (answer.body ?? "").slice(0, 2048),
    duration_ms: Math.max(1, Date.now() - started),
    next_at: ok || !retry ? null : new Date(started + 60_000).toISOString(),
  });
}

/** Seeds for the "webhooks" scenario; the empty db otherwise. */
export function seedWebhooks(ctx: Omit<WebhooksContext, "db">, scenario: string | null): WebhooksDb {
  const db: WebhooksDb = { hooks: [], events: [], deliveries: [] };
  if (scenario !== WEBHOOKS_SCENARIO) return db;
  const approver = ctx.members.find((m) => m.role === "approver");
  const owner = ctx.members.find((m) => m.role === "owner");
  if (!approver || !owner) return db;
  const at = (h: number) => new Date(Date.parse(ctx.now()) - h * 3600_000).toISOString();
  const hook = (name: string, path: string, reason: HookRow["paused_reason"]): HookRow => ({
    id: ctx.uuid(), name, url: `https://hooks.example.test/${path}`, host: "hooks.example.test",
    event_types: ["run.started", "run.succeeded", "run.failed"], api_version: API_VERSION, include_approvers_content: false,
    status: "paused", paused_reason: reason, secret_hint: "Ab3d", secret_rotated_at: at(100), created_at: at(100),
    created_by: approver.id, secret: newSecret(), previous_secret: null, previous_expires_at: null,
  });
  const deploy = hook("Deploy notifier", "deploy", "failing");
  const notes = hook("Release notes", "notes", "manual");
  db.hooks.push(deploy, notes);
  for (const [i, h] of [80, 60, 40, 20, 4].entries()) {
    const event: EventRow = { id: ctx.uuid(), public_id: publicId(), type: i % 2 ? "run.succeeded" : "run.started", occurred_at: at(h), data: { run: { flow: "brief_to_prd", status: "running" } } };
    db.events.push(event);
    db.deliveries.push({
      id: ctx.uuid(), webhook_id: deploy.id, event: event.id, status: i < 2 ? "failed" : "retrying", attempts: 6, next_at: null,
      last_at: at(h), http_status: 500, duration_ms: 230, error: null, response_excerpt: "Internal Server Error",
      body: { id: event.public_id, type: event.type }, redelivery_of: null, created_at: at(h),
    });
  }
  const note = (user_id: string, kind: Notification["kind"], title: string, hookId: string, actor: string, h: number, reason?: string): Notification => ({
    id: ctx.uuid(), user_id, kind, title, document_id: null, version_number: null, section_key: null, comment_id: null, campaign_id: null,
    actor, data: { webhook_id: hookId, href: "/settings/webhooks", ...(reason ? { reason } : {}) }, read_at: null, created_at: at(h),
  });
  ctx.notifications.push(
    note(owner.id, "webhook_paused", `Webhook ${deploy.name} paused: failing for 3 days`, deploy.id, "system", 2, "failing"),
    note(approver.id, "webhook_paused", `Webhook ${deploy.name} paused: failing for 3 days`, deploy.id, "system", 2, "failing"),
    note(owner.id, "webhook_url_changed", `${approver.name} changed where webhook ${deploy.name} sends`, deploy.id, `user:${approver.id}`, 3),
    note(approver.id, "webhook_paused", `${owner.name} paused your webhook ${notes.name}`, notes.id, `user:${owner.id}`, 5, "manual"),
  );
  return db;
}

/** /v1/webhook-event-types and /v1/webhooks/…; null for any other path. */
export async function webhooksRoute(ctx: WebhooksContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "webhooks" && p[1] !== "webhook-event-types") return null;
  const m = req.method;
  if (!atLeast(ctx.me.role, "approver")) return refuse(404, "Not found");
  const db = ctx.db;
  const actor = `user:${ctx.me.id}`;
  const body = async () => (JSON.parse((await req.text()) || "{}") ?? {}) as Record<string, unknown>;
  if (p[1] === "webhook-event-types") return m === "GET" ? json(200, EVENT_TYPES) : null;
  const mine = (h: HookRow) => ctx.me.role === "owner" || h.created_by === ctx.me.id;

  if (!p[2]) {
    if (m === "GET") return json(200, db.hooks.filter(mine).map((h) => hookOut(ctx, h)));
    if (m !== "POST") return null;
    const b = await body();
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 80) return refuse(422, "A name is required");
    const bad = urlProblem(b.url) ?? typesProblem(b.event_types);
    if (bad) return refuse(422, bad);
    if (db.hooks.length >= MAX_PER_COMPANY) return refuse(422, `A company has at most ${MAX_PER_COMPANY} webhooks`);
    const approvers = !!b.include_approvers_content;
    if (approvers && ctx.me.role !== "owner") return refuse(422, "Only an owner can include owners-and-approvers content");
    if (approvers && !String(b.reason ?? "").trim()) return refuse(422, "Say why owners-and-approvers content changes");
    const secret = newSecret();
    const url = String(b.url).trim();
    const hook: HookRow = {
      id: ctx.uuid(), name, url, host: hostOf(url), event_types: ordered(b.event_types as string[]), api_version: API_VERSION,
      include_approvers_content: approvers, status: "active", paused_reason: null, secret_hint: secret.slice(-4),
      secret_rotated_at: ctx.now(), created_at: ctx.now(), created_by: ctx.me.id, secret, previous_secret: null, previous_expires_at: null,
    };
    db.hooks.push(hook);
    return json(201, { webhook: hookOut(ctx, hook), secret });
  }

  const hook = db.hooks.find((h) => h.id === p[2]);
  if (!hook || !mine(hook)) return refuse(404, "Not found");

  if (!p[3]) {
    if (m === "GET") return json(200, hookOut(ctx, hook));
    if (m === "DELETE") {
      db.hooks = db.hooks.filter((h) => h !== hook);
      db.deliveries = db.deliveries.filter((d) => d.webhook_id !== hook.id);
      return json(204, null);
    }
    if (m !== "PATCH") return null;
    const b = await body();
    if (b.url != null) {
      const bad = urlProblem(b.url);
      if (bad) return refuse(422, bad);
    }
    if (b.event_types != null) {
      const bad = typesProblem(b.event_types);
      if (bad) return refuse(422, bad);
    }
    if (b.include_approvers_content != null && b.include_approvers_content !== hook.include_approvers_content) {
      if (ctx.me.role !== "owner") return refuse(422, "Only an owner can include owners-and-approvers content");
      if (!String(b.reason ?? "").trim()) return refuse(422, "Say why owners-and-approvers content changes");
      if (b.include_approvers_content && ctx.members.find((x) => x.id === hook.created_by)?.role !== "owner") {
        return refuse(422, "Owners-and-approvers content goes only to a webhook an owner created");
      }
      hook.include_approvers_content = !!b.include_approvers_content;
    }
    if (typeof b.name === "string" && b.name.trim()) hook.name = b.name.trim();
    if (typeof b.url === "string" && b.url.trim() !== hook.url) {
      hook.url = b.url.trim();
      hook.host = hostOf(hook.url);
      if (ctx.me.role !== "owner") notify(ctx, owners(ctx), "webhook_url_changed", `${nameOf(ctx, ctx.me.id)} changed where webhook ${hook.name} sends`, hook, actor);
    }
    if (Array.isArray(b.event_types)) hook.event_types = ordered(b.event_types as string[]);
    if ((b.status === "active" || b.status === "paused") && b.status !== hook.status) {
      hook.status = b.status;
      hook.paused_reason = b.status === "paused" ? "manual" : null;
      if (b.status === "active") hook.resumed_at = ctx.now();
      if (b.status === "paused" && hook.created_by !== ctx.me.id) {
        notify(ctx, [hook.created_by], "webhook_paused", `${nameOf(ctx, ctx.me.id)} paused your webhook ${hook.name}`, hook, actor, "manual");
      }
    }
    return json(200, hookOut(ctx, hook));
  }

  if (p[3] === "rotate-secret" && m === "POST") {
    const b = await body();
    const secret = newSecret();
    const endOld = !!b.end_old_now;
    hook.previous_secret = endOld ? null : hook.secret;
    hook.previous_expires_at = endOld ? null : new Date(Date.parse(ctx.now()) + OVERLAP_MS).toISOString();
    hook.secret = secret;
    hook.secret_hint = secret.slice(-4);
    hook.secret_rotated_at = ctx.now();
    return json(200, { webhook: hookOut(ctx, hook), secret });
  }
  if (p[3] === "take-over" && m === "POST") {
    if (ctx.me.role !== "owner") return refuse(403, "Only an owner can take over a webhook");
    if (hook.status !== "paused" || hook.created_by === ctx.me.id) return refuse(409, "Only a paused webhook of someone else can be taken over");
    hook.created_by = ctx.me.id;
    return json(200, hookOut(ctx, hook));
  }
  if (p[3] === "test" && m === "POST") {
    const event: EventRow = { id: ctx.uuid(), public_id: publicId(), type: "webhook.test", occurred_at: ctx.now(), data: { message: TEST_MESSAGE } };
    db.events.push(event);
    const d: DeliveryRow = newDelivery(ctx, hook, event.id, null);
    await sendNow(ctx, hook, d);
    return json(200, deliveryOut(db, d));
  }
  if (p[3] === "deliveries") {
    const visible = db.deliveries.filter((d) => d.webhook_id === hook.id && (ctx.me.role === "owner" || d.status !== "withheld"));
    if (!p[4] && m === "GET") {
      const status = q.get("status");
      const type = q.get("type");
      const before = q.get("before");
      const rows = visible
        .filter((d) => (!status || d.status === status) && (!type || db.events.find((e) => e.id === d.event)?.type === type) && (!before || d.created_at < before))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const items = rows.slice(0, 50).map((d) => deliveryOut(db, d));
      return json(200, { items, next_before: rows.length > 50 ? items[items.length - 1].created_at : null });
    }
    const d = visible.find((x) => x.id === p[4]);
    if (!d) return refuse(404, "Not found");
    if (!p[5] && m === "GET") return json(200, deliveryOut(db, d));
    if (p[5] === "redeliver" && m === "POST") {
      const again = newDelivery(ctx, hook, d.event, d.id);
      await sendNow(ctx, hook, again);
      return json(200, deliveryOut(db, again));
    }
  }
  return null;
}

function newDelivery(ctx: WebhooksContext, hook: HookRow, event: string, of: string | null): DeliveryRow {
  // A millisecond apart, so a redelivery sorts above what it sends again.
  const last = ctx.db.deliveries.reduce((t, x) => (x.created_at > t ? x.created_at : t), "");
  const at = new Date(Math.max(Date.parse(ctx.now()), last ? Date.parse(last) + 1 : 0)).toISOString();
  const d: DeliveryRow = {
    id: ctx.uuid(), webhook_id: hook.id, event, status: "pending", attempts: 0, next_at: null, last_at: null, http_status: null,
    duration_ms: null, error: null, response_excerpt: null, body: null, redelivery_of: of, created_at: at,
  };
  ctx.db.deliveries.push(d);
  return d;
}

/** What captureRunChanges compares: each run's status and its checkpoints' statuses. */
type RunLike = { id: string; flow: string; status: string; checkpoints: { id: string; kind: string; status: string; approver_role: string }[] };
export type RunMarks = Record<string, { status: string; checkpoints: Record<string, string> }>;

export function runMarks(runs: RunLike[] | undefined): RunMarks {
  return Object.fromEntries((runs ?? []).map((r) => [r.id, { status: r.status, checkpoints: Object.fromEntries(r.checkpoints.map((c) => [c.id, c.status])) }]));
}

const STARTS_FROM = new Set([undefined, "draft", "awaiting_approval"]);
const RUN_STATUS_EVENT: Record<string, string> = {
  awaiting_approval: "run.awaiting_approval",
  paused_overrun: "run.paused_overrun",
  succeeded: "run.succeeded",
  failed: "run.failed",
  cancelled: "run.cancelled",
};

/**
 * The run.* events a mock call made (oracle.webhooks.capture in the runs' transactions):
 * a run started (or resumed) first, then its checkpoints waiting or decided, then the run's
 * own new state; each sent at once to the active webhooks subscribed to it.
 */
export async function captureRunChanges(ctx: WebhooksContext, before: RunMarks, runs: RunLike[] | undefined): Promise<void> {
  const hooks = ctx.db.hooks.filter((h) => h.status === "active");
  if (!hooks.length) return;
  for (const r of runs ?? []) {
    const was = before[r.id];
    const runOut = { id: r.id, flow: r.flow, status: r.status, title: null, url: `/runs/${r.id}`, error_kind: null };
    const actor = { kind: "person", name: nameOf(ctx, ctx.me.id) };
    const types: [string, Record<string, unknown>][] = [];
    if (was?.status !== r.status) {
      if (r.status === "running" && STARTS_FROM.has(was?.status)) types.push(["run.started", { run: runOut, actor }]);
      if (r.status === "running" && was?.status === "paused_overrun") types.push(["run.resumed", { run: runOut, actor }]);
    }
    for (const c of r.checkpoints) {
      const prev = was?.checkpoints[c.id];
      if (prev === c.status) continue;
      const checkpoint = { id: c.id, kind: c.kind, approver_role: c.approver_role, url: `/runs/${r.id}#decide` };
      if (c.status === "pending") types.push(["run.checkpoint_waiting", { run: runOut, checkpoint, actor: { kind: "oracle", name: null } }]);
      if (prev === "pending" && (c.status === "approved" || c.status === "changes_requested")) {
        types.push(["run.checkpoint_decided", { run: runOut, checkpoint: { ...checkpoint, outcome: c.status }, actor }]);
      }
    }
    if (was?.status !== r.status && RUN_STATUS_EVENT[r.status]) types.push([RUN_STATUS_EVENT[r.status], { run: runOut, actor }]);
    for (const [type, data] of types) {
      const event: EventRow = { id: ctx.uuid(), public_id: publicId(), type, occurred_at: ctx.now(), data };
      ctx.db.events.push(event);
      for (const hook of hooks.filter((h) => h.event_types.includes(type))) await sendNow(ctx, hook, newDelivery(ctx, hook, event.id, null));
    }
  }
}
