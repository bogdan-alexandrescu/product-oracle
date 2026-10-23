/**
 * Mock of the requests routes (api/oracle/requests/router.py, C1) for
 * NEXT_PUBLIC_API_MOCKS=1: the request queue with its tab counts and channel facet, a
 * request with what was merged into it, edits, qualify (needs a confirmed goal), merge
 * (to the root, no cycles), disqualify (Other needs a note), reopen, accepting or declining
 * Oracle's suggestion (#348), and themes. It keeps the API's shapes and role rules.
 *
 * It also stands in for Oracle's triage (GET and POST /v1/requests/triage: Classify now
 * starts a run that finishes on its own a few seconds later, suggesting a goal and theme for
 * every New request with none; PUT /v1/requests/triage/daily: the "Daily triage at 07:00 PT"
 * switch, off by default, approver+, and who the daily run acts as while it is on) and for the requests Oracle found in the signed-in person's
 * own sources (GET /v1/request-candidates, file, dismiss). Each found item is its owner's
 * alone; filing one shares the item's title, link and a 400-character excerpt (C1 "Found
 * items"). The mock has no source items: a found item carries that copy itself.
 *
 * Seed: 12 requests over 4 channels, 3 themes, 2 merged, 1 disqualified, 1 with a
 * suggestion, 2 found items for the seed owner. Synthetic placeholders only. The
 * "triage-skipped" scenario (po-mock-scenario) adds the reason Oracle's daily run did not
 * start (no active member to run it as), shown until a run, with the daily triage on.
 */
import type { Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";
import { mockUuid } from "./ids";

type Role = "viewer" | "commenter" | "approver" | "owner";
type RequestOut = Schemas["RequestOut"];
type ThemeOut = Schemas["RequestThemeOut"];
type Channel = RequestOut["channel"];
type State = RequestOut["state"];
type Part = Schemas["AcceptSuggestionIn"]["parts"][number];

export type CandidateOut = Schemas["CandidateOut"];

/** Oracle's latest triage run, as the mock keeps it. */
interface TriageRun {
  id: string;
  created_by: string;
  started_at: string;
  finished_at: string | null;
}

/** A request as stored: the API's row, before themes, PRDs and mentions are joined. */
interface Row extends Omit<RequestOut, "theme" | "document" | "mentions" | "source"> {
  theme_id: string | null;
  document_id: string | null;
  source: RequestOut["source"];
}

type Theme = Omit<ThemeOut, "request_count" | "archived">;

export interface RequestsDb {
  requests: Row[];
  themes: Theme[];
  candidates: CandidateOut[];
  triage?: TriageRun | null;
  /** "Daily triage at 07:00 PT": who last turned it on or off, and when; absent is off. */
  daily?: { on: boolean; by: string; at: string } | null;
}

interface Person {
  id: string;
  email: string;
  role: Role;
  disabled_at?: string | null;
  created_at: string;
}

interface GoalRef {
  id: string;
  key: string;
  title: string;
  status: string;
}

interface DocumentRef {
  id: string;
  slug: string;
  title: string;
  latest_version: number | null;
  sections: number;
  reviewed_sections: number;
}

export interface RequestsContext {
  userId: string;
  role: Role;
  /** Baseline goals; only confirmed ones link to requests and themes. */
  goals: () => GoalRef[];
  /** Baseline features (not rejected). */
  features: () => { id: string; key: string; title: string }[];
  /** PRDs a request may link to, with their review progress. */
  documents: () => DocumentRef[];
  /** The company's members: whom the daily triage runs as (none when not given). */
  people?: () => Person[];
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const STATES: State[] = ["new", "qualified", "merged", "disqualified"];
const CHANNELS: Channel[] = ["support", "sales", "team", "interview", "slack", "meeting", "doc", "other", "in_app"];
const REASONS = ["no_goal", "out_of_scope", "duplicate", "not_a_request", "wont_do", "other"];
const OWNER_NAMES_REQUESTER = "Only an owner files a request in someone else's name";
const NEEDS_GOAL = "Link a confirmed goal first, or disqualify it as 'No goal'";
/** How long the mock's triage run takes. */
const TRIAGE_MS = 3_000;
const EXCERPT_MAX = 400;
const SKIPPED_SCENARIO = "triage-skipped";
const SKIPPED =
  "Oracle's daily triage did not run on 2026-10-22: it runs as the approver who turned it on or else an owner, and none of them is an active member";

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });
const forbidden = (min: Role) => fail(403, `Requires the ${min} role`);
const stale = () => fail(409, "Someone else changed this since you loaded it; reload and try again");

function excerpt(text: string | null): string | null {
  const flat = (text ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!flat) return null;
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

/** The seeded company's requests; none for a company with no confirmed goal yet. */
export function seedRequests(input: { ownerId: string; goals: { id: string }[]; features: { id: string }[] }): RequestsDb {
  const db: RequestsDb = { requests: [], themes: [], candidates: [] };
  if (input.goals.length === 0) return db;
  const g0 = input.goals[0].id;
  const g1 = (input.goals[1] ?? input.goals[0]).id;
  const feature = input.features[0]?.id ?? null;
  const theme = (title: string, goal_ids: string[], days: number): Theme => ({
    id: mockUuid(), title, description: null, goal_ids, origin: "person", archived_at: null,
    created_by: input.ownerId, created_at: daysAgo(days), updated_at: daysAgo(days), lock_version: 1,
  });
  const checkout = theme("Faster check-out", [g0], 30);
  const sharing = theme("Team sharing", [g1], 28);
  const reporting = theme("Reporting", [], 25);
  db.themes.push(checkout, sharing, reporting);

  const add = (days: number, title: string, channel: Channel, extra: Partial<Row> = {}): Row => {
    const row: Row = {
      id: mockUuid(), title, body: null, channel, origin: channel === "interview" ? "interview" : "person",
      requester_name: null, requester_kind: "unknown", verified: channel !== "interview", state: "new",
      merged_into_id: null, disqualify_reason: null, decision_note: null, theme_id: null, goal_ids: [],
      feature_id: null, document_id: null, intake_id: null, interview_id: null, source: null, suggestion: null,
      filed_by: input.ownerId, decided_by: null, decided_at: null, created_at: daysAgo(days),
      updated_at: daysAgo(days), lock_version: 1, ...extra,
    };
    db.requests.push(row);
    return row;
  };
  const decided = { decided_by: input.ownerId, decided_at: daysAgo(2) };
  const address = add(20, "Keep the delivery address between orders", "support", {
    body: "Returning buyers retype their address at every order.", requester_name: "A buyer at a retail customer",
    requester_kind: "customer", state: "qualified", theme_id: checkout.id, goal_ids: [g0], feature_id: feature, ...decided,
  });
  add(15, "Remember my address", "sales", { requester_kind: "customer", state: "merged", merged_into_id: address.id, ...decided });
  add(4, "Address autofill at check-out", "slack", { requester_kind: "team", state: "merged", merged_into_id: address.id, ...decided });
  add(18, "Invite a whole team at once", "support", { state: "qualified", theme_id: sharing.id, goal_ids: [g1], ...decided });
  add(12, "Share a board read-only", "sales", { requester_kind: "customer", state: "qualified", theme_id: sharing.id, goal_ids: [g1], ...decided });
  add(10, "Weekly summary email", "support", { state: "qualified", theme_id: reporting.id, goal_ids: [g0], ...decided });
  add(6, "Pay by bank transfer", "interview", { body: "We pay suppliers by transfer; cards are a problem for us.", requester_kind: "customer" });
  add(3, "Save my card for the next order", "support", {
    body: "Asked twice in the support channel this month.", requester_kind: "customer",
    suggestion: {
      theme_id: checkout.id, theme_title: checkout.title, goal_ids: [g0], duplicate_of: null, feature_id: feature,
      confidence: 0.72, rationale: "Same need as saved addresses: less typing at every order", run_id: null, at: daysAgo(1), accepted: [],
    },
  });
  add(2, "Dark mode", "slack", { requester_kind: "team" });
  add(5, "Export orders to a spreadsheet", "sales", { theme_id: reporting.id });
  add(1, "Bulk edit prices", "support", { requester_name: "A shop owner", requester_kind: "customer" });
  add(22, "A custom domain for the shop", "interview", {
    requester_kind: "customer", state: "disqualified", disqualify_reason: "out_of_scope",
    decision_note: "Hosting is not part of the product", ...decided,
  });

  const found = (days: number, title: string, channel: CandidateOut["channel"], item: string, text: string): CandidateOut => ({
    id: mockUuid(), owner_user_id: input.ownerId, run_id: null, title, body: null, requester_name: "A customer", channel,
    theme_title: checkout.title, goal_ids: [g0], confidence: 0.6, rationale: "A request, not a bug report",
    status: "open", request_id: null, created_at: daysAgo(days), updated_at: daysAgo(days),
    source: { item_id: mockUuid(), title: item, url: `https://chat.example.com/archives/C1/p${days}`, kind: "slack", excerpt: excerpt(text) },
  });
  db.candidates.push(
    found(1, "Reorder last week's basket", "support", "#support thread",
      "Could I reorder what I bought last week in one click? I order the same things every Monday and build the basket again by hand each time."),
    found(2, "Pick a delivery slot", "slack", "#sales notes",
      "Two prospects asked whether buyers can choose a delivery slot at check-out. Both said it would decide whether they switch this quarter."),
  );
  return db;
}

/**
 * The daily triage's switch: off unless someone turned it on (the "triage-skipped" scenario has
 * it on with no one to run as). While on it runs as whoever turned it on, while an active
 * approver or owner, else as the longest-standing active owner.
 */
function dailyStatus(db: RequestsDb, ctx: RequestsContext, scenario: boolean) {
  const people = ctx.people?.() ?? [];
  const name = (id: string | undefined) => {
    const person = people.find((x) => x.id === id);
    return person ? displayName(person.email) : null;
  };
  if (!db.daily) return { daily_on: scenario, daily_as: null, daily_changed_by: null, daily_changed_at: null };
  const active = people.filter((x) => !x.disabled_at);
  const enabler = active.find((x) => x.id === db.daily?.by && atLeast(x.role, "approver"));
  const owner = active.filter((x) => x.role === "owner").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  const member = enabler ?? owner;
  return {
    daily_on: db.daily.on,
    daily_as: db.daily.on && member ? displayName(member.email) : null,
    daily_changed_by: name(db.daily.by),
    daily_changed_at: db.daily.at,
  };
}

/** The request mock's routes; null when the path is not one of them. */
export async function routeRequests(db: RequestsDb, ctx: RequestsContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[0] !== "v1" || !["requests", "request-themes", "request-candidates"].includes(p[1])) return null;
  const m = req.method;
  const body = async <T>() => (JSON.parse((await req.text()) || "null") ?? {}) as T;
  const confirmed = new Set(ctx.goals().filter((g) => g.status === "confirmed").map((g) => g.id));
  const badGoals = (ids: string[] | null | undefined) => (ids ?? []).filter((id) => !confirmed.has(id));
  const liveTheme = (id: string) => db.themes.find((t) => t.id === id && !t.archived_at);
  const byTitle = (title: string) => db.themes.find((t) => !t.archived_at && t.title.toLowerCase() === title.trim().toLowerCase());

  const parents = () => new Map(db.requests.filter((r) => r.merged_into_id).map((r) => [r.id, r.merged_into_id!]));
  const descendants = (id: string): Row[] => {
    const out: Row[] = [];
    const stack = db.requests.filter((r) => r.merged_into_id === id);
    while (stack.length) {
      const r = stack.pop()!;
      if (out.includes(r) || r.id === id) continue;
      out.push(r);
      stack.push(...db.requests.filter((x) => x.merged_into_id === r.id));
    }
    return out;
  };
  const rootOf = (id: string): string | null => {
    const up = parents();
    const seen = new Set([id]);
    let at = id;
    while (up.has(at)) {
      at = up.get(at)!;
      if (seen.has(at)) return null;
      seen.add(at);
    }
    return at;
  };
  const out = (r: Row): RequestOut => {
    const { theme_id, document_id, ...rest } = r;
    const theme = theme_id ? db.themes.find((t) => t.id === theme_id) : undefined;
    const doc = document_id ? ctx.documents().find((d) => d.id === document_id) : undefined;
    return {
      ...rest,
      theme: theme ? { id: theme.id, title: theme.title } : null,
      document: doc ? { id: doc.id, slug: doc.slug, title: doc.title } : null,
      mentions: 1 + descendants(r.id).length,
    };
  };
  const themeOut = (t: Theme): ThemeOut => ({
    ...t,
    archived: !!t.archived_at,
    request_count: db.requests.filter((r) => r.theme_id === t.id && r.state !== "merged").length,
  });
  const decide = (r: Row) => {
    r.decided_by = ctx.userId;
    r.decided_at = now();
  };
  const bump = (r: Row | Theme) => {
    r.lock_version += 1;
    r.updated_at = now();
  };

  // --- requests ---------------------------------------------------------------------
  if (p[1] === "requests" && p.length === 2) {
    if (m === "GET") {
      const state = q.get("state");
      const theme = q.get("theme_id");
      const goal = q.get("goal_id");
      const channel = q.get("channel");
      const text = q.get("q")?.trim().toLowerCase();
      const limit = Number(q.get("limit") ?? 50);
      const offset = Number(q.get("offset") ?? 0);
      if (!(limit >= 1 && limit <= 200) || !(offset >= 0)) return fail(422, "limit is 1-200, offset 0 or more");
      const tests: Record<string, (r: Row) => boolean> = {};
      if (state) tests.state = (r) => r.state === state;
      if (theme) tests.theme = (r) => (theme === "none" ? r.theme_id === null : r.theme_id === theme);
      if (goal) tests.goal = (r) => r.goal_ids.includes(goal);
      if (channel) tests.channel = (r) => r.channel === channel;
      if (text) tests.q = (r) => r.title.toLowerCase().includes(text) || (r.body ?? "").toLowerCase().includes(text);
      const where = (...but: string[]) =>
        db.requests.filter((r) => Object.entries(tests).every(([k, t]) => but.includes(k) || t(r)));
      const rows = where().sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
      const byState = where("state");
      const byChannel: Record<string, number> = {};
      for (const r of where("channel")) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
      const week = Date.now() - 7 * 86_400_000;
      const body: Schemas["RequestList"] = {
        items: rows.slice(offset, offset + limit).map(out),
        total: rows.length,
        counts: {
          all: byState.length,
          ...(Object.fromEntries(STATES.map((s) => [s, byState.filter((r) => r.state === s).length])) as Record<State, number>),
        },
        by_channel: Object.fromEntries(Object.entries(byChannel).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
        new_this_week: db.requests.filter((r) => Date.parse(r.created_at) >= week).length,
      };
      return json(200, body);
    }
    if (m === "POST") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      const input = await body<Schemas["RequestCreate"]>();
      const created = createRow(input, null);
      return created instanceof Response ? created : json(201, out(created));
    }
  }

  // Shared by POST /v1/requests and filing a found item.
  function createRow(input: Partial<Schemas["RequestCreate"]>, source: RequestOut["source"]): Row | Response {
    const title = (input.title ?? "").trim();
    if (!title || title.length > 200) return fail(422, "A title of 1-200 characters");
    if ((input.body ?? "").length > 4000) return fail(422, "At most 4000 characters");
    if (!input.channel || !CHANNELS.includes(input.channel)) return fail(422, "channel");
    if (input.channel === "interview") return fail(422, "Interview requests come from interviews");
    if (input.source_item_id) return fail(422, "source_item_id is not one of your own source items");
    const bad = badGoals(input.goal_ids);
    if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
    if (input.theme_id && !liveTheme(input.theme_id)) return fail(422, `Unknown theme: ${input.theme_id}`);
    let requesterName = input.requester_name?.trim() || null;
    let requesterKind = input.requester_kind ?? "unknown";
    if (input.channel === "in_app") {
      // New request in the app (#329): the signed-in member, as team; an owner may name someone else.
      const email = ctx.people?.().find((x) => x.id === ctx.userId)?.email;
      const me = email ? displayName(email) : null;
      if (requesterName && requesterName !== me) {
        if (ctx.role !== "owner") return fail(403, OWNER_NAMES_REQUESTER);
      } else {
        requesterName = me;
        requesterKind = "team";
      }
    }
    const row: Row = {
      id: mockUuid(), title, body: input.body?.trim() || null, channel: input.channel, origin: "person",
      requester_name: requesterName, requester_kind: requesterKind,
      verified: true, state: "new", merged_into_id: null, disqualify_reason: null, decision_note: null,
      theme_id: input.theme_id ?? null, goal_ids: [...new Set(input.goal_ids ?? [])], feature_id: null,
      document_id: null, intake_id: null, interview_id: null, source, suggestion: null, filed_by: ctx.userId,
      decided_by: null, decided_at: null, created_at: now(), updated_at: now(), lock_version: 1,
    };
    db.requests.push(row);
    return row;
  }

  // --- triage (Classify now and the header's status line) --------------------------------
  if (p[1] === "requests" && p[2] === "triage" && p.length === 3) {
    const run = db.triage ?? null;
    if (run && !run.finished_at && Date.now() - Date.parse(run.started_at) >= TRIAGE_MS) {
      // The run ends: a suggestion for every New request with none (data only; nothing decided).
      const goal = [...confirmed][0];
      for (const r of db.requests.filter((x) => x.state === "new" && !x.suggestion)) {
        const theme = db.themes.find((t) => !t.archived_at && goal && t.goal_ids.includes(goal));
        r.suggestion = {
          theme_id: theme?.id ?? null, theme_title: theme?.title ?? null, goal_ids: goal ? [goal] : [], duplicate_of: null,
          feature_id: null, confidence: 0.55, rationale: "Asked for in the same words as this theme's requests",
          run_id: run.id, at: now(), accepted: [],
        };
      }
      run.finished_at = now();
    }
    if (m === "GET") {
      const scenario = localStorage.getItem("po-mock-scenario") === SKIPPED_SCENARIO;
      const daily = dailyStatus(db, ctx, scenario);
      // As the API: no skip reason while the daily triage is off.
      const skipped = !run && scenario && daily.daily_on ? SKIPPED : null;
      const status: Schemas["TriageStatus"] = run
        ? {
            ...daily,
            run_id: run.id, status: run.finished_at ? "succeeded" : "running", active: !run.finished_at,
            automatic: false, started_at: run.started_at, finished_at: run.finished_at,
            suggestions: db.requests.filter((r) => r.suggestion?.run_id === run.id).length,
            found: db.candidates.filter((c) => c.run_id === run.id && c.owner_user_id === ctx.userId).length, error: null,
          }
        : {
            ...daily,
            run_id: null, status: null, active: false, automatic: false, started_at: null, finished_at: null,
            suggestions: 0, found: 0, error: null, daily_skipped: skipped,
          };
      return json(200, status);
    }
    if (m === "POST") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      if (run && !run.finished_at) return fail(409, "Oracle is already classifying requests");
      db.triage = { id: mockUuid(), created_by: ctx.userId, started_at: now(), finished_at: null };
      return json(201, { id: db.triage.id, flow: "request_triage", status: "running", estimate_usd: 1.5 });
    }
  }

  if (p[1] === "requests" && p[2] === "triage" && p[3] === "daily" && p.length === 4 && m === "PUT") {
    if (!atLeast(ctx.role, "approver")) return forbidden("approver");
    const body = (await req.json()) as Schemas["TriageDailyIn"];
    db.daily = { on: body.on, by: ctx.userId, at: now() };
    return routeRequests(db, ctx, new Request(req.url, { method: "GET" }), p.slice(0, 3), q);
  }

  if (p[1] === "requests" && p[2]) {
    const row = db.requests.find((r) => r.id === p[2]);
    if (!row) return fail(404, "Request not found");
    if (p.length === 3 && m === "GET") {
      const doc = row.document_id ? ctx.documents().find((d) => d.id === row.document_id) : undefined;
      const detail: Schemas["RequestDetail"] = {
        ...out(row),
        merged: descendants(row.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(out),
        document: doc ?? null,
      };
      return json(200, detail);
    }
    if (p.length === 3 && m === "PATCH") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      const patch = await body<Schemas["RequestPatch"]>();
      if (patch.lock_version !== row.lock_version) return stale();
      const fields = Object.keys(patch).filter((k) => k !== "lock_version");
      if (fields.some((f) => f === "title" || f === "body")) {
        if (row.origin === "interview") return fail(403, "A request from an interview keeps the customer's words");
        if (row.filed_by !== ctx.userId) return fail(403, "Only the person who filed a request edits its words");
        if (row.state !== "new") return fail(409, "A request's words change only while it is New");
        if ("title" in patch && !(patch.title ?? "").trim()) return fail(422, "A request needs a title");
      }
      if (fields.some((f) => ["goal_ids", "theme_id", "feature_id", "document_id"].includes(f))) {
        if (!atLeast(ctx.role, "approver")) return forbidden("approver");
        const bad = badGoals(patch.goal_ids);
        if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
        if (patch.theme_id && !liveTheme(patch.theme_id)) return fail(422, `Unknown theme: ${patch.theme_id}`);
        if (patch.feature_id && !ctx.features().some((f) => f.id === patch.feature_id)) return fail(422, `Unknown feature: ${patch.feature_id}`);
        if (patch.document_id && !ctx.documents().some((d) => d.id === patch.document_id)) return fail(422, `Unknown document: ${patch.document_id}`);
      }
      if (patch.title != null) row.title = patch.title.trim();
      if ("body" in patch) row.body = patch.body?.trim() || null;
      if ("goal_ids" in patch) row.goal_ids = [...new Set(patch.goal_ids ?? [])];
      if ("theme_id" in patch) row.theme_id = patch.theme_id ?? null;
      if ("feature_id" in patch) row.feature_id = patch.feature_id ?? null;
      if ("document_id" in patch) row.document_id = patch.document_id ?? null;
      if (fields.length) bump(row);
      return json(200, out(row));
    }
    if (m === "POST" && p.length >= 4) {
      const verb = p.slice(3).join("/");
      if (!["qualify", "merge", "disqualify", "reopen", "suggestion/accept", "suggestion/decline"].includes(verb)) return null;
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      const input = await body<{ lock_version: number } & Record<string, unknown>>();
      if (input.lock_version !== row.lock_version) return stale();
      const mergeInto = (into: string): Response | null => {
        if (row.state !== "new" && row.state !== "qualified") return fail(409, "Only a New or Qualified request can be merged");
        if (!db.requests.some((r) => r.id === into)) return fail(404, "Request to merge into not found");
        const root = rootOf(into);
        if (root === null || root === row.id) return fail(409, "That merge would form a cycle");
        row.state = "merged";
        row.merged_into_id = root;
        decide(row);
        return null;
      };
      if (verb === "qualify") {
        if (row.state !== "new") return fail(409, "Only a New request can be qualified");
        const goals = (input.goal_ids as string[] | undefined) ?? row.goal_ids;
        const bad = input.goal_ids ? badGoals(goals) : [];
        if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
        if (!goals.some((g) => confirmed.has(g))) return fail(422, NEEDS_GOAL);
        row.goal_ids = [...new Set(goals)];
        row.state = "qualified";
        row.decision_note = ((input.note as string | undefined) ?? "").trim() || null;
        decide(row);
      } else if (verb === "merge") {
        const refused = mergeInto(String(input.into_id ?? ""));
        if (refused) return refused;
      } else if (verb === "disqualify") {
        const reason = String(input.reason ?? "");
        const note = ((input.note as string | undefined) ?? "").trim();
        if (!REASONS.includes(reason)) return fail(422, "reason");
        if (row.state !== "new" && row.state !== "qualified") return fail(409, "Only a New or Qualified request can be disqualified");
        if (reason === "other" && !note) return fail(422, "Say why in a note when the reason is Other");
        row.state = "disqualified";
        row.disqualify_reason = reason as Row["disqualify_reason"];
        row.decision_note = note || null;
        decide(row);
      } else if (verb === "reopen") {
        if (row.state !== "merged" && row.state !== "disqualified") return fail(409, "Only a Merged or Disqualified request can be reopened");
        Object.assign(row, { state: "new", merged_into_id: null, disqualify_reason: null, decision_note: null, decided_by: null, decided_at: null });
      } else if (verb === "suggestion/decline") {
        if (row.state !== "new") return fail(409, "Only a New request takes Oracle's suggestions");
        if (!row.suggestion || row.suggestion.declined_at) return fail(422, "Oracle has no suggestion for this request");
        row.suggestion = { ...row.suggestion, declined_at: now() };
      } else {
        const parts = (input.parts as Part[] | undefined) ?? [];
        if (parts.length === 0) return fail(422, "parts: at least one");
        if (row.state !== "new") return fail(409, "Only a New request takes Oracle's suggestions");
        const s = row.suggestion;
        if (!s || s.declined_at) return fail(422, "Oracle has no suggestion for this request");
        // Every check first, as the API: a refused part changes nothing.
        if (parts.includes("theme") && !(s.theme_id ? liveTheme(s.theme_id) : s.theme_title?.trim())) return fail(422, "Oracle suggested no theme");
        if (parts.includes("goals") && (!s.goal_ids?.length || badGoals(s.goal_ids).length)) return fail(422, "Oracle suggested no confirmed goal");
        if (parts.includes("feature") && !(s.feature_id && ctx.features().some((f) => f.id === s.feature_id))) return fail(422, "Oracle suggested no feature");
        if (parts.includes("duplicate") && !s.duplicate_of) return fail(422, "Oracle suggested no duplicate");
        if (parts.includes("duplicate")) {
          const refused = mergeInto(s.duplicate_of!);
          if (refused) return refused;
        }
        if (parts.includes("theme")) {
          let theme = s.theme_id ? liveTheme(s.theme_id) : byTitle(s.theme_title!);
          if (!theme) {
            theme = {
              id: mockUuid(), title: s.theme_title!.trim(), description: null, goal_ids: (s.goal_ids ?? []).filter((g) => confirmed.has(g)),
              origin: "oracle", archived_at: null, created_by: ctx.userId, created_at: now(), updated_at: now(), lock_version: 1,
            };
            db.themes.push(theme);
          }
          row.theme_id = theme.id;
        }
        if (parts.includes("goals")) row.goal_ids = [...new Set(s.goal_ids!)];
        if (parts.includes("feature")) row.feature_id = s.feature_id ?? null;
        row.suggestion = { ...s, accepted: [...new Set([...(s.accepted ?? []), ...parts])].sort() };
      }
      bump(row);
      return json(200, out(row));
    }
  }

  // --- themes -----------------------------------------------------------------------
  if (p[1] === "request-themes") {
    if (p.length === 2 && m === "GET") {
      const all = q.get("include_archived") === "true";
      const list = db.themes.filter((t) => all || !t.archived_at).sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
      return json(200, list.map(themeOut));
    }
    if (!atLeast(ctx.role, "approver")) return forbidden("approver");
    if (p.length === 2 && m === "POST") {
      const input = await body<Schemas["RequestThemeCreate"]>();
      const title = (input.title ?? "").trim();
      if (!title || title.length > 120) return fail(422, "A title of 1-120 characters");
      const bad = badGoals(input.goal_ids);
      if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
      if (byTitle(title)) return fail(409, "A theme with this title exists; pick another or use that one");
      const theme: Theme = {
        id: mockUuid(), title, description: input.description?.trim() || null, goal_ids: [...new Set(input.goal_ids ?? [])],
        origin: "person", archived_at: null, created_by: ctx.userId, created_at: now(), updated_at: now(), lock_version: 1,
      };
      db.themes.push(theme);
      return json(201, themeOut(theme));
    }
    const theme = db.themes.find((t) => t.id === p[2]);
    if (p.length === 3 && m === "PATCH") {
      if (!theme) return fail(404, "Theme not found");
      const patch = await body<Schemas["RequestThemePatch"]>();
      if (patch.lock_version !== theme.lock_version) return stale();
      const title = patch.title?.trim() || theme.title;
      const archived = patch.archived ?? !!theme.archived_at;
      const bad = badGoals(patch.goal_ids);
      if (bad.length) return fail(422, `Unknown goal: ${bad.join(", ")} is not a confirmed goal`);
      const taken = byTitle(title);
      if (!archived && taken && taken.id !== theme.id) return fail(409, "A theme with this title exists; pick another or use that one");
      theme.title = title;
      if ("description" in patch) theme.description = patch.description?.trim() || null;
      if (patch.goal_ids) theme.goal_ids = [...new Set(patch.goal_ids)];
      theme.archived_at = archived ? (theme.archived_at ?? now()) : null;
      bump(theme);
      return json(200, themeOut(theme));
    }
  }

  // --- found in your sources (the signed-in person's own) ------------------------------
  if (p[1] === "request-candidates") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const mine = db.candidates.filter((c) => c.owner_user_id === ctx.userId);
    if (p.length === 2 && m === "GET") {
      const status = q.get("status");
      return json(200, mine.filter((c) => !status || c.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }
    const candidate = mine.find((c) => c.id === p[2]);
    if (!candidate) return fail(404, "Found item not found");
    if (m !== "POST" || p.length !== 4) return null;
    if (candidate.status !== "open") return fail(409, `This item is already ${candidate.status}`);
    if (p[3] === "dismiss") {
      Object.assign(candidate, { status: "dismissed", updated_at: now() });
      return json(200, candidate);
    }
    if (p[3] === "file") {
      const input = await body<Partial<Schemas["RequestCreate"]>>();
      const created = createRow(
        {
          title: candidate.title, body: candidate.body, channel: candidate.channel, requester_name: candidate.requester_name,
          requester_kind: "unknown", goal_ids: candidate.goal_ids.filter((g) => confirmed.has(g)),
          theme_id: candidate.theme_title ? byTitle(candidate.theme_title)?.id ?? null : null, ...input, source_item_id: null,
        },
        { ...candidate.source, removed: false },
      );
      if (created instanceof Response) return created;
      Object.assign(candidate, { status: "filed", request_id: created.id, updated_at: now() });
      return json(201, out(created));
    }
  }
  return null;
}
