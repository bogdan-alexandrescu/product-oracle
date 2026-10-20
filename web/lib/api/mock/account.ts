/**
 * Account management in the mock: every credential of the company by kind (Settings >
 * API tokens) and My account (password, personal tokens, MCP clients, sign out
 * everywhere). Checks and answers mirror oracle/members/tokens.py and oracle/account.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["MemberOut"]["role"];
type Member = Schemas["MemberOut"];
export type TokenRow = Schemas["ApiTokenOut"];

export interface AccountDb {
  tokens: TokenRow[];
  /** Passwords changed in the mock, by email (the rest use the mock password). */
  passwords: Record<string, string>;
  /** Wrong current passwords, by email: ISO times (the rate limit's window). */
  failures: Record<string, string[]>;
}

export type AccountContext = {
  db: AccountDb;
  members: Member[];
  me: Member;
  /** The mock password everyone starts with. */
  defaultPassword: string;
  uuid: () => string;
  now: () => string;
  /** Ends the mock's one session (sign out everywhere, a password change elsewhere). */
  endSession: () => void;
};

const MIN_LENGTH = 12;
const ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const FULL = ["oracle:read", "oracle:write"];

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
const ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ORDER.indexOf(role) >= ORDER.indexOf(min);

/**
 * One credential of each kind and state: the seeded agent-track token (personal, as
 * oracle.seed makes it), a read-only personal token, a removed member's revoked token, a
 * service token, a run's token, and two MCP clients (one revoked).
 */
export function seedAccount(members: Member[], uuid: () => string): AccountDb {
  const by = (email: string) => members.find((m) => m.email === email);
  const admin = by("admin@example.com")!;
  const approver = by("approver@example.com");
  const commenter = by("commenter@example.com");
  const former = by("former.pm@example.com");
  const personal = (m: Member | undefined, name: string, extra: Partial<TokenRow> = {}): TokenRow => ({
    id: uuid(),
    name,
    kind: "personal",
    role: m?.role ?? "viewer",
    user_id: m?.id ?? null,
    owner_email: m?.email ?? null,
    scopes: FULL,
    created_at: "2026-09-01T09:05:00Z",
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    run_id: null,
    client_id: null,
    ...extra,
  });
  const tokens: TokenRow[] = [
    personal(admin, "agent-track", { last_used_at: "2026-10-20T07:40:00Z" }),
    personal(approver, "laptop cli", {
      role: "viewer",
      scopes: ["oracle:read"],
      created_at: "2026-10-02T14:00:00Z",
      last_used_at: "2026-10-19T16:12:00Z",
    }),
    personal(former, "release script", {
      created_at: "2026-09-20T10:00:00Z",
      last_used_at: "2026-10-17T22:00:00Z",
      revoked_at: former?.disabled_at ?? "2026-10-18T09:00:00Z",
    }),
    {
      ...personal(undefined, "ci-export"),
      kind: "service",
      role: "viewer",
      scopes: [],
      created_at: "2026-09-10T08:00:00Z",
      last_used_at: "2026-10-20T06:00:00Z",
    },
    personal(admin, "Run · baseline to prd", {
      kind: "run",
      scopes: ["read:baseline", "read:documents", "read:sources", "write:drafts"],
      created_at: "2026-10-20T08:00:00Z",
      last_used_at: "2026-10-20T08:20:00Z",
      expires_at: "2026-10-21T08:00:00Z",
      run_id: uuid(),
    }),
    personal(admin, "Claude Desktop", {
      kind: "mcp_client",
      created_at: "2026-10-05T12:00:00Z",
      last_used_at: "2026-10-20T07:00:00Z",
      expires_at: "2026-11-19T07:00:00Z",
      client_id: "pocl_claude_desktop",
    }),
    personal(admin, "Old notebook agent", {
      kind: "mcp_client",
      scopes: ["oracle:read"],
      role: "viewer",
      created_at: "2026-09-12T12:00:00Z",
      last_used_at: "2026-09-30T07:00:00Z",
      revoked_at: "2026-10-01T09:00:00Z",
      expires_at: "2026-10-30T07:00:00Z",
      client_id: "pocl_old_notebook",
    }),
    personal(commenter, "Cursor", {
      kind: "mcp_client",
      scopes: ["oracle:read"],
      role: "viewer",
      created_at: "2026-10-11T12:00:00Z",
      last_used_at: "2026-10-19T12:00:00Z",
      expires_at: "2026-11-18T12:00:00Z",
      client_id: "pocl_cursor",
    }),
  ];
  return { tokens, passwords: {}, failures: {} };
}

const live = (t: TokenRow) => !t.revoked_at && (!t.expires_at || t.expires_at > new Date().toISOString());

/** Unrevoked personal tokens and live MCP grants, per member (MemberOut.open_tokens). */
export function openTokens(db: AccountDb, memberId: string): number {
  return db.tokens.filter((t) => t.user_id === memberId && (t.kind === "personal" || t.kind === "mcp_client") && live(t)).length;
}

/** A disable revokes every credential acting for the member (C2). */
export function revokeMemberTokens(db: AccountDb, memberId: string, at: string) {
  for (const t of db.tokens) if (t.user_id === memberId && !t.revoked_at) t.revoked_at = at;
}

export function passwordOk(db: AccountDb, email: string, password: string, fallback: string): boolean {
  return password === (db.passwords[email] ?? fallback);
}

function grantOut(t: TokenRow): Schemas["McpClientOut"] {
  return {
    id: t.id,
    client_id: t.client_id ?? "",
    client_name: t.name,
    scopes: t.scopes ?? [],
    authorized_at: t.created_at,
    last_used_at: t.last_used_at ?? t.created_at,
    expires_at: t.expires_at ?? t.created_at,
    revoked_at: t.revoked_at,
  };
}

/** /v1/api-tokens (owners) and /v1/me/... (everyone). Null when the path is not ours. */
export async function accountRoute(ctx: AccountContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const { db, me } = ctx;
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "api-tokens") {
    if (!atLeast(me.role, "owner")) return json(403, { detail: "Requires the owner role" });
    if (!p[2] && m === "GET") {
      const kind = q.get("kind");
      const user = q.get("user_id");
      if (kind && !["personal", "service", "run", "mcp_client"].includes(kind)) return json(422, { detail: "kind" });
      const rows = db.tokens
        .filter((t) => (!kind || t.kind === kind) && (!user || t.user_id === user))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return json(200, rows);
    }
    const token = db.tokens.find((t) => t.id === p[2]);
    if (!token) return json(404, { detail: `Token ${p[2]} not found` });
    if (m === "DELETE" && !p[3]) {
      token.revoked_at ??= ctx.now();
      return json(204);
    }
    return null;
  }
  if (p[1] !== "me" || !p[2] || p[2] === "preferences") return null;

  const mine = (kind: TokenRow["kind"]) => db.tokens.filter((t) => t.user_id === me.id && t.kind === kind);
  if (p[2] === "account" && m === "GET") {
    const out: Schemas["MyAccountOut"] = {
      user_id: me.id,
      email: me.email,
      role: me.role,
      created_at: me.created_at,
      last_sign_in_at: me.last_sign_in_at ?? null,
      sign_in_methods: ["password"],
      password_min_length: MIN_LENGTH,
      signed_in_via: "browser",
    };
    return json(200, out);
  }
  if (p[2] === "password" && m === "POST") {
    const input = await body<Schemas["PasswordChange"]>();
    if ((input.new_password ?? "").length < MIN_LENGTH) {
      return json(422, { detail: `The new password needs at least ${MIN_LENGTH} characters` });
    }
    const cutoff = Date.now() - WINDOW_MS;
    const failures = (db.failures[me.email] ?? []).filter((at) => Date.parse(at) > cutoff);
    db.failures[me.email] = failures;
    if (failures.length >= ATTEMPTS) {
      const wait = Math.ceil((Date.parse(failures[failures.length - ATTEMPTS]) + WINDOW_MS - Date.now()) / 1000);
      return new Response(JSON.stringify({ detail: `Too many attempts; try again in ${wait} s` }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(wait) },
      });
    }
    if (!passwordOk(db, me.email, input.current_password, ctx.defaultPassword)) {
      failures.push(ctx.now());
      return json(400, { detail: "Your current password is not correct" });
    }
    db.passwords[me.email] = input.new_password;
    db.failures[me.email] = [];
    return json(204);
  }
  if (p[2] === "sign-out-everywhere" && m === "POST") {
    const at = ctx.now();
    const grants = mine("mcp_client").filter(live);
    for (const g of grants) g.revoked_at = at;
    ctx.endSession();
    return json(200, { sessions_valid_after: at, mcp_clients_revoked: grants.length });
  }
  if (p[2] === "tokens") {
    if (!p[3] && m === "GET") return json(200, mine("personal"));
    if (!p[3] && m === "POST") {
      const input = await body<Schemas["PersonalTokenCreate"]>();
      const name = (input.name ?? "").trim();
      const scopes = [...new Set(input.scopes ?? [])].sort();
      if (!name || scopes.length === 0 || scopes.some((s) => !FULL.includes(s))) {
        return json(422, { detail: "A name and at least one scope are required" });
      }
      const token: TokenRow = {
        id: ctx.uuid(),
        name,
        kind: "personal",
        role: scopes.includes("oracle:write") ? me.role : "viewer",
        user_id: me.id,
        owner_email: me.email,
        scopes,
        created_at: ctx.now(),
        last_used_at: null,
        revoked_at: null,
        expires_at: null,
        run_id: null,
        client_id: null,
      };
      db.tokens.push(token);
      // Built from pieces so no credential-shaped literal sits in the source.
      const raw = [["po", "mock"].join("_"), ctx.uuid().replaceAll("-", "")].join("");
      return json(201, { token, secret: raw });
    }
    const token = mine("personal").find((t) => t.id === p[3]);
    if (!token) return json(404, { detail: `API token ${p[3]} not found` });
    if (m === "DELETE") {
      token.revoked_at ??= ctx.now();
      return json(204);
    }
  }
  if (p[2] === "oauth-clients") {
    if (!p[3] && m === "GET") return json(200, mine("mcp_client").map(grantOut));
    const grant = mine("mcp_client").find((t) => t.id === p[3]);
    if (!grant) return json(404, { detail: `MCP client grant ${p[3]} not found` });
    if (m === "DELETE") {
      grant.revoked_at ??= ctx.now();
      return json(204);
    }
  }
  return null;
}
