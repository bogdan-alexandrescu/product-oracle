/**
 * Mock of the connections and company settings endpoints (mock mode only). Kept apart
 * from server.ts; state lives in its own localStorage key.
 *
 * Token rules: anything starting with "bad" is rejected; a Google token starting with
 * "legacy" has the short-lived drive.file grant, which cannot read folders ("Reconnect to
 * choose files"). OAuth is
 * "configured" for GitHub and Google: authorize connects at once and sends the browser
 * straight back to the page. The Drive picker config is a fake (e2e mocks Google itself).
 * Claude is not a connection: see ./claude-accounts.ts.
 */
import type { Schemas } from "@/lib/api/client";

import { FIREFLIES_CONNECTION_ID } from "./fireflies";
import { MOCK_NOTION_CONNECTION_ID, notionPages } from "./notion";

type ConnectionRow = Schemas["ConnectionOut"];

interface ConnDb {
  connections: ConnectionRow[];
  settings: Record<string, unknown>;
}

const STORAGE_KEY = "po-mock-connections-v1";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
export const MOCK_PICKER_CONFIG: Schemas["PickerConfigOut"] = {
  client_id: "000000000000-mock.apps.googleusercontent.com",
  app_id: "000000000000",
  developer_key: "mock-browser-key",
};

/** As oracle.connections.providers.reconnect_reason. */
export function reconnectReason(provider: string, scopes: string[]): string | null {
  return provider === "google" && scopes.length > 0 && !scopes.includes(DRIVE_READONLY) ? "Reconnect to choose files" : null;
}
const PROVIDERS: Schemas["ProviderOut"][] = [
  {
    key: "github",
    name: "GitHub",
    source_kinds: ["github"],
    oauth_configured: true,
    oauth_scopes: ["read:user", "repo"],
    token_help: "A fine-grained personal access token with read access to the repos to pull in.",
  },
  {
    key: "slack",
    name: "Slack",
    source_kinds: ["slack"],
    oauth_configured: false,
    oauth_scopes: ["channels:history", "channels:read", "groups:history", "groups:read", "users:read"],
    token_help: "A Slack user token from a Slack app. Direct messages are never read.",
  },
  {
    key: "notion",
    name: "Notion",
    source_kinds: ["notion"],
    oauth_configured: false,
    oauth_scopes: [],
    token_help: "An internal integration secret; share the pages to pull in with the integration.",
  },
  {
    key: "fireflies",
    name: "Fireflies",
    source_kinds: ["fireflies"],
    oauth_configured: false,
    oauth_scopes: [],
    token_help: "Your API key from app.fireflies.ai, Settings > Developer settings.",
  },
  {
    key: "google",
    name: "Google Docs",
    source_kinds: ["google_docs"],
    oauth_configured: true,
    oauth_scopes: ["openid", "email", DRIVE_READONLY],
    token_help: "Google access tokens expire within an hour; connect with Google sign-in.",
  },
];

const SETTING_DEFAULTS: Record<string, unknown> = {
  iap_default_role: "commenter",
  // A5: a Google sign-in without an invite asks an owner (request), joins (join) or is refused (refuse).
  sign_in_without_invite: "request",
  confidence_weights: {},
  blocker_risk_acceptance_role: "owner",
  blocker_risk_review_max_days: 90,
  // H1: hard-to-reverse decisions are an owner's call unless an owner lowers it.
  decision_irreversible_role: "owner",
  // S5 (owner settings, Settings > Sources > Google Drive). The API's default is []; the
  // mock company's members are all @example.com.
  company_email_domains: ["example.com"],
  company_shared_drives: [],
  // A1, B2 Goals framework: Now = the current quarter, Next = the next 2, Later = 12-24 months.
  planning_horizons: { short_quarters: 1, medium_quarters: 2, long_from_months: 12, long_to_months: 24 },
  // F6: the weekly alignment report, Monday 08:00 in the Company time zone; the channel once Slack is connected.
  alignment_report: { enabled: true, weekday: "mon", time: "08:00", slack_channel: null },
  // The Company time zone: goals' today, the weekly report and rituals (Los Angeles until an
  // owner sets one, owner decision 2026-10-22).
  company_timezone: "America/Los_Angeles",
  // H9: the pricing owner's member id; null is the earliest active owner.
  pricing_owner: null,
  // INT2: Oracle reads new intakes ($1.50 a read), on by default (owner answer Q2).
  intake_ai_read: true,
  // Code maps (owner, 2026-10-26): a stale map's refresh at most daily.
  code_map_refresh: "daily",
};

/** A company setting's value as stored, else its default (./reports.ts reads the report's channel). */
export function mockSettingValue(key: string): unknown {
  const db = load();
  return key in db.settings ? db.settings[key] : SETTING_DEFAULTS[key];
}

export function companyZone(): string {
  const zone = String(mockSettingValue("company_timezone") ?? "America/Los_Angeles");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "America/Los_Angeles";
  }
}

function companyParts(at: string | Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: companyZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(at));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** "2026-10-12": the Company time zone's day at `at`, as oracle.company_time.day (#463). */
export function companyDayIso(at: string | Date): string {
  const p = companyParts(at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-12 13:00 PDT": `at` in the Company time zone, as oracle.company_time.stamp (#463). */
export function companyStamp(at: string | Date): string {
  const p = companyParts(at);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "Oct 12": the Company time zone's day at `at`, as the API words a day in text it writes (#463). */
export function companyDayInWords(at: string | Date): string {
  const options = { month: "short", day: "numeric" } as const;
  try {
    const timeZone = String(mockSettingValue("company_timezone") ?? "America/Los_Angeles");
    return new Date(at).toLocaleDateString("en-US", { ...options, timeZone });
  } catch {
    return new Date(at).toLocaleDateString("en-US", { ...options, timeZone: "America/Los_Angeles" });
  }
}

/** Stores a company setting's value, as PUT /v1/settings/{key} would. */
export function setMockSetting(key: string, value: unknown) {
  const db = load();
  db.settings[key] = value;
  save(db);
}

const HORIZON_KEYS = ["short_quarters", "medium_quarters", "long_from_months", "long_to_months"];

/** As oracle.tenant_settings_api.validate_planning_horizons: the message, or null when valid. */
function horizonsError(value: unknown): string | null {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== HORIZON_KEYS.length ||
    !HORIZON_KEYS.every((k) => Number.isInteger(v[k]))
  ) {
    return "planning_horizons needs short_quarters, medium_quarters, long_from_months and long_to_months as whole numbers";
  }
  const [short, medium, from, to] = HORIZON_KEYS.map((k) => v[k] as number);
  if (short < 1 || short > 2) return "short_quarters must be 1 or 2";
  if (medium < 1 || medium > 4) return "medium_quarters must be between 1 and 4";
  const nextEnds = 3 * (short + medium);
  if (from < nextEnds || from > 36) return `long_from_months must start after Next ends (at least ${nextEnds} months) and be at most 36`;
  if (to <= from || to > 60) return "long_to_months must be after long_from_months and at most 60";
  return null;
}

/** A mail provider anyone can sign up with, which the API refuses as a company domain. */
function publicMailDomain(domain: string): boolean {
  if (["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"].includes(domain)) {
    return true;
  }
  return /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|aol|icloud|protonmail|gmx|yandex)\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(domain);
}

/** The shared drives a mock Google connection can see. */
export const MOCK_SHARED_DRIVES = [
  { id: "0ADriveProductExample", name: "Product" },
  { id: "0ADriveDesignExample", name: "Design" },
  { id: "0ADrivePartnerAcmeExample", name: "Partner: Acme" },
];

/** As oracle.sources.connectors.fireflies.DEFAULT_ENDPOINT. */
export const FIREFLIES_DEFAULT_ENDPOINT = "https://api.fireflies.ai/graphql";
const PRIVATE_ENDPOINT = "The endpoint points to a private, local or internal network address, which Product Oracle does not call.";
const OWNER_ONLY = "Only an Oracle owner can set or change a Fireflies endpoint";
const ANOTHER_ACCOUNT = "That key belongs to another Fireflies account than this connection's; connect it as a new connection";
const ODD_IPV4 = "The endpoint writes an IP address in an octal, hex or shortened form; write it as four decimal numbers, or use the host name.";

function privateIp(host: string): boolean {
  let h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) h = mapped[1];
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(host.replace(/^\[|\]$/g, "").toLowerCase())) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224 || (a === 198 && (b === 18 || b === 19));
  }
  if (h.includes(":")) return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h);
  return !h.includes(".");
}

/**
 * As oracle.sources.connectors.fireflies.check_endpoint: the normalized endpoint, null for
 * the default, or the API's refusal in words. (Where a name resolves is checked by the
 * API's guarded transport; the mock resolves nothing.)
 */
export function checkEndpoint(raw: string | null | undefined): { url: string | null } | { error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { url: null };
  if (!/^https:\/\//i.test(text)) return { error: "The endpoint must be an https:// URL." };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { error: "The endpoint is not a valid URL." };
  }
  if (u.username || u.password || /^https:\/\/[^/]*@/i.test(text)) return { error: "The endpoint cannot contain a user name or password." };
  const port = /^https:\/\/(?:\[[^\]]*\]|[^/:?#]*):(\d*)/i.exec(text)?.[1];
  if (port !== undefined && port !== "443") return { error: "The endpoint must use the standard https port (443)." };
  if (u.search || u.hash || /[?#]/.test(text)) return { error: "The endpoint cannot have a query or a fragment." };
  // As the API: a host whose last label is a number reads as an IPv4 address (0177.0.0.1,
  // 0x7f000001, 127.1); unless written as four decimal numbers it is refused. (The browser
  // has already read it as the address it means, or refused it as not a valid URL.)
  const host = (/^https:\/\/([^/?#]*)/i.exec(text)?.[1] ?? "").replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase();
  const plainV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  if (!host.startsWith("[") && /^(0x[0-9a-f]*|\d+)$/.test(host.split(".").pop() ?? "") && !plainV4.test(host)) {
    return { error: privateIp(u.hostname) ? PRIVATE_ENDPOINT : ODD_IPV4 };
  }
  if (privateIp(u.hostname)) return { error: PRIVATE_ENDPOINT };
  const url = `https://${u.hostname.toLowerCase()}${u.pathname || "/"}`;
  return { url: url === FIREFLIES_DEFAULT_ENDPOINT ? null : url };
}

/** The endpoint a mock connection reads (the Sources page shows it); null when unknown. */
export function mockConnectionEndpoint(id: string): string | null {
  const row = load().connections.find((c) => c.id === id);
  return row ? (row.endpoint_url ?? FIREFLIES_DEFAULT_ENDPOINT) : null;
}

/** #710: the active Fireflies connections, read live (./live.ts); the mock's store is everyone's. */
export function liveConnections(): ConnectionRow[] {
  return load().connections.filter((c) => c.provider === "fireflies" && c.status === "active");
}

function load(): ConnDb {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ConnDb;
  } catch {
    // fall through to a fresh state
  }
  return { connections: [], settings: {} };
}

/** A company setting as the mock stores it (its default when unset). */
export function mockSetting(key: string): unknown {
  const db = load();
  return key in db.settings ? db.settings[key] : SETTING_DEFAULTS[key];
}

function save(db: ConnDb) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const now = () => new Date().toISOString();

function identity(provider: string, token: string): { account_id: string; label: string; scopes: string[] } | string {
  if (token.startsWith("bad")) return `${PROVIDERS.find((p) => p.key === provider)?.name ?? provider} rejected the token (401)`;
  const labels: Record<string, string> = {
    github: "example-user",
    slack: "pat @ Example",
    notion: "Example Notion",
    fireflies: "pat@example.com",
    google: "pat@example.com",
  };
  const google = token.startsWith("legacy") ? ["openid", "email", DRIVE_FILE] : ["openid", "email", DRIVE_READONLY];
  const scopes = provider === "github" ? ["repo"] : provider === "google" ? google : [];
  return { account_id: `${provider}-1`, label: labels[provider] ?? provider, scopes };
}

function upsert(
  db: ConnDb,
  provider: string,
  auth_mode: "oauth" | "token",
  who: { account_id: string; label: string; scopes: string[] },
  label?: string | null,
): ConnectionRow {
  let row = db.connections.find((c) => c.provider === provider && c.account_id === who.account_id);
  if (!row) {
    row = {
      // The mock's one Fireflies account is the one the Sources page's Fireflies source reads.
      id: provider === "fireflies" && !db.connections.some((c) => c.id === FIREFLIES_CONNECTION_ID) ? FIREFLIES_CONNECTION_ID : crypto.randomUUID(),
      provider,
      auth_mode,
      account_id: who.account_id,
      account_label: null,
      scopes: [],
      status: "active",
      last_error: null,
      expires_at: null,
      last_used_at: null,
      created_at: now(),
      updated_at: now(),
    };
    db.connections.push(row);
  }
  Object.assign(row, {
    auth_mode,
    account_label: label || who.label,
    scopes: auth_mode === "oauth" ? (PROVIDERS.find((p) => p.key === provider)?.oauth_scopes ?? []) : who.scopes,
    status: "active",
    last_error: null,
    expires_at: auth_mode === "oauth" ? new Date(Date.now() + 3600_000).toISOString() : null,
    updated_at: now(),
  });
  return row;
}

function out(_db: ConnDb, c: ConnectionRow): ConnectionRow {
  return {
    ...c,
    reconnect_reason: reconnectReason(c.provider, c.scopes),
    endpoint_url: c.provider === "fireflies" ? (c.endpoint_url ?? FIREFLIES_DEFAULT_ENDPOINT) : null,
  };
}

function settingOut(db: ConnDb, key: string): Schemas["SettingOut"] {
  const stored = key in db.settings;
  return {
    key,
    value: stored ? db.settings[key] : SETTING_DEFAULTS[key],
    default: SETTING_DEFAULTS[key],
    is_default: !stored,
    updated_at: null,
  };
}

/**
 * What the Set up checklist reads from this store (A1): active connections, the company's
 * domains and whether the horizons were confirmed (a stored row).
 */
export function setupFacts(): { connections: number; domains: string[]; horizons: boolean; timezone: string | null } {
  const db = load();
  const domains = ("company_email_domains" in db.settings ? db.settings.company_email_domains : SETTING_DEFAULTS.company_email_domains) as string[];
  return {
    connections: db.connections.filter((c) => c.status === "active").length,
    domains,
    horizons: "planning_horizons" in db.settings,
    timezone: "company_timezone" in db.settings ? String(db.settings.company_timezone) : null,
  };
}

/** Handles /v1/connections… and /v1/settings…; null for other routes. */
export async function connectionsRoute(req: Request, p: string[], role: string = "owner"): Promise<Response | null> {
  if (p[1] !== "connections" && p[1] !== "settings") return null;
  const db = load();
  const res = await handle(db, req, p, role);
  save(db);
  return res;
}

async function handle(db: ConnDb, req: Request, p: string[], role: string): Promise<Response> {
  const m = req.method;
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "settings") {
    if (!p[2] && m === "GET") return json(200, Object.keys(SETTING_DEFAULTS).map((k) => settingOut(db, k)));
    const key = p[2];
    if (!(key in SETTING_DEFAULTS)) return json(404, { detail: `Unknown setting '${key}'` });
    if (m === "GET") return json(200, settingOut(db, key));
    if (m === "PUT") {
      const { value: given } = await body<Schemas["SettingIn"]>();
      let value = given;
      if (key === "alignment_report" && value && typeof value === "object") {
        // As the API: a partial value takes the defaults for the rest.
        value = { ...(SETTING_DEFAULTS.alignment_report as object), ...(value as object) };
        const v = value as { weekday: string; time: string };
        if (!["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(v.weekday)) return json(422, { detail: "alignment_report.weekday must be one of mon, tue, wed, thu, fri, sat, sun" });
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) return json(422, { detail: "alignment_report.time must be HH:MM, 00:00 to 23:59" });
        const unknown = Object.keys(value as object).find((k) => !(k in (SETTING_DEFAULTS.alignment_report as object)));
        if (unknown) return json(422, { detail: `alignment_report: unknown key '${unknown}'` });
      }
      if (key === "company_timezone" && value !== null && value !== undefined) {
        let ok = typeof value === "string" && value !== "";
        try {
          if (ok) new Intl.DateTimeFormat("en-US", { timeZone: value as string });
        } catch {
          ok = false;
        }
        if (!ok) return json(422, { detail: "company_timezone must be an IANA time zone name" });
      }
      if (key === "sign_in_without_invite" && !["request", "join", "refuse"].includes(String(value))) {
        return json(422, { detail: "sign_in_without_invite must be request, join or refuse" });
      }
      if (key === "company_email_domains" && Array.isArray(value)) {
        const domain = value.map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).find(publicMailDomain);
        if (domain) {
          return json(422, {
            detail: `company_email_domains: ${domain} is a public mail provider, where anyone can have an address; enter the company's own domain`,
          });
        }
      }
      if (key === "code_map_refresh" && value !== null && value !== undefined && !["hourly", "every_6_hours", "daily", "weekly", "on_demand"].includes(String(value))) {
        return json(422, { detail: "code_map_refresh must be one of hourly, every_6_hours, daily, weekly, on_demand" });
      }
      if (key === "planning_horizons" && value !== null && value !== undefined) {
        const error = horizonsError(value);
        if (error) return json(422, { detail: error });
      }
      if (value === null || value === undefined) delete db.settings[key];
      else db.settings[key] = value;
      return json(200, settingOut(db, key));
    }
  }

  if (p[1] === "connections") {
    if (!p[2] && m === "GET") return json(200, db.connections.map((c) => out(db, c)));
    if (p[2] === "providers" && m === "GET") return json(200, PROVIDERS);
    if (p[2] === "google" && p[3] === "picker-config" && m === "GET") return json(200, MOCK_PICKER_CONFIG);
    const provider = PROVIDERS.find((x) => x.key === p[2]);

    if (provider && p[3] === "token" && m === "POST") {
      const { token, label, endpoint_url } = await body<Schemas["TokenIn"]>();
      // As the API: owners only, Fireflies only, the endpoint rule, then the key.
      let endpoint: string | null = null;
      if (endpoint_url) {
        if (role !== "owner") return json(403, { detail: OWNER_ONLY });
        if (provider.key !== "fireflies") return json(422, { detail: "Only a Fireflies connection takes an endpoint" });
        const checked = checkEndpoint(endpoint_url);
        if ("error" in checked) return json(422, { detail: checked.error });
        endpoint = checked.url;
      }
      const who = identity(provider.key, token.trim());
      if (typeof who === "string") return json(400, { detail: who });
      const existing = db.connections.find((c) => c.provider === provider.key && c.account_id === who.account_id);
      if (provider.key === "fireflies" && existing && (existing.endpoint_url ?? null) !== endpoint && role !== "owner") {
        return json(403, { detail: "This Fireflies account is connected through an endpoint an owner set; only an Oracle owner can change it" });
      }
      const row = upsert(db, provider.key, "token", who, label);
      if (provider.key === "fireflies") row.endpoint_url = endpoint;
      return json(200, out(db, row));
    }
    if (provider && p[3] === "authorize" && m === "GET") {
      if (!provider.oauth_configured) {
        return json(409, { detail: `Sign-in with ${provider.name} is not configured; paste a token instead` });
      }
      const who = identity(provider.key, "oauth-token");
      if (typeof who !== "string") upsert(db, provider.key, "oauth", who);
      return json(200, { url: `/settings/connections?connected=${provider.key}` });
    }

    if (p[3] === "notion" && p[4] === "pages" && m === "GET") {
      // The Sources page's mock Notion connection, or one connected on Settings > Connections.
      const own = db.connections.find((c) => c.id === p[2]);
      if (p[2] !== MOCK_NOTION_CONNECTION_ID && !own) return json(404, { detail: "Connection not found" });
      if (own && own.provider !== "notion") return json(409, { detail: "This is not a Notion connection" });
      return notionPages(new URL(req.url, "http://mock"));
    }

    const row = db.connections.find((c) => c.id === p[2]);
    if (!row) return json(404, { detail: "Connection not found" });
    if (p[3] === "google" && p[4] === "shared-drives" && m === "GET") {
      if (row.provider !== "google") return json(404, { detail: "Not your Google connection" });
      if (reconnectReason(row.provider, row.scopes)) return json(409, { detail: "Reconnect Google to list shared drives" });
      return json(200, { drives: MOCK_SHARED_DRIVES });
    }
    if (p[3] === "endpoint" && m === "PUT") {
      if (role !== "owner") return json(403, { detail: "Requires the owner role" });
      const sent = (await body<Partial<Schemas["EndpointIn"]> | null>()) ?? {};
      const { endpoint_url, token } = sent;
      // FastAPI's own validation answer, as the API gives it (EndpointIn.token: required, 1+).
      if (token === undefined || token === null) return json(422, { detail: [{ type: "missing", loc: ["body", "token"], msg: "Field required", input: sent }] });
      if (token === "") return json(422, { detail: [{ type: "string_too_short", loc: ["body", "token"], msg: "String should have at least 1 character", input: token, ctx: { min_length: 1 } }] });
      if (row.provider !== "fireflies") return json(422, { detail: "Only a Fireflies connection takes an endpoint" });
      const checked = checkEndpoint(endpoint_url);
      if ("error" in checked) return json(422, { detail: checked.error });
      const who = identity(row.provider, token.trim());
      if (typeof who === "string") return json(400, { detail: who });
      if (who.account_id !== row.account_id) return json(400, { detail: ANOTHER_ACCOUNT });
      Object.assign(row, { endpoint_url: checked.url, status: "active", last_error: null, updated_at: now() });
      return json(200, out(db, row));
    }
    if (!p[3] && m === "DELETE") {
      db.connections = db.connections.filter((c) => c.id !== row.id);
      return json(204, undefined);
    }
    if (p[3] === "reconnect" && m === "POST") {
      const { token } = (await body<Schemas["ReconnectIn"] | null>()) ?? {};
      if (token) {
        const who = identity(row.provider, token.trim());
        if (typeof who === "string") return json(400, { detail: who });
        if (who.account_id !== row.account_id) return json(400, { detail: "That token belongs to another account" });
      }
      if (!token && reconnectReason(row.provider, row.scopes)) {
        // Signs in again for drive.readonly, as the real API's authorize_url would.
        const who = identity(row.provider, "oauth-token");
        if (typeof who !== "string") upsert(db, row.provider, "oauth", { ...who, account_id: row.account_id });
        return json(200, { connection: out(db, row), authorize_url: `/settings/connections?connected=${row.provider}` });
      }
      Object.assign(row, { status: "active", last_error: null, updated_at: now() });
      return json(200, { connection: out(db, row), authorize_url: null });
    }
  }
  return json(404, { detail: "Route not found" });
}
