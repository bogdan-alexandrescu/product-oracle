/**
 * Mock of the baseline graph API (/v1/baseline/...), used by mock mode. Generic,
 * fictional data only: an example company with made-up goals, products and features.
 * The rules follow api/oracle/baseline: a person's edit locks the item, an agent write
 * to a locked item becomes a proposal, the trace report flags features that serve no
 * confirmed goal or rest on weak evidence.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["Me"]["role"];
type EntityRow = Omit<Schemas["EntityOut"], "evidence_count">;
type EdgeRow = Omit<Schemas["EdgeOut"], "evidence_count">;
type EvidenceRow = Schemas["EvidenceOut"];
type ConflictRow = Schemas["ConflictOut"];
type ProposalRow = Schemas["ProposalOut"];
type Attrs = Record<string, unknown>;

export interface BaselineState {
  entities: EntityRow[];
  edges: EdgeRow[];
  evidence: EvidenceRow[];
  conflicts: ConflictRow[];
  proposals: ProposalRow[];
}

export type BaselineCaller = { userId: string; role: Role };

/** Below this every piece of a feature's evidence counts as weak (confidence DEFAULTS.low). */
export const LOW_CONFIDENCE = 0.4;
const WEIGHTS = { source: 0.35, freshness: 0.25, mentions: 0.2, goal_impact: 0.2 } as const;
const ROLE_ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];
// A colleague who locked an item before you signed in.
const OTHER_MEMBER = "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7";
const AGENT_RUN = "0b7e5d4c-3a29-4118-9f07-e6d5c4b3a291";

const now = () => new Date().toISOString();

let counter = 0;
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  counter += 1;
  return `00000000-0000-4000-9000-${String(Date.now() + counter).padStart(12, "0").slice(-12)}`;
}

// ---------------------------------------------------------------- seed

type Factors = { source: number; freshness: number; mentions: number; goal_impact: number };

function scored(f: Factors, latestAt: string) {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const confidence =
    Math.round(((Object.keys(WEIGHTS) as (keyof Factors)[]).reduce((s, k) => s + f[k] * WEIGHTS[k], 0) / total) * 100) /
    100;
  return {
    confidence,
    confidence_factors: {
      inputs: { latest_at: latestAt, mentions: Math.round(f.mentions * 5) },
      breakdown: Object.fromEntries(
        (Object.keys(WEIGHTS) as (keyof Factors)[]).map((k) => [k, { value: f[k], weight: WEIGHTS[k] }]),
      ),
      weights: { ...WEIGHTS },
    },
    scored_at: "2026-10-16T08:00:00Z",
  };
}

export function seedBaseline(uuid: () => string): BaselineState {
  const s: BaselineState = { entities: [], edges: [], evidence: [], conflicts: [], proposals: [] };
  const t0 = "2026-10-12T09:00:00Z";

  const entity = (
    type: EntityRow["type"],
    key: string,
    title: string,
    opts: { body?: string; attrs?: Attrs; status?: EntityRow["status"]; confidence?: number | null; locked?: boolean } = {},
  ): EntityRow => {
    const row: EntityRow = {
      id: uuid(),
      type,
      key,
      title,
      body: opts.body ?? null,
      attrs: opts.attrs ?? {},
      status: opts.status ?? "confirmed",
      origin: "agent",
      locked: !!opts.locked,
      locked_by: opts.locked ? OTHER_MEMBER : null,
      locked_at: opts.locked ? "2026-10-15T14:20:00Z" : null,
      confidence: opts.confidence ?? null,
      run_id: AGENT_RUN,
      created_at: t0,
      updated_at: t0,
    };
    s.entities.push(row);
    return row;
  };
  const edge = (src: EntityRow, type: EdgeRow["type"], dst: EntityRow, attrs: Attrs = {}) => {
    const row: EdgeRow = {
      id: uuid(),
      src_id: src.id,
      dst_id: dst.id,
      type,
      attrs,
      status: "confirmed",
      origin: "agent",
      locked: false,
      locked_by: null,
      locked_at: null,
      confidence: null,
      run_id: AGENT_RUN,
      created_at: t0,
      updated_at: t0,
    };
    s.edges.push(row);
    return row;
  };
  const cite = (
    target: EntityRow,
    source_kind: string,
    f: Factors,
    e: { url: string; ref: string; excerpt: string; retrieved_at: string; private?: boolean; itemTitle?: string },
  ) => {
    const row: EvidenceRow = {
      id: uuid(),
      entity_id: target.id,
      edge_id: null,
      url: e.url,
      excerpt: e.excerpt,
      ref: e.ref,
      retrieved_at: e.retrieved_at,
      source_kind,
      source_item: e.private
        ? null
        : {
            id: uuid(),
            source_id: uuid(),
            source_kind: source_kind.split(":")[0],
            kind: source_kind.split(":")[1] ?? "message",
            title: e.itemTitle ?? e.ref,
            url: e.url,
          },
      source_item_private: !!e.private,
      ...scored(f, e.retrieved_at),
      created_at: e.retrieved_at,
    };
    s.evidence.push(row);
    return row;
  };

  // Goals: two confirmed, one still proposed (and served by nothing yet).
  const activation = entity("goal", "g.activation", "Raise activation", {
    body: "More new accounts reach their first successful order in the first week.",
    attrs: { weight: 0.5, metric: "Accounts that finish setup within 7 days", target: "45%", horizon: "2026-Q4" },
    confidence: 0.78,
  });
  const paid = entity("goal", "g.paid-conversion", "Grow paid conversion", {
    body: "More trial accounts move to a paid plan.",
    attrs: { weight: 0.3, metric: "Trial to paid rate", target: "12%", horizon: "2027-H1" },
    confidence: 0.66,
  });
  entity("goal", "g.early-churn", "Cut early churn", {
    body: "Fewer accounts leave in their first three months.",
    attrs: { weight: 0.2, metric: "Accounts lost in the first 90 days", target: "below 8%", horizon: "2027-H1" },
    status: "proposed",
    confidence: 0.45,
  });

  // Products.
  const storefront = entity("product", "p.storefront", "Storefront", { body: "The shop builder new accounts start with." });
  const console_ = entity("product", "p.admin-console", "Admin console", { body: "Settings, members and billing." });

  // Features.
  const guided = entity("feature", "f.guided-setup", "Guided setup", {
    body: "A short checklist that walks a new account through its first product, payment method and test order.",
    attrs: { status: "in_progress", effort: "M" },
    confidence: 0.71,
    locked: true,
  });
  const sample = entity("feature", "f.sample-data", "Sample data", {
    body: "Prefill a new store with example products so the first preview is not empty.",
    attrs: { status: "planned", effort: "S" },
    confidence: 0.71,
  });
  const carts = entity("feature", "f.saved-carts", "Saved carts", {
    body: "Shoppers can keep a cart and come back to it on another device.",
    attrs: { status: "planned", effort: "L" },
    confidence: 0.3,
  });
  const invites = entity("feature", "f.team-invites", "Team invites", {
    body: "Invite teammates during setup.",
    attrs: { status: "shipped", effort: "S" },
    confidence: 0.68,
  });
  const dark = entity("feature", "f.dark-mode", "Dark mode", {
    body: "A dark theme for the admin console.",
    attrs: { status: "idea", effort: "M" },
    confidence: 0.52,
  });
  const usage = entity("feature", "f.usage-export", "Usage export", {
    body: "Download monthly usage as CSV.",
    attrs: { status: "idea" },
    status: "proposed",
  });

  edge(guided, "part_of", storefront);
  edge(sample, "part_of", storefront);
  edge(carts, "part_of", storefront);
  edge(invites, "part_of", console_);
  edge(dark, "part_of", console_);
  // Usage export has no product yet.

  edge(guided, "supports", activation, { contribution: 3 });
  edge(guided, "supports", paid, { contribution: 1 });
  edge(sample, "supports", activation, { contribution: 2 });
  edge(carts, "supports", paid, { contribution: 2 });
  edge(invites, "supports", activation, { contribution: 1 });
  edge(usage, "supports", paid, { contribution: 1 });

  edge(guided, "depends_on", sample);
  edge(guided, "blocks", carts);

  cite(guided, "github:issue", { source: 0.9, freshness: 0.85, mentions: 0.6, goal_impact: 0.75 }, {
    url: "https://github.com/example-org/storefront/issues/128",
    ref: "example-org/storefront#128",
    excerpt: "New accounts stall before adding a payment method; a setup checklist should point them to it.",
    retrieved_at: "2026-10-14T10:05:00Z",
    itemTitle: "Setup checklist for new accounts",
  });
  cite(guided, "slack", { source: 0.5, freshness: 0.8, mentions: 0.4, goal_impact: 0.5 }, {
    url: "https://example.slack.com/archives/C0GROWTH/p1760000000",
    ref: "#growth thread",
    excerpt: "Support keeps walking people through the same first three steps by hand.",
    retrieved_at: "2026-10-13T16:40:00Z",
    private: true,
  });
  cite(guided, "fireflies", { source: 0.7, freshness: 0.9, mentions: 0.8, goal_impact: 0.6 }, {
    url: "https://app.example-notes.com/view/onboarding-review",
    ref: "Onboarding review (meeting)",
    excerpt: "Agreed to ship the checklist before the sample store work lands.",
    retrieved_at: "2026-10-15T09:30:00Z",
    itemTitle: "Onboarding review",
  });
  cite(sample, "notion", { source: 0.8, freshness: 0.7, mentions: 0.5, goal_impact: 0.7 }, {
    url: "https://www.notion.so/example/Sample-store-0000000000",
    ref: "Sample store spec",
    excerpt: "An empty preview is the most common reason given for leaving setup early.",
    retrieved_at: "2026-10-11T12:00:00Z",
    itemTitle: "Sample store spec",
  });
  cite(carts, "slack", { source: 0.3, freshness: 0.2, mentions: 0.3, goal_impact: 0.4 }, {
    url: "https://example.slack.com/archives/C0SALES/p1750000000",
    ref: "#sales thread",
    excerpt: "One prospect asked whether carts can be saved across devices.",
    retrieved_at: "2026-08-02T15:00:00Z",
    itemTitle: "#sales thread",
  });
  cite(carts, "upload", { source: 0.4, freshness: 0.25, mentions: 0.2, goal_impact: 0.3 }, {
    url: "https://files.example.com/wishlist-2026.pdf",
    ref: "Feature wishlist (upload)",
    excerpt: "Saved carts: requested twice.",
    retrieved_at: "2026-07-20T10:00:00Z",
    itemTitle: "Feature wishlist",
  });
  cite(invites, "github:pull_request", { source: 0.9, freshness: 0.5, mentions: 0.4, goal_impact: 0.7 }, {
    url: "https://github.com/example-org/console/pull/77",
    ref: "example-org/console#77",
    excerpt: "Adds an invite step to the setup flow.",
    retrieved_at: "2026-09-30T08:00:00Z",
    itemTitle: "Invite teammates from setup",
  });
  cite(dark, "slack", { source: 0.5, freshness: 0.6, mentions: 0.6, goal_impact: 0.3 }, {
    url: "https://example.slack.com/archives/C0DESIGN/p1760500000",
    ref: "#design thread",
    excerpt: "A few admins asked for a dark theme for late shifts.",
    retrieved_at: "2026-10-09T19:10:00Z",
    itemTitle: "#design thread",
  });

  // Conflicts: one material and open, one logged.
  s.conflicts.push({
    id: uuid(),
    entity_id: carts.id,
    edge_id: null,
    field: "attrs.status",
    claims: [
      {
        value: "in_progress",
        evidence_ids: [],
        source_kind: "github:pull_request",
        source_class: "code",
        observed_at: "2026-10-14T11:00:00Z",
        confidence: 0.52,
      },
      {
        value: "planned",
        evidence_ids: [],
        source_kind: "linear",
        source_class: "tracker",
        observed_at: "2026-10-10T09:00:00Z",
        confidence: 0.58,
      },
    ],
    resolution: {
      rule: "confidence tie (0.52 vs 0.58); code beats tracker",
      decided_by: "precedence",
      current: "planned",
      winner: 0,
      value: "in_progress",
      applied: false,
    },
    material: true,
    status: "open",
    created_at: "2026-10-16T07:30:00Z",
  });
  s.conflicts.push({
    id: uuid(),
    entity_id: activation.id,
    edge_id: null,
    field: "attrs.metric",
    claims: [
      {
        value: "Accounts that finish setup within 7 days",
        evidence_ids: [],
        source_kind: "notion",
        source_class: "docs",
        observed_at: "2026-10-11T12:00:00Z",
        confidence: 0.74,
      },
      {
        value: "Accounts that finish setup within 14 days",
        evidence_ids: [],
        source_kind: "slack",
        source_class: "chat",
        observed_at: "2026-09-02T10:00:00Z",
        confidence: 0.41,
      },
    ],
    resolution: {
      rule: "confidence 0.74 beats 0.41",
      decided_by: "precedence",
      current: "Accounts that finish setup within 7 days",
      winner: 0,
      value: "Accounts that finish setup within 7 days",
      applied: false,
    },
    material: false,
    status: "logged",
    created_at: "2026-10-15T07:30:00Z",
  });

  // Proposals from an agent run: one on the locked feature.
  const proposal = (target: EntityRow, fields: Attrs, reason: string, created_at: string) =>
    s.proposals.push({
      id: uuid(),
      entity_id: target.id,
      edge_id: null,
      payload: { op: "update", kind: "entity", fields, reason, origin: "agent" },
      run_id: AGENT_RUN,
      actor: `run:${AGENT_RUN}`,
      status: "open",
      decided_by: null,
      decided_at: null,
      created_at,
    });
  proposal(guided, { attrs: { effort: "L" } }, "The setup review estimated more work than planned.", "2026-10-16T08:10:00Z");
  proposal(dark, { attrs: { status: "planned" } }, "Mentioned as next up in the planning call.", "2026-10-16T08:12:00Z");

  return s;
}

// ---------------------------------------------------------------- trace (as api/oracle/baseline/trace.py)

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function traceReport(s: BaselineState, low = LOW_CONFIDENCE): Schemas["TraceReport"] {
  const live = s.entities
    .filter((e) => (e.type === "feature" || e.type === "goal") && e.status !== "rejected")
    .sort((a, b) => a.key.localeCompare(b.key));
  const features = live.filter((e) => e.type === "feature");
  const goals = live.filter((e) => e.type === "goal");
  const byId = new Map(live.map((e) => [e.id, e]));
  const featureIds = new Set(features.map((f) => f.id));

  const links = new Map<string, { goal: EntityRow; contribution: number }[]>();
  for (const e of s.edges) {
    if (e.type !== "supports" || e.status === "rejected" || !featureIds.has(e.src_id)) continue;
    const goal = byId.get(e.dst_id);
    if (!goal || goal.type !== "goal") continue;
    const list = links.get(e.src_id) ?? [];
    list.push({ goal, contribution: Math.trunc(num(e.attrs?.contribution) ?? 0) });
    links.set(e.src_id, list);
  }

  const goalFeatures = new Map<string, Schemas["TraceGoalFeature"][]>();
  const outFeatures: Schemas["TraceFeature"][] = features.map((f) => {
    const mine = links.get(f.id) ?? [];
    const flags: string[] = [];
    if (!mine.some((l) => l.goal.status === "confirmed")) flags.push("serves_no_goal");
    const scores = s.evidence.filter((ev) => ev.entity_id === f.id).map((ev) => ev.confidence ?? null);
    if (scores.length === 0) flags.push("no_evidence");
    else if (scores.every((c) => c == null || c < low)) flags.push("low_confidence");
    for (const l of mine) {
      const list = goalFeatures.get(l.goal.id) ?? [];
      list.push({ id: f.id, key: f.key, title: f.title, contribution: l.contribution });
      goalFeatures.set(l.goal.id, list);
    }
    return {
      id: f.id,
      key: f.key,
      title: f.title,
      status: f.status,
      confidence: num(f.confidence),
      evidence_count: scores.length,
      goals: [...mine]
        .sort((a, b) => b.contribution - a.contribution)
        .map((l) => ({ goal_id: l.goal.id, key: l.goal.key, title: l.goal.title, contribution: l.contribution })),
      flags,
    };
  });

  const outGoals: Schemas["TraceGoal"][] = goals.map((g) => {
    const fs = [...(goalFeatures.get(g.id) ?? [])].sort((a, b) => b.contribution - a.contribution);
    return {
      id: g.id,
      key: g.key,
      title: g.title,
      status: g.status,
      weight: num(g.attrs?.weight),
      confidence: num(g.confidence),
      features: fs,
      coverage: fs.reduce((sum, x) => sum + x.contribution, 0),
    };
  });
  const flagged = outFeatures.filter((f) => f.flags.length > 0);
  const confirmedGoals = outGoals.filter((g) => g.status === "confirmed");
  return {
    low,
    features: outFeatures,
    flagged,
    goals: outGoals,
    summary: {
      features: outFeatures.length,
      flagged: flagged.length,
      serves_no_goal: outFeatures.filter((f) => f.flags.includes("serves_no_goal")).length,
      weak_evidence: outFeatures.filter((f) => f.flags.includes("no_evidence") || f.flags.includes("low_confidence"))
        .length,
      goals: outGoals.length,
      confirmed_goals: confirmedGoals.length,
      uncovered_goals: confirmedGoals.filter((g) => g.features.length === 0).length,
    },
  };
}

// ---------------------------------------------------------------- writes

function mergeAttrs(current: Attrs, patch: Attrs): Attrs {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class MockError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Changes = { title?: string | null; body?: string | null; attrs?: Attrs | null; status?: EntityRow["status"] | null };

/** The subset of `changes` that differs from the entity, attrs merged (as service._entity_changes). */
function entityDiff(e: EntityRow, changes: Changes): Partial<EntityRow> {
  const out: Partial<EntityRow> = {};
  if (changes.title != null && changes.title !== e.title) out.title = changes.title;
  if ("body" in changes && (changes.body ?? null) !== (e.body ?? null)) out.body = changes.body ?? null;
  if (changes.attrs != null) {
    const merged = mergeAttrs(e.attrs, changes.attrs);
    if (!same(merged, e.attrs)) out.attrs = merged;
  }
  if (changes.status != null && changes.status !== e.status) out.status = changes.status;
  return out;
}

function lock(item: EntityRow | EdgeRow, userId: string) {
  item.locked = true;
  item.locked_by = userId;
  item.locked_at = now();
}

/** Applies a write as service.update_entity does: a person's edit locks; an agent's on a locked item proposes. */
function updateEntity(
  s: BaselineState,
  e: EntityRow,
  changes: Changes,
  writer: { origin: "user" | "agent"; userId: string; reason?: string | null; runId?: string | null },
): ProposalRow | null {
  const diff = entityDiff(e, changes);
  if (Object.keys(diff).length === 0) return null;
  if (e.type === "goal" && diff.status === "confirmed") throw new MockError(422, "confirm a goal with POST .../confirm");
  if (e.locked && writer.origin !== "user") {
    const fields = Object.fromEntries(Object.entries(changes).filter(([k]) => k in diff));
    const p: ProposalRow = {
      id: newId(),
      entity_id: e.id,
      edge_id: null,
      payload: { op: "update", kind: "entity", fields, reason: writer.reason ?? null, origin: writer.origin },
      run_id: writer.runId ?? null,
      actor: writer.runId ? `run:${writer.runId}` : `user:${writer.userId}`,
      status: "open",
      decided_by: null,
      decided_at: null,
      created_at: now(),
    };
    s.proposals.push(p);
    return p;
  }
  Object.assign(e, diff, { updated_at: now() });
  if (writer.origin === "user") lock(e, writer.userId);
  return null;
}

function changesFor(field: string, value: unknown): Changes {
  if (field.startsWith("attrs.")) return { attrs: { [field.slice("attrs.".length)]: value } };
  return { [field]: value } as Changes;
}

// ---------------------------------------------------------------- routing

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fail = (status: number, detail: string) => json(status, { detail });

function withCount<T extends { id: string }>(s: BaselineState, row: T, key: "entity_id" | "edge_id") {
  return { ...row, evidence_count: s.evidence.filter((ev) => ev[key] === row.id).length };
}

/**
 * Handles /v1/baseline/<rest>. `rest` is the path after "baseline" (already split and
 * decoded). Writes need approver or owner, as in the API.
 */
export async function routeBaseline(
  s: BaselineState,
  caller: BaselineCaller,
  req: Request,
  rest: string[],
  q: URLSearchParams,
): Promise<Response> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const entityOut = (e: EntityRow) => withCount(s, e, "entity_id") as Schemas["EntityOut"];
  const edgeOut = (e: EdgeRow) => withCount(s, e, "edge_id") as Schemas["EdgeOut"];
  const findEntity = (id: string) => s.entities.find((e) => e.id === id);

  if (m !== "GET" && ROLE_ORDER.indexOf(caller.role) < ROLE_ORDER.indexOf("approver")) {
    return fail(403, "Requires the approver role");
  }

  try {
    const [head, id, action] = rest;

    if (head === "graph" && m === "GET") {
      return json(200, { entities: s.entities.map(entityOut), edges: s.edges.map(edgeOut) });
    }
    if (head === "trace" && m === "GET") return json(200, traceReport(s));

    if (head === "entities" && !id && m === "GET") {
      const type = q.get("type");
      const status = q.get("status");
      return json(
        200,
        s.entities.filter((e) => (!type || e.type === type) && (!status || e.status === status)).map(entityOut),
      );
    }

    if (head === "entities" && id) {
      const e = findEntity(id);
      if (!e) return fail(404, "Entity not found");
      if (!action && m === "GET") {
        const detail: Schemas["EntityDetail"] = {
          ...entityOut(e),
          evidence: s.evidence.filter((ev) => ev.entity_id === e.id),
          edges_out: s.edges.filter((x) => x.src_id === e.id).map(edgeOut),
          edges_in: s.edges.filter((x) => x.dst_id === e.id).map(edgeOut),
          open_proposals: s.proposals.filter((p) => p.status === "open" && p.entity_id === e.id).length,
        };
        return json(200, detail);
      }
      if (!action && m === "PATCH") {
        const input = await body<Schemas["EntityPatch"]>();
        const proposal = updateEntity(s, e, input as Changes, {
          origin: input.origin ?? "user",
          userId: caller.userId,
          reason: input.reason,
          runId: input.run_id,
        });
        const out: Schemas["EntityWriteOut"] = { applied: !proposal, entity: entityOut(e), proposal };
        return json(proposal ? 202 : 200, out);
      }
      if ((action === "confirm" || action === "reject") && m === "POST") {
        const status = action === "confirm" ? "confirmed" : "rejected";
        if (e.status !== status) {
          e.status = status;
          e.updated_at = now();
          lock(e, caller.userId);
        }
        return json(200, entityOut(e));
      }
      if (action === "unlock" && m === "POST") {
        Object.assign(e, { locked: false, locked_by: null, locked_at: null });
        return json(200, entityOut(e));
      }
      if (action === "revisions" && m === "GET") return json(200, []);
    }

    if (head === "proposals" && !id && m === "GET") {
      const status = q.get("status");
      return json(
        200,
        s.proposals
          .filter((p) => !status || p.status === status)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    }
    if (head === "proposals" && id && (action === "accept" || action === "reject") && m === "POST") {
      const p = s.proposals.find((x) => x.id === id);
      if (!p) return fail(404, "Proposal not found");
      if (p.status !== "open") return fail(409, `Proposal is already ${p.status}`);
      if (action === "accept") {
        const payload = p.payload as { op: string; kind: string; fields?: Changes };
        if (payload.kind !== "entity" || payload.op !== "update") {
          return fail(501, "Only entity updates can be accepted in mock mode");
        }
        const target = p.entity_id ? findEntity(p.entity_id) : undefined;
        if (!target) return fail(404, "Entity not found");
        updateEntity(s, target, payload.fields ?? {}, { origin: "user", userId: caller.userId });
      }
      Object.assign(p, {
        status: action === "accept" ? "accepted" : "rejected",
        decided_by: caller.userId,
        decided_at: now(),
      });
      return json(200, p);
    }

    if (head === "conflicts" && !id && m === "GET") {
      const status = q.get("status");
      const material = q.get("material");
      return json(
        200,
        s.conflicts
          .filter((c) => (!status || c.status === status) && (material == null || String(c.material) === material))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    }
    if (head === "conflicts" && id && action === "resolve" && m === "POST") {
      const c = s.conflicts.find((x) => x.id === id);
      if (!c) return fail(404, "Conflict not found");
      if (c.status === "resolved") return fail(409, "Conflict is already resolved");
      const input = await body<Schemas["ConflictResolve"]>();
      let value = input.value;
      if (input.claim != null) {
        if (input.claim < 0 || input.claim >= c.claims.length) return fail(422, "claim index out of range");
        value = c.claims[input.claim].value;
      } else if (value == null) {
        return fail(422, "pick a claim or give a value");
      }
      const target = c.entity_id ? findEntity(c.entity_id) : undefined;
      if (!target) return fail(501, "Only entity conflicts can be resolved in mock mode");
      updateEntity(s, target, changesFor(c.field, value), { origin: "user", userId: caller.userId });
      c.resolution = {
        ...(c.resolution ?? {}),
        winner: input.claim ?? null,
        value,
        decided_by: `user:${caller.userId}`,
        note: input.note ?? null,
        applied: true,
        proposal_id: null,
      };
      c.status = "resolved";
      return json(200, c);
    }
  } catch (e) {
    if (e instanceof MockError) return fail(e.status, e.message);
    throw e;
  }
  return json(501, { detail: "This baseline route is not available in mock mode" });
}
