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
  // F6: the weekly alignment report, Monday 08:00 Pacific; the channel once Slack is connected.
  alignment_report: { enabled: true, weekday: "mon", time: "08:00", timezone: "America/Los_Angeles", slack_channel: null },
};

/** A company setting's value as stored, else its default (./reports.ts reads the report's channel). */
export function mockSettingValue(key: string): unknown {
  const db = load();
  return key in db.settings ? db.settings[key] : SETTING_DEFAULTS[key];
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
      id: crypto.randomUUID(),
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
  return { ...c, reconnect_reason: reconnectReason(c.provider, c.scopes) };
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
export function setupFacts(): { connections: number; domains: string[]; horizons: boolean } {
  const db = load();
  const domains = ("company_email_domains" in db.settings ? db.settings.company_email_domains : SETTING_DEFAULTS.company_email_domains) as string[];
  return {
    connections: db.connections.filter((c) => c.status === "active").length,
    domains,
    horizons: "planning_horizons" in db.settings,
  };
}

/** Handles /v1/connections… and /v1/settings…; null for other routes. */
export async function connectionsRoute(req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "connections" && p[1] !== "settings") return null;
  const db = load();
  const res = await handle(db, req, p);
  save(db);
  return res;
}

async function handle(db: ConnDb, req: Request, p: string[]): Promise<Response> {
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
      }
      if (key === "company_email_domains" && Array.isArray(value)) {
        const domain = value.map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).find(publicMailDomain);
        if (domain) {
          return json(422, {
            detail: `company_email_domains: ${domain} is a public mail provider, where anyone can have an address; enter the company's own domain`,
          });
        }
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
      const { token, label } = await body<Schemas["TokenIn"]>();
      const who = identity(provider.key, token.trim());
      if (typeof who === "string") return json(400, { detail: who });
      return json(200, out(db, upsert(db, provider.key, "token", who, label)));
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
