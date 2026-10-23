/**
 * Mock of /v1/claude-accounts (mock mode only), with its own localStorage key.
 *
 * Seeded with one account of each kind the screen must draw differently: a live reading
 * with a job on it (personal), an old reading (work, marked ~), one never measured (spare,
 * em dashes) and one whose sign-in expired (old-laptop). Reads are open to every role;
 * changes need the owner role, as in the API. Sign-in: the code "bad-code" is refused,
 * anything else is accepted. A pasted login must carry a refresh token.
 *
 * Whether an account (and the pool) takes calls is the API's rule (accounts.py choose and
 * eligibility): AVAILABLE, readable, and its binding window at least 15% clear, an old
 * reading counted at half; with none, a fallback credential covers no account at all or every one
 * spent (fallback.py covers). The "pool-spent" scenario has one account over its weekly limit.
 */
import type { Schemas } from "@/lib/api/client";
import { inWords } from "@/lib/format";

import { mockSettingValue } from "./connections";

type Account = Schemas["AccountOut"];
type Stored = Omit<Account, "stale" | "takes_calls" | "spent_by" | "spent_until">;
type Hold = Schemas["HolderOut"] & { account_id: string };
type Span = Schemas["SpanOut"] & { account_id: string };

interface PoolDb {
  accounts: Stored[];
  holds: Hold[];
  spans: Span[];
  pending: { state: string; label: string }[];
  fallback: Schemas["FallbackOut"] | null;
  sweep: Schemas["RefreshSweepOut"];
}

const STORAGE_KEY = "po-mock-claude-accounts-v1";
// Built from parts so the source holds no credential-shaped literal.
export const SETUP_TOKEN_PREFIX = ["sk", "ant", "oat"].join("-");
export const API_KEY_PREFIX = ["sk", "ant", "api"].join("-");
// What the screen calls each fallback kind, built from parts.
const KEY_KIND = ["api", "key"].join("_");
const KIND_NAME: Record<string, string> = {
  plan: ["Claude", "setup-token"].join(" "),
  [KEY_KIND]: ["Anthropic", "API", "key"].join(" "),
};
const STALE_AFTER_MS = 30 * 60_000;
const ASSIGN_FLOOR = 0.15;

/** The scenario whose only account is over its weekly limit, so no call can run (#403). */
export const POOL_SPENT_SCENARIO = "pool-spent";

const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function seed(scenario: string | null): PoolDb {
  const base = {
    provider: "anthropic",
    reason: "",
    unreadable_now: false,
    last_refresh_reason: "still_valid",
  };
  const personal = "a1111111-0000-4000-8000-000000000001";
  if (scenario === POOL_SPENT_SCENARIO)
    return {
      accounts: [
        {
          ...base,
          account_id: personal,
          label: "weekly",
          state: "AVAILABLE",
          assigned: 0,
          windows: {
            five_hour: { utilization: 0.09, resets_at: at(3 * HOUR), reset: false },
            seven_day: { utilization: 0.95, resets_at: at((2 * 24 + 13) * HOUR), reset: false },
          },
          observed_at: at(-2 * MIN),
          last_refresh_at: at(-4 * MIN),
          token_expires_at: at(6 * HOUR),
          last_assigned_at: at(-26 * HOUR),
        },
      ],
      holds: [],
      spans: [],
      pending: [],
      fallback: null,
      sweep: { last_completed_at: at(-4 * MIN), last_outcome: "ok", readable: true },
    };
  return {
    accounts: [
      {
        ...base,
        account_id: personal,
        label: "personal",
        state: "AVAILABLE",
        assigned: 1,
        windows: {
          five_hour: { utilization: 0.34, resets_at: at(80 * MIN), reset: false },
          seven_day: { utilization: 0.12, resets_at: at(3 * 24 * HOUR), reset: false },
        },
        observed_at: at(-2 * MIN),
        last_refresh_at: at(-4 * MIN),
        token_expires_at: at(6 * HOUR),
        last_assigned_at: at(-6 * MIN),
      },
      {
        ...base,
        account_id: "a1111111-0000-4000-8000-000000000002",
        label: "work",
        state: "AVAILABLE",
        assigned: 0,
        windows: {
          five_hour: { utilization: 0.61, resets_at: at(2 * HOUR), reset: false },
          seven_day: { utilization: 0.88, resets_at: at(30 * HOUR), reset: false },
        },
        observed_at: at(-50 * MIN),
        last_refresh_at: at(-4 * MIN),
        token_expires_at: at(5 * HOUR),
        last_assigned_at: at(-(2 * 24 + 5) * HOUR),
      },
      {
        ...base,
        account_id: "a1111111-0000-4000-8000-000000000003",
        label: "spare",
        state: "AVAILABLE",
        assigned: 0,
        windows: {},
        observed_at: null,
        last_refresh_at: null,
        token_expires_at: null,
        last_refresh_reason: null,
        last_assigned_at: null,
      },
      {
        ...base,
        account_id: "a1111111-0000-4000-8000-000000000004",
        label: "old-laptop",
        state: "REAUTH_REQUIRED",
        reason: "refresh failed: reauth_required",
        assigned: 0,
        windows: {},
        observed_at: null,
        last_refresh_at: at(-4 * MIN),
        token_expires_at: at(-3 * HOUR),
        last_refresh_reason: "reauth_required",
        last_assigned_at: at(-9 * 24 * HOUR),
      },
    ],
    holds: [
      {
        account_id: personal,
        task_id: "reporting",
        attempt_id: "att-1",
        since: at(-6 * MIN),
        expires_at: at(3 * HOUR),
        swapped_from: null,
        swapped_from_reason: null,
        move: null,
      },
    ],
    spans: [
      span(personal, "reporting", -6 * MIN, null, null),
      span(personal, "review_comments", -3 * HOUR, -170 * MIN, "released"),
      span(personal, "refinement", -26 * HOUR, -25 * HOUR, "released"),
    ],
    pending: [],
    fallback: null,
    sweep: { last_completed_at: at(-4 * MIN), last_outcome: "ok", readable: true },
  };
}

function span(account_id: string, task: string, from: number, to: number | null, end: string | null): Span {
  return {
    account_id,
    task_id: task,
    attempt_id: null,
    since: at(from),
    until: to === null ? null : at(to),
    end,
    hold_expires_at: at(from + 3 * HOUR),
    swapped_from: null,
    swapped_from_reason: null,
    swapped_to: null,
    swapped_to_reason: null,
  };
}

function load(scenario: string | null): PoolDb {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PoolDb;
  } catch {
    // fall through to a fresh pool
  }
  return seed(scenario);
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fraction believed left (Account.headroom): the binding window; a reset one is full; an old reading halved. */
function headroom(a: Stored, now: number): number {
  const ws = Object.values(a.windows);
  if (ws.length === 0 || a.observed_at === null) return 1;
  const left = Math.min(...ws.map((w) => (Date.parse(w.resets_at) <= now ? 1 : Math.max(0, 1 - w.utilization))));
  return now - Date.parse(a.observed_at) > STALE_AFTER_MS ? left * 0.5 : left;
}

/** The window keeping it below the floor and when it resets (Account.spent_by), or null. */
function spentBy(a: Stored, now: number): [string, string] | null {
  if (headroom(a, now) >= ASSIGN_FLOOR) return null;
  const blocking = Object.entries(a.windows)
    .filter(([, w]) => Date.parse(w.resets_at) > now && 1 - w.utilization < ASSIGN_FLOOR)
    .sort(([, x], [, y]) => Date.parse(x.resets_at) - Date.parse(y.resets_at));
  return blocking[0] ? [blocking[0][0], blocking[0][1].resets_at] : null;
}

const takesCalls = (a: Stored, now: number) => a.state === "AVAILABLE" && !a.unreadable_now && headroom(a, now) >= ASSIGN_FLOOR;

/** `stale` is the server's verdict: no reading, or one older than thirty minutes. */
function out(a: Stored): Account {
  const now = Date.now();
  const observed = a.observed_at ? Date.parse(a.observed_at) : null;
  const windows = Object.fromEntries(Object.entries(a.windows).map(([k, w]) => [k, { ...w, reset: Date.parse(w.resets_at) <= now }]));
  const takes = takesCalls(a, now);
  const spent = takes || a.state !== "AVAILABLE" || a.unreadable_now ? null : spentBy(a, now);
  return {
    ...a,
    windows,
    stale: observed === null || now - observed > STALE_AFTER_MS,
    takes_calls: takes,
    spent_by: spent?.[0] ?? null,
    spent_until: spent?.[1] ?? null,
  };
}

/** Why no account takes a call (accounts.py eligibility), and when the earliest spent window clears. */
function whyNone(db: PoolDb, now: number): { reason: string; until: string | null } {
  if (db.accounts.length === 0) return { reason: "no_accounts_registered", until: null };
  const mine = db.accounts.filter((a) => !a.unreadable_now);
  if (mine.length === 0) return { reason: "no_account_available", until: null };
  const assignable = mine.filter((a) => a.state === "AVAILABLE");
  if (assignable.length === 0) return { reason: "pool_paused", until: null };
  const resets = assignable.map((a) => spentBy(a, now)?.[1]).filter((r): r is string => !!r).sort((x, y) => Date.parse(x) - Date.parse(y));
  if (resets[0]) return { reason: "no_account_available", until: resets[0] };
  const old = assignable.some((a) => a.observed_at !== null && now - Date.parse(a.observed_at) > STALE_AFTER_MS);
  return { reason: old ? "no_recent_reading" : "no_account_available", until: null };
}

/** The reasons a call runs on the fallback credential when one is set (fallback.covers). */
const FALLBACK_COVERS = ["no_accounts_registered", "no_account_available"];

/** The pool's answer (router.pool_out: choose, then eligibility, then fallback.covers). */
function poolOf(db: PoolDb): Schemas["PoolOut"] {
  const now = Date.now();
  if (db.accounts.some((a) => takesCalls(a, now))) return { takes_calls: true, on_fallback: false, reason: null, until: null };
  const { reason, until } = whyNone(db, now);
  const onFallback = !!db.fallback && FALLBACK_COVERS.includes(reason);
  return { takes_calls: onFallback, on_fallback: onFallback, reason, until };
}

/** The company's time zone: the alignment report's, as the API reads it (company_time.py). */
const timeZone = () => ((mockSettingValue("alignment_report") as { timezone?: string } | undefined)?.timezone ?? "America/Los_Angeles");

/**
 * The gateway's refusal when the pool is spent and says when it clears, worded in the
 * company's time zone (pool.NoAccount.message); null when the pool takes calls or waits
 * on no clock.
 */
export function poolRefusal(scenario: string | null): string | null {
  const pool = poolOf(load(scenario));
  if (pool.takes_calls || pool.reason !== "no_account_available" || !pool.until) return null;
  return `No Claude account can take this call: every Claude account is spent; the earliest window clears ${inWords(pool.until, timeZone())}`;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

function newState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function register(db: PoolDb, label: string): Account {
  let row = db.accounts.find((a) => a.label === label);
  if (!row) {
    row = {
      account_id: crypto.randomUUID(),
      label,
      provider: "anthropic",
      state: "AVAILABLE",
      reason: "",
      assigned: 0,
      windows: {},
      observed_at: null,
      unreadable_now: false,
      last_refresh_at: null,
      token_expires_at: at(8 * HOUR),
      last_refresh_reason: null,
      last_assigned_at: null,
    };
    db.accounts.push(row);
  } else if (row.state === "REAUTH_REQUIRED") {
    Object.assign(row, { state: "AVAILABLE", reason: "", token_expires_at: at(8 * HOUR) });
  }
  return out(row);
}

/** Handles /v1/claude-accounts…; null for any other route. */
export async function claudeAccountsRoute(req: Request, p: string[], q: URLSearchParams, role: string, scenario: string | null): Promise<Response | null> {
  if (p[1] !== "claude-accounts") return null;
  const db = load(scenario);
  const res = await handle(db, req, p, q, role);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  return res;
}

async function handle(db: PoolDb, req: Request, p: string[], q: URLSearchParams, role: string): Promise<Response> {
  const m = req.method;
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;
  if (m !== "GET" && role !== "owner") return json(403, { detail: "Requires the owner role" });

  if (!p[2] && m === "GET") {
    const page: Schemas["AccountsPage"] = {
      accounts: db.accounts.map(out),
      unreadable_documents: [],
      unreadable_document_count: 0,
      refresh_sweep: db.sweep,
      fallback: db.fallback,
      pool: poolOf(db),
      time_zone: timeZone(),
    };
    return json(200, page);
  }
  if (!p[2] && m === "POST") {
    const { label, credential } = await body<Schemas["RegisterIn"]>();
    if (!LABEL.test(label)) return json(422, { detail: `account label '${label}' must be lowercase letters, digits and dashes` });
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(credential) as Record<string, unknown>;
    } catch {
      return json(422, { detail: "the credential is not JSON; a subscription credential needs accessToken, refreshToken and expiresAt" });
    }
    const inner = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    if (!inner.refreshToken && !inner.refresh_token) return json(422, { detail: "the credential has no refresh token" });
    return json(201, { account: register(db, label), expires_at: at(8 * HOUR), note: "stored encrypted and write-only" });
  }
  if (p[2] === "authorize" && m === "POST") {
    const { label } = await body<Schemas["AuthorizeIn"]>();
    if (!LABEL.test(label)) return json(422, { detail: `account label '${label}' must be lowercase letters, digits and dashes` });
    const state = newState();
    db.pending.push({ state, label });
    return json(200, {
      authorize_url: `https://claude.com/cai/oauth/authorize?code=true&response_type=code&state=${state}`,
      state,
      expires_in_seconds: 900,
    });
  }
  if (p[2] === "exchange" && m === "POST") {
    const { state, code } = await body<Schemas["ExchangeIn"]>();
    const [bare, pastedState] = code.trim().split("#");
    if (pastedState && pastedState !== state) {
      return json(422, { detail: "The pasted code belongs to a different sign-in than the one this page started. Press Add account and sign in again." });
    }
    const pending = db.pending.find((x) => x.state === state);
    if (!pending) return json(422, { detail: "This sign-in has expired or was already completed. Codes are single-use; press Add account to start again." });
    if (bare === "bad-code") {
      return json(422, { detail: "the sign-in code was not accepted. Codes are single-use and expire quickly. Try Add account once more." });
    }
    db.pending = db.pending.filter((x) => x.state !== state);
    return json(201, { account: register(db, pending.label), expires_at: at(8 * HOUR), note: "stored encrypted and write-only" });
  }
  if (p[2] === "fallback") {
    if (m === "PUT") {
      const { token } = await body<Schemas["FallbackIn"]>();
      const t = token.trim();
      const kind = t.startsWith(SETUP_TOKEN_PREFIX) ? "plan" : t.startsWith(API_KEY_PREFIX) ? "api_key" : null;
      if (!kind) return json(422, { detail: "Not a Claude credential: paste the value printed by `claude setup-token` or an Anthropic API key" });
      db.fallback = {
        kind,
        label: `${KIND_NAME[kind]} …${t.slice(-4)}`,
        updated_at: new Date().toISOString(),
      };
      return json(200, db.fallback);
    }
    if (m === "DELETE") {
      db.fallback = null;
      return json(204, undefined);
    }
  }
  if (p[2] === "sweep" && m === "POST") {
    db.sweep = { last_completed_at: new Date().toISOString(), last_outcome: "ok", readable: true };
    return json(200, { result: {} });
  }

  const row = db.accounts.find((a) => a.account_id === p[2]);
  if (!row) return json(404, { detail: `No Claude account '${p[2]}'` });
  if (p[3] === "holders" && m === "GET") {
    const live = db.holds.filter((h) => h.account_id === row.account_id);
    return json(200, { account_id: row.account_id, total: live.length, holders: live });
  }
  if (p[3] === "history" && m === "GET") {
    const spans = db.spans
      .filter((s) => s.account_id === row.account_id)
      .sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
    const limit = Number(q.get("limit") ?? 100);
    return json(200, {
      account_id: row.account_id,
      from: at(-7 * 24 * HOUR),
      to: new Date().toISOString(),
      spans: spans.slice(0, limit),
      next_cursor: null,
    });
  }
  if (p[3] === "state" && m === "PUT") {
    const { state, reason } = await body<Schemas["StateIn"]>();
    const to = state.trim().toUpperCase();
    if (!["AVAILABLE", "PAUSED", "DRAINING", "REAUTH_REQUIRED"].includes(to)) {
      return json(422, { detail: `unknown account state '${state}'; known: AVAILABLE, PAUSED, DRAINING, REAUTH_REQUIRED` });
    }
    Object.assign(row, { state: to, reason: reason ?? "" });
    const moving = to === "DRAINING" ? db.holds.filter((h) => h.account_id === row.account_id).length : 0;
    for (const h of db.holds) if (h.account_id === row.account_id) h.move = to === "DRAINING" ? "drain" : null;
    return json(200, { account: out(row), moving });
  }
  if (p[3] === "refresh" && m === "POST") {
    const dead = row.state === "REAUTH_REQUIRED";
    const reason = dead ? "reauth_required" : "refreshed";
    Object.assign(row, {
      last_refresh_at: new Date().toISOString(),
      last_refresh_reason: reason,
      ...(dead ? {} : { token_expires_at: at(8 * HOUR) }),
    });
    return json(200, {
      refresh: { account_id: row.account_id, refreshed: !dead, reason, expires_at: dead ? null : row.token_expires_at },
      account: out(row),
    });
  }
  if (!p[3] && m === "DELETE") {
    const closed = db.holds.filter((h) => h.account_id === row.account_id).length;
    db.accounts = db.accounts.filter((a) => a.account_id !== row.account_id);
    db.holds = db.holds.filter((h) => h.account_id !== row.account_id);
    return json(200, { removed: row.account_id, label: row.label, closed_holds: closed, credential: "deleted" });
  }
  return json(404, { detail: "Route" });
}
