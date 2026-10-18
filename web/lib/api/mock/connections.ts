/**
 * Mock of the connections, Claude plan and company settings endpoints (mock mode only).
 * Kept apart from server.ts; state lives in its own localStorage key.
 *
 * Token rules: anything starting with "bad" is rejected; Claude accepts a plan token
 * or an API key, told apart by their prefixes (PLAN_PREFIX, API_PREFIX). OAuth is "configured" for GitHub and Google:
 * authorize connects at once and sends the browser straight back to the page.
 */
import type { Schemas } from "@/lib/api/client";

type ConnectionRow = Schemas["ConnectionOut"];

interface ConnDb {
  connections: ConnectionRow[];
  settings: Record<string, unknown>;
}

const STORAGE_KEY = "po-mock-connections-v1";
// Built from parts so the source holds no credential-shaped literal.
export const PLAN_PREFIX = ["sk", "ant", "oat"].join("-");
export const API_PREFIX = ["sk", "ant", "api"].join("-");

const PROVIDERS: Schemas["ProviderOut"][] = [
  {
    key: "claude",
    name: "Claude plan",
    source_kinds: [],
    oauth_configured: false,
    oauth_scopes: [],
    token_help: "Run `claude setup-token` on your machine and paste the token it prints, or paste an Anthropic API key.",
  },
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
  default_claude_connection_id: null,
  confidence_weights: {},
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
  const tail = token.slice(-4);
  if (provider === "claude") {
    if (token.startsWith(PLAN_PREFIX)) return { account_id: "plan", label: `Claude plan (setup-token …${tail})`, scopes: [] };
    if (token.startsWith(API_PREFIX)) return { account_id: "api_key", label: `Anthropic API key …${tail}`, scopes: [] };
    return "Not a Claude credential: paste the value printed by `claude setup-token` or an Anthropic API key";
  }
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
      is_company_default: false,
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

function out(db: ConnDb, c: ConnectionRow): ConnectionRow {
  return { ...c, is_company_default: db.settings.default_claude_connection_id === c.id };
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

/** Handles /v1/connections…, /v1/claude-plan and /v1/settings…; null for other routes. */
export async function connectionsRoute(req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "connections" && p[1] !== "claude-plan" && p[1] !== "settings") return null;
  const db = load();
  const res = await handle(db, req, p);
  save(db);
  return res;
}

async function handle(db: ConnDb, req: Request, p: string[]): Promise<Response> {
  const m = req.method;
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "claude-plan") {
    const own = db.connections
      .filter((c) => c.provider === "claude" && c.status === "active")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (own) {
      return json(200, {
        source: "own",
        connection_id: own.id,
        account_label: own.account_label,
        via: own.account_id === "api_key" ? "api_key" : "plan",
        reason: null,
      });
    }
    return json(200, {
      source: "none",
      reason: "No Claude plan connected: connect yours in Settings > Connections (`claude setup-token`), or ask an owner to set a company default plan",
    });
  }

  if (p[1] === "settings") {
    if (!p[2] && m === "GET") return json(200, Object.keys(SETTING_DEFAULTS).map((k) => settingOut(db, k)));
    const key = p[2];
    if (!(key in SETTING_DEFAULTS)) return json(404, { detail: `Unknown setting '${key}'` });
    if (m === "GET") return json(200, settingOut(db, key));
    if (m === "PUT") {
      const { value } = await body<Schemas["SettingIn"]>();
      if (value === null || value === undefined) delete db.settings[key];
      else if (key === "default_claude_connection_id") {
        const c = db.connections.find((x) => x.id === value);
        if (!c || c.provider !== "claude") return json(422, { detail: "default_claude_connection_id must be a Claude connection" });
        if (c.status !== "active") return json(422, { detail: `That Claude connection is ${c.status}; reconnect it first` });
        db.settings[key] = value;
      } else db.settings[key] = value;
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

    const row = db.connections.find((c) => c.id === p[2]);
    if (!row) return json(404, { detail: "Connection not found" });
    if (!p[3] && m === "DELETE") {
      db.connections = db.connections.filter((c) => c.id !== row.id);
      if (db.settings.default_claude_connection_id === row.id) delete db.settings.default_claude_connection_id;
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
