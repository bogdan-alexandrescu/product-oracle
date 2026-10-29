/**
 * Mock of the baseline graph API (/v1/baseline/...), used by mock mode. Generic,
 * fictional data only: an example company with made-up goals, products and features.
 * The rules follow api/oracle/baseline: a person's edit locks the item, an agent write
 * to a locked item becomes a proposal, the trace report flags features that serve no
 * confirmed goal or rest on weak evidence.
 */
import type { Schemas } from "@/lib/api/client";

import { DEPOSITS_IDS } from "./blockers";
import { describe, proposer } from "./describe";
import { goalCheck, readText, refusedProblems, todayIso, unitOk, type GoalProblem } from "./goals";
import { MOCK_SCENARIO_KEY, PRODUCT_CHAT_ID, seededItemId } from "./ids";
import { routeEvidenceLinks } from "./public-links";

type Role = Schemas["Me"]["role"];
type EntityRow = Omit<Schemas["EntityOut"], "evidence_count">;
type EdgeRow = Omit<Schemas["EdgeOut"], "evidence_count">;
/** Stored with who added it: a commenter removes only the link evidence they added (C2c). */
type EvidenceRow = Schemas["EvidenceOut"] & { added_by?: string | null };
type ConflictRow = Schemas["ConflictOut"];
/** Stored as the API stores it: the sentence and who made it are written when it is read (B4). */
type ProposalRow = Omit<Schemas["ProposalOut"], "summary" | "proposer" | "run" | "overlaps">;
type Attrs = Record<string, unknown>;

export interface BaselineState {
  entities: EntityRow[];
  edges: EdgeRow[];
  evidence: EvidenceRow[];
  conflicts: ConflictRow[];
  proposals: ProposalRow[];
  /** Goal revisions as GET .../revisions serves them: each month's `current`; absent in older saved data. */
  revisions?: Schemas["RevisionOut"][];
  /** Each applied change to one entity field, as entity_revisions would show it (#268). */
  fieldChanges?: FieldChange[];
  /** Goals' dated values (B5), as GET .../measurements serves them; absent in older saved data. */
  measurements?: Schemas["MeasurementOut"][];
}

type FieldChange = { entity_id: string; field: string; before: unknown; after: unknown; at: string };

export type BaselineCaller = {
  userId: string;
  role: Role;
  /** The run that made a proposal, as ProposalOut.run names it; null when it is gone. */
  runOf?: (runId: string) => Schemas["ProposalRun"] | null;
  /** A member's email, for the proposer's name (B4); null when there is no such member. */
  memberEmail?: (userId: string) => string | null;
  /** An active member of this Oracle: a goal's owner must be one (B5). */
  isMember?: (userId: string) => boolean;
  /** One of the caller's own source items (./sources.ts), to cite as evidence; null when it is not theirs. */
  sourceItem?: (itemId: string) => CitedItem | null;
  /** A hidden decision's baseline entity (docs/visibility): absent from the caller's entity list and reads. */
  hidden?: (entityId: string) => boolean;
};

/** What citing a source item copies from it. */
export type CitedItem = {
  id: string;
  source_id: string;
  source_kind: string;
  kind: string;
  title: string | null;
  url: string | null;
  content: string;
  fetched_at: string;
};

/** The accepted intake constraint the seed keeps as a suggested blocker (B4). */
export const SUGGESTED_BLOCKER = {
  id: "a4000000-0000-4000-8000-000000000010",
  key: "saved-addresses-third-party-policy-4f2a1c",
  title: "The carrier's terms forbid keeping a buyer's address for more than 30 days",
} as const;

/** Below this every piece of a feature's evidence counts as weak (confidence DEFAULTS.low). */
export const LOW_CONFIDENCE = 0.4;
const WEIGHTS = { source: 0.35, freshness: 0.25, mentions: 0.2, goal_impact: 0.2 } as const;
const ROLE_ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];
/** The commenter's seeded proposal on Team invites; the mock server makes it the commenter's. */
export const COMMENTER_PROPOSAL = "b3000000-0000-4000-8000-000000000001";
// A colleague who locked an item before you signed in.
const OTHER_MEMBER = "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7";
/** The Baseline to PRD run (./runs.ts) whose agents made the seeded proposals. */
export const AGENT_RUN = "0b7e5d4c-3a29-4118-9f07-e6d5c4b3a291";

/** GET /v1/baseline/review-status (C4, B1 "Reuse base"): whether a PRD run may reuse the baseline. */
export type ReviewStatus = Schemas["ReviewStatusOut"];

/** The scenario whose last baseline review is too old to reuse (approved 41 days ago). */
export const BASELINE_STALE_SCENARIO = "baseline-stale";
const REVIEW_CHECKPOINT = "0b7e5d4c-3a29-4118-9f07-e6d5c4b3a2c1";

/**
 * The mock's last baseline review: approved 9 days ago and reusable, or 41 days ago (too old)
 * in the "baseline-stale" scenario. The baseline segment costs its roles at each depth, as
 * the runs mock prices it (researcher $4 + analyst $3 at standard).
 */
export function baselineReviewStatus(now: Date = new Date()): ReviewStatus {
  // qa-onboarding-5: a new company (the "empty" scenario) has never approved a baseline.
  if (typeof localStorage !== "undefined" && localStorage.getItem(MOCK_SCENARIO_KEY) === "empty") {
    return {
      last_approved_at: null,
      checkpoint_id: null,
      run_id: null,
      age_days: null,
      build_under_way: false,
      reusable: false,
      reason: "never_reviewed",
      baseline_segment_usd: { quick: 3.5, standard: 7, deep: 14 },
    };
  }
  const stale = typeof localStorage !== "undefined" && localStorage.getItem(MOCK_SCENARIO_KEY) === BASELINE_STALE_SCENARIO;
  const age = stale ? 41 : 9;
  const at = new Date(now.getTime() - age * 86_400_000);
  at.setUTCHours(16, 40, 0, 0);
  return {
    last_approved_at: at.toISOString(),
    checkpoint_id: REVIEW_CHECKPOINT,
    run_id: AGENT_RUN,
    age_days: age,
    build_under_way: false,
    reusable: !stale,
    reason: stale ? "too_old" : null,
    baseline_segment_usd: { quick: 3.5, standard: 7, deep: 14 },
  };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const now = () => new Date().toISOString();

let counter = 0;
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  counter += 1;
  return `00000000-0000-4000-9000-${String(Date.now() + counter).padStart(12, "0").slice(-12)}`;
}

// ---------------------------------------------------------------- seed

export type Factors = { source: number; freshness: number; mentions: number; goal_impact: number };

export function scored(f: Factors, latestAt: string) {
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
  const s: BaselineState = { entities: [], edges: [], evidence: [], conflicts: [], proposals: [], revisions: [], measurements: [] };
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
  const edge = (src: EntityRow, type: EdgeRow["type"], dst: EntityRow, attrs: Attrs = {}, status: EdgeRow["status"] = "confirmed") => {
    const row: EdgeRow = {
      id: uuid(),
      src_id: src.id,
      dst_id: dst.id,
      type,
      attrs,
      status,
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
    e: {
      url: string;
      ref: string;
      excerpt: string;
      retrieved_at: string;
      private?: boolean;
      itemTitle?: string;
      removed?: boolean;
      /** An item of the mock's own sources (./sources.ts), so its coverage counts this use. */
      item?: { id: string; source_id: string };
    },
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
            id: e.item?.id ?? uuid(),
            source_id: e.item?.source_id ?? uuid(),
            source_kind: source_kind.split(":")[0],
            kind: source_kind.split(":")[1] ?? "message",
            title: e.itemTitle ?? e.ref,
            url: e.url,
          },
      source_item_private: !!e.private,
      source_removed: !!e.removed,
      ...scored(f, e.retrieved_at),
      created_at: e.retrieved_at,
    };
    s.evidence.push(row);
    return row;
  };

  // Goals: two confirmed, one still proposed (and served by nothing yet). B5: activation is
  // typed and owned (by the approver, see attributeGoalOwner), paid conversion typed without
  // an owner, early churn still on text, so it is Not measurable and offers Fill from text.
  const activation = entity("goal", "g.activation", "Raise activation", {
    body: "More new accounts reach their first successful order in the first week.",
    attrs: {
      weight: 0.5, metric: "Accounts that finish setup within 7 days", unit: "%", comparison: "at_least", target: 45, start: 31,
      current: 38, current_as_of: "2026-10-01", horizon: "short", due: "2026-12-31",
    },
    confidence: 0.78,
  });
  const paid = entity("goal", "g.paid-conversion", "Grow paid conversion", {
    body: "More trial accounts move to a paid plan.",
    attrs: {
      weight: 0.3, metric: "Trial to paid rate", unit: "%", comparison: "at_least", target: 12, current: 9.4,
      current_as_of: "2026-10-01", horizon: "medium", due: "2027-06-30",
    },
    confidence: 0.66,
  });
  entity("goal", "g.early-churn", "Cut early churn", {
    body: "Fewer accounts leave in their first three months.",
    attrs: { weight: 0.2, metric: "Accounts lost in the first 90 days", target_text: "below 8%" },
    status: "proposed",
    confidence: 0.45,
  });
  // Activation's value on the first of each month, as people recorded it.
  [31, 33, 32, 35, 34, 36, 38].forEach((value, i) => {
    const measured_on = `2026-${String(4 + i).padStart(2, "0")}-01`;
    s.measurements!.push({ id: uuid(), entity_id: activation.id, value, measured_on, note: i === 6 ? "October export" : null, evidence_id: null, recorded_by: null, created_at: `${measured_on}T09:00:00Z` });
  });
  // Each goal's metric, read monthly: the revisions that set `current`, as the API records them.
  const history = (goal: EntityRow, values: number[]) => {
    values.forEach((current, i) => {
      const at = new Date(Date.UTC(2026, 10 - values.length + i, 12, 9)).toISOString();
      const attrs = { ...goal.attrs, current };
      const before = i === 0 ? null : { type: goal.type, key: goal.key, title: goal.title, body: goal.body, attrs: { ...goal.attrs, current: values[i - 1] }, status: goal.status };
      s.revisions!.push({
        id: uuid(),
        entity_id: goal.id,
        edge_id: null,
        before,
        after: { type: goal.type, key: goal.key, title: goal.title, body: goal.body, attrs, status: goal.status },
        actor: "import",
        reason: "Monthly metric import",
        created_at: at,
      });
    });
  };
  history(activation, [31, 33, 32, 35, 34, 36, 38]);
  history(paid, [11.2, 10.8, 10.5, 10.1, 9.9, 9.6, 9.4]);

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
    attrs: { status: "planned", effort: "L", milestone: "Beta" },
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
    // Narrowed out of its source since (S5): cited as 'source removed'.
    removed: true,
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
    item: { id: seededItemId(PRODUCT_CHAT_ID, "m1"), source_id: PRODUCT_CHAT_ID },
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
    item: { id: seededItemId(PRODUCT_CHAT_ID, "m2"), source_id: PRODUCT_CHAT_ID },
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
  // And one from a commenter: no run. A fixed id, so the ids seeded after it stay put.
  s.proposals.push({
    id: COMMENTER_PROPOSAL,
    entity_id: invites.id,
    edge_id: null,
    payload: { op: "update", kind: "entity", fields: { attrs: { effort: "XS" } }, reason: "Most of the invite flow already exists.", origin: "agent" },
    run_id: null,
    actor: `user:${OTHER_MEMBER}`,
    status: "open",
    decided_by: null,
    decided_at: null,
    created_at: "2026-10-15T15:00:00Z",
  });

  // The Quillfield deposits blocker (./blockers.ts) is a baseline constraint, opened from Publish.
  entity("constraint", "c.same-day-refund", "Same-day refund rule unanswered", {
    body: "The card processor may not refund a deposit on the day it was taken.",
    confidence: 0.6,
  }).id = DEPOSITS_IDS.blocker;

  // An intake answer that revealed a blocker: its constraint, accepted by an approver, is
  // still a "suggested blocker" (B4) until someone promotes it.
  const carrier = entity("constraint", SUGGESTED_BLOCKER.key, SUGGESTED_BLOCKER.title, {
    body: `Which third-party rules or policies limit this?\n\n${SUGGESTED_BLOCKER.title}.`,
    attrs: {
      intake_id: "a4000000-0000-4000-8000-000000000001",
      gap_id: "a4000000-0000-4000-8000-000000000002",
      answer_id: "a4000000-0000-4000-8000-000000000003",
      proposed_blocker: { type: "unknown", limit_kind: "policy", severity: "high", status: "open" },
    },
    confidence: 0.62,
  });
  carrier.id = SUGGESTED_BLOCKER.id;
  cite(carrier, "notion:page", { source: 0.8, freshness: 0.7, mentions: 0.4, goal_impact: 0.3 }, {
    url: "https://www.notion.so/example/Carrier-terms-0000000001",
    ref: "Carrier terms summary",
    excerpt: "Stored delivery addresses must be deleted within 30 days of the last order.",
    retrieved_at: "2026-10-18T10:00:00Z",
    itemTitle: "Carrier terms summary",
  });
  // A link an agent proposed (#338): the drawer confirms it.
  edge(carts, "depends_on", invites, {}, "proposed");

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

type Changes = {
  title?: string | null;
  body?: string | null;
  attrs?: Attrs | null;
  status?: EntityRow["status"] | null;
  /** #345: a subgoal's parent goal; null promotes it. */
  parent_id?: string | null;
};

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
  if ("parent_id" in changes && (changes.parent_id ?? null) !== (e.parent_id ?? null)) out.parent_id = changes.parent_id ?? null;
  return out;
}

/** #345: as service.check_parent: a goal under a goal that is no subgoal, no cycle, one level. */
function parentRefusal(s: BaselineState, type: string, parentId: string | null | undefined, e?: EntityRow): string | null {
  if (!parentId) return null;
  if (type !== "goal") return "only a goal has a parent goal";
  if (e && parentId === e.id) return "a goal cannot be its own parent (a cycle)";
  const parent = s.entities.find((x) => x.id === parentId);
  if (!parent || parent.type !== "goal") return "the parent must be a goal";
  if (parent.status === "rejected") return "the parent goal is archived";
  if (e && parent.parent_id === e.id) return "the parent is a subgoal of this goal (a cycle)";
  if (parent.parent_id) return "the parent is a subgoal itself; subgoals are one level deep";
  if (e && s.entities.some((x) => x.parent_id === e.id)) return "a goal with subgoals cannot become a subgoal";
  return null;
}

const typedNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** #345: a goal's own progress, 0-1 (oracle.baseline.rollup.own_progress). */
function ownProgress(a: Attrs): number | null {
  const current = typedNum(a.current);
  const target = typedNum(a.target);
  const start = typedNum(a.start);
  const up = a.comparison === "at_least" || a.comparison === "above";
  const down = a.comparison === "at_most" || a.comparison === "below";
  if (current == null || target == null || (!up && !down)) return null;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (start != null && start !== target) return clamp((current - start) / (target - start));
  if (up) return current >= target ? 1 : target > 0 ? clamp(current / target) : 0;
  if (current <= target) return 1;
  return current > 0 ? clamp(target / current) : 0;
}

/** #345: own measurement first, else the subgoals' progress weighted by their weight (rollup.rollup). */
function progressOf(s: BaselineState, g: EntityRow): Schemas["GoalProgress"] {
  const live = s.entities.filter((x) => x.parent_id === g.id && x.type === "goal" && x.status !== "rejected");
  const own = ownProgress(g.attrs);
  if (own != null) return { value: own, source: "own", subgoals: live.length };
  let total = 0;
  let weights = 0;
  for (const x of live) {
    const p = ownProgress(x.attrs);
    if (p == null) continue;
    const w = typedNum(x.attrs.weight);
    const weight = w != null && w > 0 ? w : 1;
    total += weight * p;
    weights += weight;
  }
  if (!weights) return { value: null, source: null, subgoals: live.length };
  return { value: total / weights, source: "subgoals", subgoals: live.length };
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
  const before = entitySnapshot(e);
  const flatBefore = flatOf(e);
  Object.assign(e, diff, { updated_at: now() });
  const after = flatOf(e);
  for (const field of new Set([...Object.keys(flatBefore), ...Object.keys(after)])) {
    if (!same(flatBefore[field] ?? null, after[field] ?? null)) {
      (s.fieldChanges ??= []).push({ entity_id: e.id, field, before: flatBefore[field] ?? null, after: after[field] ?? null, at: now() });
    }
  }
  if (writer.origin === "user") lock(e, writer.userId);
  // A revision for the change, as service._revision records it.
  (s.revisions ??= []).push({
    id: newId(),
    entity_id: e.id,
    edge_id: null,
    before,
    after: entitySnapshot(e),
    actor: writer.runId ? `run:${writer.runId}` : `user:${writer.userId}`,
    reason: writer.reason ?? null,
    created_at: e.updated_at,
  });
  return null;
}

/** F4: Approve at the Engineering check sets a feature's effort, as the deciding person's edit (locked). */
export function setEntityEffort(s: BaselineState, key: string, size: string, userId: string, runId: string) {
  const e = s.entities.find((x) => x.type === "feature" && x.key === key);
  const effort = size.toUpperCase();
  if (!e || String(e.attrs?.effort ?? "").toUpperCase() === effort) return;
  updateEntity(s, e, { attrs: { effort } }, { origin: "user", userId, reason: `Engineering check of run ${runId}` });
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A person's new entity, as service.create_entity: confirmed and locked, a goal proposed (B2). */
function createEntity(s: BaselineState, input: Schemas["EntityCreate"], userId: string): EntityRow {
  if (!input.title?.trim()) throw new MockError(422, "title must not be empty");
  if (!input.key || input.key.length > 120 || !KEY_RE.test(input.key)) throw new MockError(422, "key: lowercase letters, digits, . _ -");
  if (s.entities.some((e) => e.type === input.type && e.key === input.key)) throw new MockError(409, `${input.type}:${input.key} already exists`);
  if (input.type === "goal" && input.status === "confirmed") {
    throw new MockError(422, "goals start proposed; confirm them with POST .../confirm");
  }
  const refusal = parentRefusal(s, input.type, input.parent_id);
  if (refusal) throw new MockError(422, refusal);
  const at = now();
  const e: EntityRow = {
    id: newId(),
    type: input.type,
    key: input.key,
    title: input.title,
    body: input.body ?? null,
    attrs: { ...(input.attrs ?? {}) },
    status: input.status ?? (input.type === "goal" ? "proposed" : "confirmed"),
    origin: "user",
    locked: false,
    locked_by: null,
    locked_at: null,
    confidence: null,
    run_id: null,
    parent_id: input.parent_id ?? null,
    created_at: at,
    updated_at: at,
  };
  lock(e, userId);
  s.entities.push(e);
  (s.revisions ??= []).push({
    id: newId(),
    entity_id: e.id,
    edge_id: null,
    before: null,
    after: entitySnapshot(e),
    actor: `user:${userId}`,
    reason: input.reason ?? null,
    created_at: at,
  });
  return e;
}

/** A decided decision's locked baseline entity d-<n> (the API's decision sync); returns its id. */
export function addDecisionEntity(s: BaselineState, d: { number: number; title: string; rationale?: string | null }, userId: string): string {
  const e = createEntity(s, { type: "decision", key: `d-${d.number}`, title: d.title, body: d.rationale ?? null, status: "confirmed" } as Schemas["EntityCreate"], userId);
  return e.id;
}

/** A person's new link, as service.create_edge: both ends exist, a supports link carries its contribution 0-3. */
function createEdge(s: BaselineState, input: Schemas["EdgeCreate"], userId: string): EdgeRow {
  if (!s.entities.some((e) => e.id === input.src_id) || !s.entities.some((e) => e.id === input.dst_id)) {
    throw new MockError(404, "Entity not found");
  }
  const c = input.attrs?.contribution;
  if (input.type === "supports" && !(typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 3)) {
    throw new MockError(422, "a supports edge needs attrs.contribution, an integer 0-3");
  }
  if (s.edges.some((e) => e.src_id === input.src_id && e.dst_id === input.dst_id && e.type === input.type)) {
    throw new MockError(409, "That link already exists");
  }
  const at = now();
  const e: EdgeRow = {
    id: newId(),
    src_id: input.src_id,
    dst_id: input.dst_id,
    type: input.type,
    attrs: { ...(input.attrs ?? {}) },
    status: input.status ?? "confirmed",
    origin: "user",
    locked: false,
    locked_by: null,
    locked_at: null,
    confidence: null,
    run_id: null,
    created_at: at,
    updated_at: at,
  };
  lock(e, userId);
  s.edges.push(e);
  return e;
}

/** A person's change to a link, as service.update_edge: attrs merge, a supports link keeps a contribution 0-3, and it locks. */
function updateEdge(e: EdgeRow, input: Schemas["EdgePatch"], userId: string) {
  const attrs = input.attrs != null ? mergeAttrs(e.attrs, input.attrs) : e.attrs;
  const c = attrs.contribution;
  if (e.type === "supports" && !(typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 3)) {
    throw new MockError(422, "a supports edge needs attrs.contribution, an integer 0-3");
  }
  const status = input.status ?? e.status;
  if (same(attrs, e.attrs) && status === e.status) return;
  Object.assign(e, { attrs, status, updated_at: now() });
  lock(e, userId);
}

/** An entity's confidence from its evidence: independent support raises it (confidence.aggregate). */
function rescoreEntity(s: BaselineState, entityId: string | null | undefined) {
  const target = s.entities.find((e) => e.id === entityId);
  if (!target) return;
  const scores = s.evidence.filter((e) => e.entity_id === target.id).map((e) => e.confidence ?? 0);
  target.confidence = scores.length ? Math.round((1 - scores.reduce((p, c) => p * (1 - c), 1)) * 1000) / 1000 : null;
}

/** POST .../evidence: cite one of the caller's own source items (its url, title and an excerpt are copied), or a url / ref / excerpt. */
function attachEvidence(
  s: BaselineState,
  caller: BaselineCaller,
  input: Schemas["EvidenceCreate"],
  target: { entity_id: string } | { edge_id: string },
): EvidenceRow {
  const at = now();
  const entityId = "entity_id" in target ? target.entity_id : null;
  const edgeId = "edge_id" in target ? target.edge_id : null;
  let row: EvidenceRow;
  if (input.source_item_id) {
    const item = caller.sourceItem?.(input.source_item_id);
    if (!item) throw new MockError(404, "Source item not found");
    const supports = s.edges.some((e) => e.src_id === entityId && e.type === "supports");
    row = {
      id: newId(),
      entity_id: entityId,
      edge_id: edgeId,
      url: input.url ?? item.url,
      excerpt: input.excerpt ?? item.content.slice(0, 500),
      ref: input.ref ?? item.title,
      retrieved_at: input.retrieved_at ?? item.fetched_at,
      source_kind: `${item.source_kind}:${item.kind}`,
      source_item: { id: item.id, source_id: item.source_id, source_kind: item.source_kind, kind: item.kind, title: item.title, url: item.url },
      source_item_private: false,
      source_removed: false,
      ...scored({ source: 0.7, freshness: 0.8, mentions: 0.5, goal_impact: supports ? 0.85 : 0.5 }, item.fetched_at),
      created_at: at,
    };
  } else {
    if (!(input.url || input.excerpt || input.ref)) throw new MockError(422, "evidence needs a source item, or a url, ref or excerpt");
    row = {
      id: newId(),
      entity_id: entityId,
      edge_id: edgeId,
      url: input.url ?? null,
      excerpt: input.excerpt ?? null,
      ref: input.ref ?? null,
      retrieved_at: input.retrieved_at ?? at,
      source_kind: "manual",
      source_item: null,
      source_item_private: false,
      source_removed: false,
      ...scored({ source: 0.4, freshness: 1, mentions: 0.5, goal_impact: 0.5 }, at),
      created_at: at,
    };
  }
  s.evidence.push({ ...row, added_by: caller.userId });
  rescoreEntity(s, entityId);
  return row;
}

/** An entity's fields as "title", "body", "status" and "attrs.<key>". */
function flatOf(e: EntityRow): Record<string, unknown> {
  const attrs = Object.entries(e.attrs ?? {}).map(([k, v]) => [`attrs.${k}`, v]);
  return { title: e.title, body: e.body ?? null, status: e.status, ...Object.fromEntries(attrs) };
}

/** A proposal's changes as [key, value], keys as flatOf names them. */
function flatChanges(fields: Changes = {}): [string, unknown][] {
  return Object.entries(fields).flatMap(([k, v]): [string, unknown][] =>
    k === "attrs" && v && typeof v === "object" ? Object.entries(v).map(([ak, av]) => [`attrs.${ak}`, av]) : k === "id" ? [] : [[k, v]],
  );
}

/** As service.overlaps (#268): the fields an open update would change that changed since it was written. */
function overlapsOf(s: BaselineState, p: ProposalRow): Schemas["ProposalOverlap"][] {
  const payload = p.payload as { op?: string; fields?: Changes };
  const target = p.entity_id ? s.entities.find((e) => e.id === p.entity_id) : undefined;
  if (p.status !== "open" || payload.op !== "update" || !target) return [];
  const mine = (s.fieldChanges ?? []).filter((c) => c.entity_id === target.id && c.at > p.created_at);
  const current = flatOf(target);
  return flatChanges(payload.fields).flatMap(([field, proposed]) => {
    const changed = mine.filter((c) => c.field === field);
    const now_ = current[field] ?? null;
    if (changed.length === 0 || same(now_, changed[0].before) || same(now_, proposed)) return [];
    const last = changed[changed.length - 1];
    const byProposal = s.proposals.some(
      (a) =>
        a.status === "accepted" &&
        a.entity_id === target.id &&
        (a.decided_at ?? "") > p.created_at &&
        flatChanges((a.payload as { fields?: Changes }).fields).some(([k, v]) => k === field && same(v, last.after)),
    );
    return [{ field, current: now_, proposed, changed_at: last.at, by: byProposal ? "proposal" : "edit" }];
  });
}

/** `fields` without the skipped keys. */
function without(fields: Changes, keys: string[]): Changes {
  const out = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "attrs" && !keys.includes(k))) as Changes;
  const attrs = Object.entries(fields.attrs ?? {}).filter(([k]) => !keys.includes(`attrs.${k}`));
  if (attrs.length > 0) out.attrs = Object.fromEntries(attrs);
  return out;
}

/** service.entity_snapshot: what a revision keeps of an entity. */
function entitySnapshot(e: EntityRow): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.type, key: e.key, title: e.title, body: e.body ?? null, attrs: { ...e.attrs }, status: e.status };
  if (e.parent_id) out.parent_id = e.parent_id;
  return out;
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

/** EvidenceOut: who added it stays in the store, as in the API. */
function evidenceOut({ added_by, ...ev }: EvidenceRow): Schemas["EvidenceOut"] {
  void added_by;
  return ev;
}

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
  const isMember = caller.isMember ?? (() => true);
  // B5: a goal carries its goal_check (null for other types).
  const entityOut = (e: EntityRow) =>
    ({
      ...withCount(s, e, "entity_id"),
      goal_check: e.type === "goal" ? goalCheck(e.attrs, e.status, isMember) : null,
      parent_id: e.parent_id ?? null,
      progress: e.type === "goal" ? progressOf(s, e) : null,
    }) as Schemas["EntityOut"];
  /** 422 with every problem, as the API refuses a person's bad goal fields. */
  const refuse = (errors: GoalProblem[]) => json(422, { detail: `goal fields rejected: ${errors.length} problem(s)`, errors });
  const goalRefusal = (e: EntityRow, attrs: Attrs | null | undefined) =>
    e.type === "goal" && attrs ? refusedProblems(mergeAttrs(e.attrs, attrs), e.attrs, isMember) : [];
  const measurements = () => (s.measurements ??= []);
  /** The latest measurement by day becomes the goal's current, through a person's write (it locks). */
  const syncCurrent = (goal: EntityRow, reason: string) => {
    const latest = measurements()
      .filter((x) => x.entity_id === goal.id)
      .sort((a, b) => b.measured_on.localeCompare(a.measured_on))[0];
    const attrs = latest ? { current: latest.value, current_as_of: latest.measured_on } : { current: null, current_as_of: null };
    updateEntity(s, goal, { attrs }, { origin: "user", userId: caller.userId, reason });
  };
  const edgeOut = (e: EdgeRow) => withCount(s, e, "edge_id") as Schemas["EdgeOut"];
  const shown = (e: EntityRow) => !caller.hidden?.(e.id);
  const findEntity = (id: string) => s.entities.find((e) => e.id === id && shown(e));
  /** ProposalOut: the run that made it, its sentence (kept from the decision once decided) and who made it. */
  const proposalOut = (p: ProposalRow): Schemas["ProposalOut"] => {
    const run = p.run_id ? (caller.runOf?.(p.run_id) ?? null) : null;
    const stored = (p.payload as { summary?: unknown }).summary;
    return {
      ...p,
      run,
      summary: p.status !== "open" && typeof stored === "string" ? stored : describe(p, s.entities, s.edges),
      proposer: proposer(p, { run, memberEmail: caller.memberEmail }),
      overlaps: overlapsOf(s, p),
    };
  };

  // Public-link evidence is open to commenters, so it is routed before the approver check.
  const link = await routeEvidenceLinks(s, caller, req, rest);
  if (link) return link;

  // Removing evidence: approvers remove any; a commenter only link evidence they added (C2c).
  if (rest[0] === "evidence" && rest[1] && !rest[2] && m === "DELETE") {
    const ev = s.evidence.find((x) => x.id === rest[1]);
    if (!ev) return fail(404, "Evidence not found");
    const approver = ROLE_ORDER.indexOf(caller.role) >= ROLE_ORDER.indexOf("approver");
    if (!approver && !(ev.kind && ev.added_by === caller.userId)) {
      return fail(403, "Only approvers, or the person who added this link, can remove it.");
    }
    if ((q.get("reason") ?? "").length > 1000) return fail(422, "reason: at most 1000 characters");
    s.evidence = s.evidence.filter((x) => x.id !== ev.id);
    rescoreEntity(s, ev.entity_id);
    return new Response(null, { status: 204 });
  }

  if (m !== "GET" && ROLE_ORDER.indexOf(caller.role) < ROLE_ORDER.indexOf("approver")) {
    return fail(403, "Requires the approver role");
  }

  try {
    const [head, id, action] = rest;

    if (head === "review-status" && !id && m === "GET") return json(200, baselineReviewStatus());
    if (head === "graph" && m === "GET") {
      return json(200, { entities: s.entities.map(entityOut), edges: s.edges.map(edgeOut) });
    }
    if (head === "trace" && m === "GET") return json(200, traceReport(s));

    if (head === "entities" && !id && m === "GET") {
      const type = q.get("type");
      const status = q.get("status");
      return json(
        200,
        s.entities.filter((e) => shown(e) && (!type || e.type === type) && (!status || e.status === status)).map(entityOut),
      );
    }

    if (head === "entities" && !id && m === "POST") {
      const input = await body<Schemas["EntityCreate"]>();
      const e = createEntity(s, input, caller.userId);
      const out: Schemas["EntityWriteOut"] = { applied: true, entity: entityOut(e), proposal: null };
      return json(201, out);
    }
    if (head === "edges" && !id && m === "POST") {
      const input = await body<Schemas["EdgeCreate"]>();
      const e = createEdge(s, input, caller.userId);
      const out: Schemas["EdgeWriteOut"] = { applied: true, edge: edgeOut(e), proposal: null };
      return json(201, out);
    }

    if (head === "edges" && id) {
      const e = s.edges.find((x) => x.id === id);
      if (!e) return fail(404, "Edge not found");
      if (!action && m === "PATCH") {
        updateEdge(e, await body<Schemas["EdgePatch"]>(), caller.userId);
        const out: Schemas["EdgeWriteOut"] = { applied: true, edge: edgeOut(e), proposal: null };
        return json(200, out);
      }
      if (!action && m === "DELETE") {
        s.edges = s.edges.filter((x) => x.id !== e.id);
        s.evidence = s.evidence.filter((x) => x.edge_id !== e.id);
        return new Response(null, { status: 204 });
      }
      if (action === "unlock" && m === "POST") {
        Object.assign(e, { locked: false, locked_by: null, locked_at: null });
        return json(200, edgeOut(e));
      }
      if (action === "evidence" && m === "POST") {
        return json(201, evidenceOut(attachEvidence(s, caller, await body<Schemas["EvidenceCreate"]>(), { edge_id: e.id })));
      }
    }

    if (head === "entities" && id) {
      const e = findEntity(id);
      if (!e) return fail(404, "Entity not found");
      if (!action && m === "GET") {
        const detail: Schemas["EntityDetail"] = {
          ...entityOut(e),
          evidence: s.evidence.filter((ev) => ev.entity_id === e.id).map(evidenceOut),
          edges_out: s.edges.filter((x) => x.src_id === e.id).map(edgeOut),
          edges_in: s.edges.filter((x) => x.dst_id === e.id).map(edgeOut),
          open_proposals: s.proposals.filter((p) => p.status === "open" && p.entity_id === e.id).length,
        };
        return json(200, detail);
      }
      if (!action && m === "PATCH") {
        const input = await body<Schemas["EntityPatch"]>();
        const problems = (input.origin ?? "user") === "user" ? goalRefusal(e, input.attrs as Attrs | null) : [];
        if (problems.length) return refuse(problems);
        const moved = "parent_id" in input && (input.parent_id ?? null) !== (e.parent_id ?? null);
        const refusal = moved ? parentRefusal(s, e.type, input.parent_id, e) : null;
        if (refusal) return fail(422, refusal);
        const proposal = updateEntity(s, e, input as Changes, {
          origin: input.origin ?? "user",
          userId: caller.userId,
          reason: input.reason,
          runId: input.run_id,
        });
        const out: Schemas["EntityWriteOut"] = { applied: !proposal, entity: entityOut(e), proposal: proposal && proposalOut(proposal) };
        return json(proposal ? 202 : 200, out);
      }
      if ((action === "confirm" || action === "reject") && m === "POST") {
        const status = action === "confirm" ? "confirmed" : "rejected";
        const note = (await body<Schemas["ProposalDecision"] | null>())?.note;
        if (e.status !== status) {
          // As service.set_entity_status: a person's decision locks, with a revision and its reason.
          const before = entitySnapshot(e);
          e.status = status;
          e.updated_at = now();
          lock(e, caller.userId);
          (s.revisions ??= []).push({
            id: newId(),
            entity_id: e.id,
            edge_id: null,
            before,
            after: entitySnapshot(e),
            actor: `user:${caller.userId}`,
            reason: note || `${status} by user:${caller.userId}`,
            created_at: e.updated_at,
          });
        }
        return json(200, entityOut(e));
      }
      if (action === "merge" && m === "POST") {
        // B2 Merge into…: a duplicate the run created goes into an item of the same type.
        const input = await body<{ into: string; reason?: string | null }>();
        const into = findEntity(input.into);
        if (!into || into.id === e.id) return fail(404, "Entity not found");
        if (e.locked) return fail(409, "Locked: a person edited it");
        if (!e.run_id) return fail(409, "Only items this run created can be merged here");
        if (e.type !== into.type) return fail(409, "Only items of the same type can be merged");
        for (const ev of s.evidence) if (ev.entity_id === e.id) ev.entity_id = into.id;
        const has = (x: EdgeRow) => s.edges.some((y) => y !== x && y.src_id === x.src_id && y.dst_id === x.dst_id && y.type === x.type);
        for (const x of s.edges) {
          if (x.src_id === e.id) x.src_id = into.id;
          if (x.dst_id === e.id) x.dst_id = into.id;
        }
        s.edges = s.edges.filter((x, i) => !(has(x) && s.edges.findIndex((y) => y.src_id === x.src_id && y.dst_id === x.dst_id && y.type === x.type) !== i));
        for (const p of s.proposals) {
          if (p.entity_id === e.id && p.status === "open") {
            Object.assign(p, { status: "rejected", decided_by: caller.userId, decided_at: now(), payload: { ...p.payload, note: `Merged into ${into.title}` } });
          }
        }
        s.entities = s.entities.filter((x) => x !== e);
        into.updated_at = now();
        return json(200, entityOut(into));
      }
      if (action === "measurements" && m === "GET") {
        return json(200, measurements().filter((x) => x.entity_id === e.id).sort((a, b) => b.measured_on.localeCompare(a.measured_on)));
      }
      if (action === "measurements" && m === "POST") {
        const input = await body<Schemas["MeasurementCreate"]>();
        if (e.type !== "goal") return fail(422, "measurements are recorded on goals only");
        if (!unitOk(e.attrs.unit)) return fail(422, "give the goal its unit before recording a value");
        if (typeof input.value !== "number" || !Number.isFinite(input.value)) return fail(422, "The value is a number");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.measured_on ?? "")) return fail(422, "A date is written YYYY-MM-DD");
        if (input.measured_on > todayIso()) return fail(422, "a value cannot be measured in the future");
        if (e.attrs.unit === "%" && input.value < 0) return fail(422, "A percentage is 0 or more");
        let row = measurements().find((x) => x.entity_id === e.id && x.measured_on === input.measured_on);
        if (!row) {
          row = { id: newId(), entity_id: e.id, value: 0, measured_on: input.measured_on, note: null, evidence_id: null, recorded_by: null, created_at: now() };
          measurements().push(row);
        }
        Object.assign(row, { value: input.value, note: input.note ?? null, evidence_id: input.evidence_id ?? null, recorded_by: caller.userId });
        syncCurrent(e, `value ${input.value} measured on ${input.measured_on}`);
        return json(201, row);
      }
      if (action === "unlock" && m === "POST") {
        Object.assign(e, { locked: false, locked_by: null, locked_at: null });
        return json(200, entityOut(e));
      }
      if (action === "evidence" && m === "POST") {
        return json(201, evidenceOut(attachEvidence(s, caller, await body<Schemas["EvidenceCreate"]>(), { entity_id: e.id })));
      }
      if (action === "revisions" && m === "GET") {
        // Newest first, as the API lists them.
        const mine = (s.revisions ?? []).filter((r) => r.entity_id === e.id);
        const limit = q.get("limit");
        if (limit != null && !(Number(limit) >= 1 && Number(limit) <= 500)) return fail(422, "limit");
        const newest = [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at));
        return json(200, limit == null ? newest : newest.slice(0, Number(limit)));
      }
    }

    if (head === "proposals" && !id && m === "GET") {
      const status = q.get("status");
      const run = q.get("run_id");
      if (run != null && run !== "none" && !UUID_RE.test(run)) return fail(422, "run_id must be a run's id or none");
      return json(
        200,
        s.proposals
          .filter((p) => !status || p.status === status)
          .filter((p) => run == null || (run === "none" ? p.run_id == null : p.run_id === run))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map(proposalOut),
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
        // "milestone" means "attrs.milestone", as the API reads skip_fields.
        const keys = ((await body<Schemas["ProposalAccept"] | null>())?.skip_fields ?? []).map((f) =>
          ["title", "body", "status"].includes(f) || f.startsWith("attrs.") ? f : `attrs.${f}`,
        );
        const changes = flatChanges(payload.fields).map(([k]) => k);
        const unknown = keys.find((k) => !changes.includes(k));
        if (unknown) return fail(422, `this proposal does not change ${unknown}`);
        // Re-checked: a member named as owner may have left since (B5).
        const problems = goalRefusal(target, without(payload.fields ?? {}, keys).attrs);
        if (problems.length) return refuse(problems);
        p.payload = { ...p.payload, summary: describe(p, s.entities, s.edges), ...(keys.length ? { skipped_fields: keys } : {}) };
        updateEntity(s, target, without(payload.fields ?? {}, keys), { origin: "user", userId: caller.userId });
      }
      if (action === "reject") p.payload = { ...p.payload, summary: describe(p, s.entities, s.edges) };
      Object.assign(p, {
        status: action === "accept" ? "accepted" : "rejected",
        decided_by: caller.userId,
        decided_at: now(),
      });
      return json(200, proposalOut(p));
    }

    if (head === "measurements" && id && !action && m === "DELETE") {
      const row = measurements().find((x) => x.id === id);
      if (!row) return fail(404, "Measurement not found");
      const goal = findEntity(row.entity_id);
      s.measurements = measurements().filter((x) => x.id !== id);
      if (goal) syncCurrent(goal, `measurement of ${row.measured_on} deleted`);
      return new Response(null, { status: 204 });
    }
    if (head === "goals" && id === "fill-from-text" && !action && m === "POST") {
      // An Oracle (agent) write: applied to an unlocked goal, a proposal on a locked one.
      let applied = 0;
      let proposed = 0;
      const left: Schemas["FilledText"][] = [];
      const goals = s.entities.filter((e) => e.type === "goal" && e.status !== "rejected").sort((a, b) => a.key.localeCompare(b.key));
      for (const goal of goals) {
        const { values, left: unread } = readText(goal.attrs);
        for (const k of unread) if (goal.attrs[`${k}_text`] != null) left.push({ entity_id: goal.id, field: k, text: String(goal.attrs[`${k}_text`]) });
        if (Object.keys(values).length === 0) continue;
        const patch: Attrs = { ...values };
        for (const k of ["target", "start", "current", "horizon", "weight"]) if (k in values && `${k}_text` in goal.attrs) patch[`${k}_text`] = null;
        const proposal = updateEntity(s, goal, { attrs: patch }, { origin: "agent", userId: caller.userId, reason: "Fill from text" });
        if (proposal) proposed += 1;
        else applied += 1;
      }
      return json(200, { applied, proposed, left_as_text: left } satisfies Schemas["FillFromTextResult"]);
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

/**
 * The large-company scenario (po-mock-scenario=large): `extra` more goals after the seeded
 * ones, each with a current value and three monthly revisions, so Home is measured against
 * a company with many goals.
 */
export function enlargeBaseline(s: BaselineState, uuid: () => string, extra: number) {
  const model = s.entities.find((e) => e.type === "goal")!;
  for (let i = 1; i <= extra; i++) {
    const values = [100 + i, 110 + i, 120 + i].map(String);
    const attrs = { weight: 0.1 - i / 1000, metric: `Clinics live in region ${i}`, target: `${200 + i * 10} clinics`, current: values[2] };
    const goal: EntityRow = { ...model, id: uuid(), key: `g.region-${i}`, title: `Region ${String(i).padStart(2, "0")} clinics`, attrs, status: "confirmed" };
    s.entities.push(goal);
    values.forEach((current, n) => {
      const after = { type: goal.type, key: goal.key, title: goal.title, body: goal.body, attrs: { ...attrs, current }, status: goal.status };
      s.revisions!.push({
        id: uuid(),
        entity_id: goal.id,
        edge_id: null,
        before: null,
        after,
        actor: "import",
        reason: "Monthly metric import",
        created_at: new Date(Date.UTC(2026, 7 + n, 12, 9)).toISOString(),
      });
    });
  }
}

/**
 * The "proposal-noise" scenario (#262): run proposals that repeat unchanged fields, as agents
 * write them. One changes four of six fields, one rewords a long description, one changes
 * nothing at all.
 */
export function addNoisyProposals(s: BaselineState, uuid: () => string) {
  const goal = (key: string) => s.entities.find((e) => e.key === key)!;
  const propose = (target: EntityRow, fields: Attrs, created_at: string) =>
    s.proposals.push({
      id: uuid(),
      entity_id: target.id,
      edge_id: null,
      payload: { op: "update", kind: "entity", fields, reason: "Restated from the planning notes.", origin: "agent" },
      run_id: AGENT_RUN,
      actor: `run:${AGENT_RUN}`,
      status: "open",
      decided_by: null,
      decided_at: null,
      created_at,
    });
  const churn = goal("g.early-churn");
  propose(
    churn,
    { title: churn.title, body: churn.body, attrs: { ...churn.attrs, weight: 0.25, target_text: "below 7%", horizon_text: "2026-Q4", current_text: "10%" } },
    "2026-10-16T08:20:00Z",
  );
  const activation = goal("g.activation");
  propose(
    activation,
    { title: activation.title, body: "More new accounts reach their first successful order in the first two weeks.", attrs: { ...activation.attrs, target: 50 } },
    "2026-10-16T08:21:00Z",
  );
  const paid = goal("g.paid-conversion");
  propose(paid, { title: paid.title, attrs: { target: paid.attrs.target } }, "2026-10-16T08:22:00Z");
}

/**
 * The "proposal-overlap" scenario (#268): two run proposals on Saved carts that both set its
 * milestone, written before either was accepted.
 */
export function addOverlappingProposals(s: BaselineState, uuid: () => string) {
  const carts = s.entities.find((e) => e.key === "f.saved-carts")!;
  const propose = (fields: Attrs, reason: string, created_at: string) =>
    s.proposals.push({
      id: uuid(),
      entity_id: carts.id,
      edge_id: null,
      payload: { op: "update", kind: "entity", fields, reason, origin: "agent" },
      run_id: AGENT_RUN,
      actor: `run:${AGENT_RUN}`,
      status: "open",
      decided_by: null,
      decided_at: null,
      created_at,
    });
  propose({ attrs: { milestone: "M2" } }, "Slice a ships in M2.", "2026-10-16T08:30:00Z");
  propose({ attrs: { milestone: "Below the line", effort: "XL" } }, "Moved below the line after sizing.", "2026-10-16T08:31:00Z");
}

/**
 * The "proposal-overlap-status" scenario (review minor #3): two run proposals on Team
 * invites that both set its delivery status, written before either was accepted - the
 * overlap warning must name the field fully ("delivery status"), not bare "status".
 */
export function addStatusOverlapProposals(s: BaselineState, uuid: () => string) {
  const invites = s.entities.find((e) => e.key === "f.team-invites")!;
  const propose = (fields: Attrs, reason: string, created_at: string) =>
    s.proposals.push({
      id: uuid(),
      entity_id: invites.id,
      edge_id: null,
      payload: { op: "update", kind: "entity", fields, reason, origin: "agent" },
      run_id: AGENT_RUN,
      actor: `run:${AGENT_RUN}`,
      status: "open",
      decided_by: null,
      decided_at: null,
      created_at,
    });
  propose({ attrs: { status: "in_progress" } }, "Work started on the invite flow.", "2026-10-16T08:30:00Z");
  propose({ attrs: { status: "planned" } }, "Rescoped for next sprint.", "2026-10-16T08:31:00Z");
}

/**
 * The "conflict-3way" scenario (review minor, #2): Dark mode's delivery status has three
 * competing claims, all within the tie margin of each other. The winner (code) and the
 * true runner-up (tracker) share the same precedence tiebreak the rule names; a third
 * claim (chat) has higher raw confidence than the runner-up but a weaker source, so
 * naming "the best other claim by confidence" instead of the one the rule actually
 * ranked second would point at the wrong claim.
 */
export function addThreeWayConflict(s: BaselineState, uuid: () => string) {
  const dark = s.entities.find((e) => e.key === "f.dark-mode")!;
  s.conflicts.push({
    id: uuid(),
    entity_id: dark.id,
    edge_id: null,
    field: "attrs.status",
    claims: [
      {
        value: "in_progress",
        evidence_ids: [],
        source_kind: "github:pull_request",
        source_class: "code",
        observed_at: "2026-10-18T11:00:00Z",
        confidence: 0.52,
      },
      {
        value: "idea",
        evidence_ids: [],
        source_kind: "slack",
        source_class: "chat",
        observed_at: "2026-10-17T09:00:00Z",
        confidence: 0.55,
      },
      {
        value: "planned",
        evidence_ids: [],
        source_kind: "linear",
        source_class: "tracker",
        observed_at: "2026-10-16T09:00:00Z",
        confidence: 0.5,
      },
    ],
    resolution: {
      rule: "confidence tie (0.52 vs 0.50); code beats tracker",
      decided_by: "precedence",
      current: "idea",
      winner: 0,
      value: "in_progress",
      applied: false,
    },
    material: true,
    status: "open",
    created_at: "2026-10-18T07:30:00Z",
  });
}

/** Makes the seeded activation goal owned by the given member (the mock's members get their ids after the seed). */
export function attributeGoalOwner(s: BaselineState, userId: string) {
  const g = s.entities.find((e) => e.key === "g.activation");
  if (g) g.attrs = { ...g.attrs, owner: userId };
}

/** The colleague who locked the seeded items is a member (the mock's members get their ids after the seed). */
export function attributeLocks(s: BaselineState, userId: string) {
  for (const e of s.entities) if (e.locked_by === OTHER_MEMBER) e.locked_by = userId;
}

/**
 * The "goal-words" scenario (#505): Raise activation as the walk of 2026-10-23 found it, locked
 * by a colleague, with the attributes a goals run leaves (the words as written and how sure it
 * is of the owner) and the revision that raised that confidence.
 */
export function addGoalWords(s: BaselineState, lockerId: string) {
  const g = s.entities.find((e) => e.key === "g.activation")!;
  const before = { type: g.type, key: g.key, title: g.title, body: g.body, attrs: { ...g.attrs, owner_confidence: 0.425 }, status: g.status };
  Object.assign(g, {
    locked: true,
    locked_by: lockerId,
    locked_at: "2026-10-21T10:05:00Z",
    attrs: { ...g.attrs, owner_text: "Growth lead", target_text: "45% by the end of the year", horizon_text: "this year", owner_confidence: 1 },
    updated_at: "2026-10-21T10:05:00Z",
  });
  (s.revisions ??= []).push({
    id: "b5050000-0000-4000-8000-000000000001",
    entity_id: g.id,
    edge_id: null,
    before,
    after: { type: g.type, key: g.key, title: g.title, body: g.body, attrs: { ...g.attrs }, status: g.status },
    actor: `user:${lockerId}`,
    reason: null,
    created_at: "2026-10-21T10:05:00Z",
  });
}

/** Makes the seeded commenter proposal the given member's (the mock's members get their ids after the seed). */
export function attributeCommenterProposal(s: BaselineState, userId: string) {
  const p = s.proposals.find((x) => x.id === COMMENTER_PROPOSAL);
  if (p) p.actor = `user:${userId}`;
}

/**
 * The "named-codes" scenario (#304): the company writes its own code before each goal's
 * name ("G-B Growth"), the way it numbers goals in its plans. One name is long, so narrow
 * cells cut it. Growth has no current value yet, so it has no distance to go.
 */
export function addGoalCodes(s: BaselineState) {
  const titles: Record<string, string> = {
    "g.activation": "G-A Activation",
    "g.paid-conversion": "G-B Growth",
    "g.early-churn": "G-C Fewer accounts leaving in their first ninety days",
  };
  for (const e of s.entities) if (e.type === "goal" && titles[e.key]) e.title = titles[e.key];
  const growth = s.entities.find((e) => e.key === "g.paid-conversion");
  if (growth) delete growth.attrs.current;
}
