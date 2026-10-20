/**
 * Mock of the connections and company settings endpoints (mock mode only). Kept apart
 * from server.ts; state lives in its own localStorage key.
 *
 * Token rules: anything starting with "bad" is rejected. OAuth is "configured" for GitHub
 * and Google: authorize connects at once and sends the browser straight back to the page.
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
    oauth_scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"],
    token_help: "Google access tokens expire within an hour; connect with Google sign-in.",
  },
];

const SETTING_DEFAULTS: Record<string, unknown> = {
  iap_default_role: "commenter",
  confidence_weights: {},
  blocker_risk_acceptance_role: "owner",
  blocker_risk_review_max_days: 90,
};

function load(): ConnDb {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ConnDb;
  } catch {
    // fall through to a fresh state
  }
  return { connections: [], settings: {} };
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
  return { account_id: `${provider}-1`, label: labels[provider] ?? provider, scopes: provider === "github" ? ["repo"] : [] };
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
  return c;
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
      const { value } = await body<Schemas["SettingIn"]>();
      if (value === null || value === undefined) delete db.settings[key];
      else db.settings[key] = value;
      return json(200, settingOut(db, key));
    }
  }

  if (p[1] === "connections") {
    if (!p[2] && m === "GET") return json(200, db.connections.map((c) => out(db, c)));
    if (p[2] === "providers" && m === "GET") return json(200, PROVIDERS);
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
      Object.assign(row, { status: "active", last_error: null, updated_at: now() });
      return json(200, { connection: out(db, row), authorize_url: null });
    }
  }
  return json(404, { detail: "Route not found" });
}
