/**
 * Mock of the runs API (flows, runs, checkpoints, tick, inbox) for NEXT_PUBLIC_API_MOCKS=1.
 * Mirrors api/oracle/runs: the same flows, cost table, $50 approval gate and 1.5x
 * overrun pause. Agents "finish" a segment on POST /v1/internal/tick, at 90% of its
 * estimate, as the API's FakeRuntime does.
 */
import type { Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";

import { AGENT_RUN, baselineReviewStatus } from "./baseline";
import { companyDayInWords, companyDayIso, companyStamp } from "./connections";
import { ranking } from "./lane-f";
import type { RowTally } from "./from-run";
import { fileItems } from "./checkpoint-review";
import { readableRefusal } from "./refusal";
import { mockNowMs } from "./clock";
import { applySuggestion, latestScope, prepareScope, recheck as recheckScope, routeScopes, SCOPE_EDIT_FIELDS, scopeEdits, scopeSendBack, type StoredScope } from "./scope";

type RunOut = Schemas["RunOut"];
type SegmentOut = Schemas["SegmentOut"];
type CheckpointOut = Schemas["CheckpointOut"];
type FeatureSetCheck = Schemas["FeatureSetCheck"];
type PrdScopeOut = Schemas["PrdScopeOut"];
type PriorityCheck = Schemas["PriorityCheck"];
type SnapshotRow = Schemas["PrioritySnapshotOut"];
type Method = Schemas["PriorityRanking"]["method"];
type RunDecision = Schemas["RunDecision"];
type FeedbackRow = Omit<Schemas["FeedbackItemOut"], "state" | "staged_for_version" | "staged_for_agents"> & {
  /** D12: staged for the agents (when, by whom); open items only count. */
  staged_for_agents_at?: string | null;
  staged_for_agents_by?: string | null;
};
type DocumentRow = Pick<Schemas["DocumentSummary"], "id" | "slug" | "title" | "kind" | "template" | "theme">;
type VersionSource = Schemas["VersionSource"];
type Kind = DocumentRow["kind"];

/** D8: one stored action of a checkpoint's shared draft (people by member id). */
type DraftActionRow = Omit<Schemas["ReviewAction"], "created_by" | "updated_by" | "question"> & {
  created_by: string | null;
  updated_by: string | null;
  /** G4: staged from a discussion (row actions have none), and whether it was private then. */
  origin?: "row" | "discussion";
  discussion_id?: string | null;
  discussion_change_id?: string | null;
  from_private?: boolean;
  /** C2: a question action's question, asked through the questions store (the member's Inbox). */
  question_id?: string | null;
};
/** D8: a checkpoint's shared draft; `log` says who made each revision (the 409's names). */
export interface DraftRow {
  revision: number;
  note: string | null;
  actions: DraftActionRow[];
  log: { revision: number; by: string }[];
}

export interface RunsDb {
  runs: RunOut[];
  /** `${runId}|${seq}|${name}` -> content; a send-back's previous attempt: `${runId}|${seq}|${name}|${attempt}` */
  artifacts: Record<string, string>;
  /** C6: run id -> its PRD scopes, oldest first (a mock db saved before C6 has none). */
  scopes?: Record<string, PrdScopeOut[]>;
  /** B1: when a Build the baseline run older than the seeded runs finished (the default company built one). */
  baseline_built_at?: string | null;
  /** C8: the runs' priority orders as snapshots (proposed, saved or discarded), oldest first. */
  priority_snapshots?: SnapshotRow[];
  /** D8: checkpoint id -> its shared draft (absent until someone writes it). */
  drafts?: Record<string, DraftRow>;
}

/** B2: what the baseline says of a run at Confirm the baseline (./from-run.ts, over the baseline mock). */
export interface BaselineReviewOf {
  /** The approve gate's reasons: each goal from the run still proposed (goal_undecided). */
  goals: GateReason[];
  /** The Inbox row's counts (D9's summary). */
  summary: RowTally;
  /** item key -> title, for the send-back note. */
  titles: Record<string, string>;
}

/** B1's Set up step: when the last Build the baseline run finished, or null when none succeeded. */
export function lastBaselineBuild(db: RunsDb | undefined): string | null {
  if (!db) return null;
  const done = db.runs.filter((r) => r.flow === "baseline" && r.status === "succeeded").map((r) => r.finished_at ?? r.created_at);
  return done.sort().pop() ?? db.baseline_built_at ?? null;
}

/** The last Build the baseline run that succeeded, the latest created (as rebuild.block reads it), or null. */
export function lastBaselineRun(db: RunsDb | undefined): { id: string; created_at: string } | null {
  const done = (db?.runs ?? []).filter((r) => r.flow === "baseline" && r.status === "succeeded");
  return done.sort((a, b) => a.created_at.localeCompare(b.created_at)).pop() ?? null;
}

export interface RunsContext {
  db: RunsDb;
  userId: string;
  /** The signed-in member's email: who decided, on a decision not delivered yet. */
  userName?: string | null;
  /** The signed-in member's role: who decided, as the run's agents read it (D11). */
  userRole?: Schemas["Me"]["role"] | null;
  /** D8: the signed-in member (who stages or suggests), and every member by id (names). */
  member?: { id: string; email: string; role: Schemas["Me"]["role"] } | null;
  members?: { id: string; email: string; role: Schemas["Me"]["role"] }[];
  /**
   * D8: a test's "another reviewer changed the draft" (MOCK_REVIEW_CHANGE_KEY): the email of
   * who changed it, read once (the key is cleared). The next decide bumps the draft by one
   * change of theirs before it checks the revision.
   */
  reviewChange?: () => string | null;
  /**
   * C2, as oracle.runs.actions._ask: a question action asks the member through the questions
   * store (their Inbox's row) and returns the question's id; `asked` reads it back (its status
   * and answer); `withdraw` withdraws it while nobody answered. Absent: the action holds it.
   */
  ask?: (q: { asked_to: string; prompt: string; checkpoint_id: string; item_ref: string }) => string;
  asked?: (id: string) => { status: string; answer: string | null } | null;
  withdraw?: (id: string) => void;
  /**
   * A3: whether the signed-in member may decide a checkpoint of a run of `flow`, as the API's
   * oracle.members.leads.may_decide (the engineering stops go to the leads and owners once
   * one is named). Absent: anyone may, as the mock had it.
   */
  mayDecide?: (c: Pick<CheckpointOut, "kind" | "approver_role">, flow: RunOut["flow"]) => boolean;
  /** As oracle.members.leads.lead_stop: an engineering stop outside prd_to_spec once a lead is named. */
  leadStop?: (c: Pick<CheckpointOut, "kind">, flow: RunOut["flow"]) => boolean;
  /** F4: Approve at the Engineering check sets a feature's effort (a person's edit, locked). */
  setEffort?: (featureKey: string, size: string, runId: string) => void;
  /** B2: the baseline's rows of a run under its shared draft's actions (absent: no goals rule). */
  baselineReview?: (runId: string, actions: DraftActionRow[]) => BaselineReviewOf;
  /** D10: the designated decider of the document a run review reviews (its review policy), if any. */
  reviewDecider?: (c: CheckpointOut) => string | null;
  /** H11 (oracle.autonomy_drafts): why a run may not draft a document of this kind, at Observe. */
  draftRefusal?: (flow: RunOut["flow"], kind: string | null | undefined) => string | null;
  /**
   * The "undelivered" scenario: SwarmCloud does not take a checkpoint decision until the
   * next tick. The decision is recorded (and final) but the decide call answers 503, as the
   * API does when SwarmCloud did not confirm it; the tick delivers it.
   */
  undelivered?: boolean;
  /**
   * #258 The "slow-agents" scenario: a segment's agents take two ticks. The first reads them
   * working (each role's agent, its heartbeat and a third of the estimate spent so far); the
   * second finishes the segment.
   */
  slowAgents?: boolean;
  /**
   * H11 Order priorities, as oracle.autonomy for the runs: its level, its limits, and the
   * "Oracle did" row Oracle leaves when it saves a run's order itself (_tell_order_saved).
   * Absent: Oracle never saves an order at a stop that is on.
   */
  autonomy?: {
    level: () => "observe" | "draft" | "recommend" | "act";
    limits: () => { max_rank_move?: number } | null;
    acted: (a: { summary: string; subject: Record<string, unknown>; undo: null; notify: string[] }) => void;
  };
  feedback: FeedbackRow[];
  documents: DocumentRow[];
  /** #260: the confirmed goals a Baseline to PRD run may name. */
  confirmedGoals?: () => Schemas["TargetGoal"][];
  latestVersion: (documentId: string) => number | null;
  /** The status of Oracle's live suggestion on a feedback item, if it has one. */
  suggestionStatus?: (feedbackId: string) => Schemas["SuggestionOut"]["status"] | null;
  /** C1e: the item's accepted suggestion is staged for the next draft (not open feedback). */
  staged?: (feedbackId: string) => boolean;
  /** D10: the staged suggestion's text a send-back carries as accepted_text. */
  stagedText?: (feedbackId: string) => string | null;
  /** D10: a version's locked sections (approved), in the send-back's locked_sections. */
  lockedSections?: (documentId: string, version: number) => string[];
  /** Section keys of a version (a roadmap's items check their PRD sections). */
  sectionKeys: (versionId: string) => string[];
  /** As the API's _no_documents (#583 review): the document (id, else slug) has a version made after `at`. */
  versionAfter?: (documentId: string | null, slug: string | null, at: string) => boolean;
  /** The approved version of a document a run reads (the one named, else the latest approved), or why not. */
  sourceVersion: (documentId: string, number: number | null) => VersionSource | string;
  /** E1 part B: the PRD version's draft items a Build roadmap run may reuse, or null. */
  draftItemsToReuse?: (documentId: string, version: number) => { version: number; ready_at: string | null } | null;
  /** Imports a run's draft as the document's next version. */
  importDraft: (
    slug: string,
    run: Pick<RunOut, "id" | "document_kind" | "source" | "template" | "theme">,
    /** A person's Retry import: the version's `imported_again`. */
    again?: string,
  ) => Omit<NonNullable<SegmentOut["draft_import"]>, "warnings" | "problems">;
  /** The run's open baseline proposals (RunOut.open_proposals). */
  openProposals?: (runId: string) => number;
  /** B6: the confirmed and proposed goals not measurable (an approved baseline_confirm's vague_goals). */
  vagueGoals?: () => number;
  /** C7: Approve with edits: the requirements a person added, written to the baseline as `by`'s. */
  scopeApproved?: (scope: StoredScope, by: string) => void;
  uuid: () => string;
  now: () => string;
}

/** A3: the engineering stops (the check and the dates), as oracle.members.leads.ENGINEERING_KINDS. */
export const ENGINEERING_KINDS: readonly string[] = ["eng_review", "eng_dates"];
const LEAD_ONLY = "Only an engineering lead or an owner decides the engineering stops";
/** F4, as flows.SegmentDef.skip_when_off: with its stop off, the whole segment is skipped. */
const SKIP_WHEN_OFF = ["eng_review", "eng_dates"];
const OFF_NOTE = "Turned off when the run started.";
const skippedOff = (s: Pick<SegmentOut, "name" | "checkpoint_on">) => SKIP_WHEN_OFF.includes(s.name) && !s.checkpoint_on;

const ROLES: Schemas["AgentRoleOut"][] = [
  { key: "researcher", title: "Researcher", description: "Gathers and weighs evidence", base_usd: 4 },
  { key: "analyst", title: "Analyst", description: "Turns evidence into structured claims", base_usd: 3 },
  { key: "architect", title: "Architect", description: "Dependencies and high-level design", base_usd: 5 },
  { key: "prioritizer", title: "Prioritizer", description: "Goal-weighted priority order", base_usd: 2.5 },
  { key: "writer", title: "Writer", description: "Writes the PRD draft", base_usd: 6 },
  { key: "critic", title: "Critic", description: "Checks traceability and citations", base_usd: 3 },
];
const READ = ["read:sources", "read:baseline"];

// The baseline segment: Baseline to PRD's first and the whole of Build the baseline (B1).
const BASELINE_SEGMENT: Schemas["FlowSegmentOut"] = {
  name: "baseline",
  title: "Baseline proposal",
  roles: ["researcher", "analyst"],
  scopes: [...READ, "write:proposals"],
  outputs: ["baseline.yaml", "summary.md"],
  checkpoint: "baseline_confirm",
  approver_role: "approver",
  decider: "role",
};

/** E1: the draft-items flow (the generated Flow literal gains it when the schema is regenerated). */
export const DRAFT_ITEMS_FLOW: Schemas["FlowOut"]["key"] = "prd_draft_items";

export const FLOW_CATALOG: Schemas["FlowCatalog"] = {
  flows: [
    {
      key: "baseline_to_prd",
      title: "Baseline to PRD",
      description: "Baseline proposal, feature set and design, priority order, PRD draft.",
      requires_document: false,
      target_kind: "prd",
      source_kind: null,
      // C4: a PRD starts at New PRD (the brief, then Draft with Oracle); the API and MCP keep the flow.
      in_new_run_dialog: false,
      starts_from: { label: "New PRD · PRDs", href: "/documents/new?kind=prd" },
      writes_document: true,
      segments: [
        BASELINE_SEGMENT,
        { name: "feature_set", title: "Feature set, dependencies and design", roles: ["analyst", "architect"], scopes: [...READ, "write:proposals"], outputs: ["feature_set.yaml", "design.md"], checkpoint: "feature_set", approver_role: "approver", decider: "role" },
        // F4: the Engineering check, on by default; off, the whole segment is skipped.
        { name: "eng_review", title: "Engineering check", roles: ["architect"], scopes: [...READ, "read:documents"], outputs: ["tech_briefs.yaml"], checkpoint: "eng_review", approver_role: "approver", decider: "engineering_lead" },
        { name: "priority", title: "Priority order", roles: ["prioritizer"], scopes: ["read:baseline", "write:proposals"], outputs: ["priority.yaml"], checkpoint: "priority_order", approver_role: "approver", decider: "role" },
        { name: "prd_draft", title: "PRD draft", roles: ["writer", "critic"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["prd.md"], checkpoint: "prd_review", approver_role: "approver", decider: "role" },
        // F4 lane B: the Engineering dates, on by default; off, the whole segment is skipped.
        { name: "eng_dates", title: "Engineering dates", roles: ["architect"], scopes: [...READ, "read:documents"], outputs: ["eng_dates.yaml"], checkpoint: "eng_dates", approver_role: "approver", decider: "engineering_lead" },
      ],
    },
    {
      key: "feedback_loop",
      title: "Feedback loop",
      description: "Pull open feedback on a PRD or roadmap, write the next draft, review it.",
      requires_document: true,
      target_kind: null,
      source_kind: null,
      // D12: started from Build next draft on a document, never from the New run dialog.
      in_new_run_dialog: false,
      starts_from: { label: "Build next draft · open a PRD or roadmap and use Build next draft", href: null },
      writes_document: true,
      segments: [
        { name: "next_draft", title: "Next draft", roles: ["analyst", "writer"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["prd.md"], checkpoint: "prd_review", approver_role: "approver", decider: "role" },
      ],
    },
    {
      key: "prd_to_roadmap",
      title: "Roadmap from an approved PRD",
      description: "Roadmap items from an approved PRD version (horizon, milestone, dependencies, priority), then a roadmap draft in the chosen template.",
      requires_document: false,
      target_kind: "roadmap",
      source_kind: "prd",
      in_new_run_dialog: false,
      starts_from: { label: "PRD to roadmap · Plan › Roadmap documents", href: "/plan/documents" },
      writes_document: true,
      segments: [
        { name: "roadmap_items", title: "Roadmap items", roles: ["analyst", "prioritizer"], scopes: [...READ, "read:documents"], outputs: ["roadmap_items.yaml"], checkpoint: "roadmap_items", approver_role: "approver", decider: "role" },
        { name: "roadmap_draft", title: "Roadmap draft", roles: ["writer", "critic"], scopes: [...READ, "read:documents"], outputs: ["roadmap.md"], checkpoint: "roadmap_review", approver_role: "approver", decider: "role" },
      ],
    },
    {
      // E1: every PRD draft's items-only roadmap; started by Oracle's ticker (or Derive on the
      // Roadmap tab), never from the New run dialog. Writes no document; no checkpoint waits.
      key: DRAFT_ITEMS_FLOW,
      title: "Roadmap items for a PRD draft",
      description: "Roadmap items (horizon, milestone, dependencies, priority) proposed from one PRD draft; shown on that version's Roadmap tab.",
      requires_document: false,
      target_kind: null,
      source_kind: "prd",
      in_new_run_dialog: false,
      starts_from: null,
      writes_document: false,
      segments: [
        { name: "roadmap_items", title: "Roadmap items", roles: ["analyst", "prioritizer"], scopes: [...READ, "read:documents"], outputs: ["roadmap_items.yaml"], checkpoint: "roadmap_items", approver_role: "approver", decider: "role" },
      ],
    },
    {
      // F5 lane 3: requested from an approved item in the Plan's inspector or from a PRD's
      // overview (POST /v1/spec-requests), never from the New run dialog.
      key: "prd_to_spec",
      title: "Engineering spec from an approved PRD",
      description: "A technical brief or full engineering spec for a feature's requirements, with SVG user flows and low-fidelity wireframes of 2-4 key screens, each linked to its PRD sections and requirement ids.",
      requires_document: false,
      target_kind: "spec",
      source_kind: "prd",
      entry: "POST /v1/spec-requests",
      in_new_run_dialog: false,
      starts_from: { label: "Request spec · Plan, an approved item, or a PRD's overview", href: "/plan" },
      writes_document: true,
      segments: [
        { name: "spec_draft", title: "Spec, flows and wireframes", roles: ["architect", "designer", "critic"], scopes: [...READ, "read:documents"], outputs: ["spec.md", "design.json"], checkpoint: "eng_review", approver_role: "approver", decider: "role" },
      ],
    },
    {
      key: "strategy_draft",
      title: "Vision or strategy draft",
      description: "Oracle drafts the product vision or the product strategy from the confirmed goals, approved documents, decisions and outcomes; an owner reviews it.",
      requires_document: true,
      writes_document: true,
      target_kind: null,
      source_kind: null,
      // H4: started from Company › Strategy, never from the New run dialog.
      in_new_run_dialog: false,
      starts_from: { label: "Vision or strategy · Company › Strategy, New vision or Draft next version", href: "/company/strategy" },
      segments: [
        { name: "strategy_draft", title: "Vision or strategy draft", roles: ["researcher", "writer", "critic"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["{draft}"], checkpoint: "strategy_review", approver_role: "owner", decider: "role" },
      ],
    },
    {
      key: "baseline",
      title: "Build the baseline",
      description: "Read the sources and propose goals, products, features, constraints and evidence for you to review.",
      requires_document: false,
      writes_document: false,
      target_kind: null,
      source_kind: null,
      // D12: started from the Baseline page, never from the New run dialog.
      in_new_run_dialog: false,
      starts_from: { label: "Build the baseline · Baseline", href: "/baseline?build=1" },
      segments: [BASELINE_SEGMENT],
    },
    {
      // H8: an owner drafts a board or investor update from Company › Updates (New update).
      key: "update_draft",
      title: "Update draft",
      description: "Draft a board or investor update for its period: metrics first, verified dates only, Asks left to the owner.",
      requires_document: true,
      writes_document: true,
      target_kind: null,
      source_kind: null,
      in_new_run_dialog: false,
      // Started from New update on Company › Updates only (owners); the New run dialog does not point at it.
      starts_from: null,
      segments: [
        { name: "update_draft", title: "Update draft", roles: ["analyst", "writer"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["update.md"], checkpoint: "update_review", approver_role: "owner", decider: "role" },
      ],
    },
    {
      // H9: an approver or owner drafts a pricing memo from Company › Market › Pricing (New pricing memo).
      key: "pricing_memo",
      title: "Pricing memo",
      description: "Draft a pricing options memo from willingness-to-pay and win and loss evidence; the pricing owner decides.",
      requires_document: true,
      writes_document: true,
      target_kind: null,
      source_kind: null,
      in_new_run_dialog: false,
      starts_from: { label: "Draft with Oracle · Company › Market › Pricing", href: "/company/market?tab=pricing" },
      segments: [
        { name: "pricing_memo", title: "Pricing memo", roles: ["researcher", "writer"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["pricing.md"], checkpoint: "pricing_review", approver_role: "owner", decider: "role" },
      ],
    },
  ],
  roles: ROLES,
  depths: { quick: 0.5, standard: 1, deep: 2 },
  approval_threshold_usd: 50,
  overrun_factor: 1.5,
  runtime: "fake",
  runtime_notes: ["Test mode: each step finishes at once with a sample draft."],
};

const THRESHOLD = 50;
const KIND_NAME: Record<Kind, string> = {
  prd: "PRD",
  roadmap: "roadmap",
  spec: "engineering spec",
  vision: "vision",
  strategy: "product strategy",
  update: "update",
  pricing: "pricing memo",
};
// O4: a roadmap starts from Now / Next / Later on the roadmap board unless a run names others.
const ROADMAP_DEFAULTS = { template: "now-next-later", theme: "roadmap-board" };
// C4: a Baseline to PRD run with no template gets the built-in goal-traced PRD.
const PRD_DEFAULT_TEMPLATE = "oracle-default";
const FACTOR = 1.5;
const FINAL = ["succeeded", "failed", "cancelled"];
// B1: a Build the baseline run in these states is under way; another is refused.
export const BUILD_UNDER_WAY: RunOut["status"][] = ["awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun"];

/** As the API: one baseline build at a time (409 naming the one under way). */
function buildUnderWay(ctx: RunsContext, flowKey: string): Response | null {
  if (flowKey !== "baseline") return null;
  const first = ctx.db.runs
    .filter((r) => r.flow === "baseline" && BUILD_UNDER_WAY.includes(r.status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return first ? fail(409, `A baseline build is already under way (run ${first.id})`) : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
// The Company time zone's day, as the API words it in notes (#463).
const monthDay = (iso: string) => companyDayInWords(iso);

/**
 * The "new-run-prd" scenario keeps Baseline to PRD in the New run dialog, as a catalog from
 * before C4 did: the dialog's PRD document field (#257) stays reachable for its spec.
 */
export const NEW_RUN_PRD_SCENARIO = "new-run-prd";

function flowCatalog(): Schemas["FlowCatalog"] {
  const inDialog = typeof localStorage !== "undefined" && localStorage.getItem("po-mock-scenario") === NEW_RUN_PRD_SCENARIO;
  if (!inDialog) return FLOW_CATALOG;
  return {
    ...FLOW_CATALOG,
    flows: FLOW_CATALOG.flows.map((f) => (f.key === "baseline_to_prd" ? { ...f, in_new_run_dialog: true, starts_from: null } : f)),
  };
}

function flowOf(key: string) {
  return FLOW_CATALOG.flows.find((f) => f.key === key)!;
}

function segEstimate(roles: string[], depth: string): number {
  const base = roles.reduce((sum, r) => sum + (ROLES.find((x) => x.key === r)?.base_usd ?? 0), 0);
  return round2(base * FLOW_CATALOG.depths[depth]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

/** qa-company-17: the run's document by its own title, as the API's RunSummary.document_title. */
function docTitle(ctx: RunsContext, r: { document_id?: string | null }): string | null {
  return (r.document_id && ctx.documents.find((d) => d.id === r.document_id)?.title) || null;
}

function summary(r: RunOut): Schemas["RunSummary"] {
  return {
    id: r.id,
    flow: r.flow,
    flow_title: r.flow_title,
    status: r.status,
    document_id: r.document_id,
    document_slug: r.document_slug,
    document_kind: r.document_kind,
    source: r.source,
    template: r.template,
    theme: r.theme,
    estimate_usd: r.estimate_usd,
    spent_usd: r.spent_usd,
    created_by: r.created_by,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    waiting_on: r.waiting_on,
    review_link: r.review_link ?? null,
    error: readableRefusal(r.error, r.status === "failed"),
    stuck: r.stuck,
    queue_wait: r.queue_wait ?? null,
    can_retry: r.can_retry,
    can_stop_cancelling: r.can_stop_cancelling,
    can_retry_lookup: r.can_retry_lookup,
    cancel_again: r.cancel_again,
    can_dismiss_overrun: r.can_dismiss_overrun,
    searching: r.searching,
    import_failed: r.import_failed,
    can_retry_import: r.can_retry_import,
    draft_rejected: refused(r, false),
    sent_back: refused(r, true),
    progress: progressOf(r),
    delivering: r.delivering ?? null,
    can_decide: false,
  };
}

/** C4: `reuse_baseline` (B1 "Reuse base"): true asks to reuse; stored as the review it reuses. */
type Reuse = Schemas["ReusedBaseline"];
type KnobsIn = Partial<Omit<Schemas["KnobsIn"], "reuse_baseline">> & { reuse_baseline?: boolean | Reuse | null };
type Knobs = RunOut["knobs"];

/** The review a Baseline to PRD run reuses, or false (C4). */
export function reusedReview(r: Pick<RunOut, "flow" | "knobs">): Reuse | false {
  if (r.flow !== "baseline_to_prd") return false;
  return r.knobs.reuse_baseline ?? false;
}

/** As the API: reusing the baseline is re-checked at estimate and start (409 when it no longer holds). */
function notReusable(r: RunOut): Response | null {
  if (!reusedReview(r)) return null;
  const status = baselineReviewStatus();
  return status.reusable ? null : json(409, { detail: { code: "baseline_not_reusable", reason: status.reason } });
}

function reuseKnob(raw: KnobsIn["reuse_baseline"]): Reuse | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  const status = baselineReviewStatus();
  return status.checkpoint_id && status.last_approved_at ? { checkpoint_id: status.checkpoint_id, approved_at: status.last_approved_at } : null;
}

function resolveKnobs(flowKey: string, raw: KnobsIn | undefined): RunOut["knobs"] | string {
  const flow = flowOf(flowKey);
  const depth = raw?.depth ?? "standard";
  const roles: Record<string, string[]> = {};
  for (const s of flow.segments) {
    const chosen = raw?.roles?.[s.name] ?? s.roles;
    if (chosen.length === 0) return `segment '${s.name}' needs at least one agent role`;
    roles[s.name] = [...chosen];
  }
  const checkpoints: Record<string, boolean> = {};
  for (const s of flow.segments) if (s.checkpoint) checkpoints[s.checkpoint] = raw?.checkpoints?.[s.checkpoint] ?? true;
  const knobs: Knobs = { depth, roles, checkpoints, budget_usd: raw?.budget_usd ?? null, goals: [] };
  if (flowKey === "baseline_to_prd" && raw?.reuse_baseline) knobs.reuse_baseline = reuseKnob(raw.reuse_baseline);
  if (flowKey === "prd_to_roadmap") knobs.reuse_draft_items = raw?.reuse_draft_items !== false;
  return knobs;
}

/** #260, as the API: the confirmed goals (ids or keys) a Baseline to PRD run names; null: none named. */
function targetGoals(ctx: Omit<RunsContext, "db">, flowKey: string, raw: string[] | null | undefined): Schemas["TargetGoal"][] | string | null {
  if (raw == null) return null;
  if (!raw.length) return [];
  if (flowKey !== "baseline_to_prd") return "only a Baseline to PRD run names the goals it serves";
  const confirmed = ctx.confirmedGoals?.() ?? [];
  const out: Schemas["TargetGoal"][] = [];
  for (const ref of raw) {
    const goal = confirmed.find((g) => g.id === ref || g.key === ref);
    if (!goal) return `not a confirmed goal: ${ref}`;
    if (!out.includes(goal)) out.push(goal);
  }
  return out;
}

function segmentsFor(flowKey: string, knobs: RunOut["knobs"], uuid: () => string): SegmentOut[] {
  return flowOf(flowKey).segments.map((s, i) => ({
    id: uuid(),
    seq: i + 1,
    name: s.name,
    title: s.title,
    status: "pending",
    roles: knobs.roles[s.name],
    scopes: s.scopes,
    checkpoint: s.checkpoint,
    checkpoint_on: s.checkpoint ? (knobs.checkpoints[s.checkpoint] ?? true) : false,
    estimate_usd: null,
    cost_usd: 0,
    workflow_id: null,
    artifacts: [],
    attempts: [],
    draft_import: null,
    sent_back: false,
    can_retry_draft_import: false,
    items_check: null,
    previous_attempt: null,
    feature_set_check: null,
    priority_check: null,
    started_at: null,
    finished_at: null,
    error: null,
    agents: [],
    checked_at: null,
  }));
}

/** Segments done of the total and what the run does now, as GET /v1/runs serves them. */
function progressOf(r: RunOut): Schemas["RunProgress"] {
  const now = r.segments.find((s) => s.status === "running") ?? r.segments.find((s) => s.status === "pending");
  return { done: r.segments.filter((s) => s.status === "succeeded").length, total: r.segments.length, now: now?.title ?? null };
}

/** Whose answer the revision applies when Oracle sent a refused draft back itself (the API's SENT_BACK_BY). */
const SENT_BACK_BY = "Oracle";

/**
 * As the API: Oracle sent the segment's refused draft back to the writer itself (its own
 * NOT_YET) and the revision is not imported yet, on a run that has not ended. The run page
 * and the Inbox read "Revising: sent back by Oracle", not "Draft rejected". The mock knows
 * the revision by its running attempt, started with Oracle's findings.
 */
function sentBack(r: RunOut, s: SegmentOut): boolean {
  const a = s.attempts[s.attempts.length - 1];
  return !FINAL.includes(r.status) && !!s.draft_import?.error && a?.note_by === SENT_BACK_BY && a.state === "running";
}

/**
 * As the API: the summary of a draft a segment left that Oracle refused (stored with its
 * problems at the import, oracle.runs.rejection), else its error: one Oracle sent back and is
 * being revised (`revising`, the runs list's "Revising"), or one that is not ("Draft rejected").
 */
function refused(r: RunOut, revising: boolean): string | null {
  // A run that succeeded past the refusal reads neither (owner, 2026-10-25): if it finished
  // with no document, its owners' Inbox says so (noDocument).
  if (r.status === "succeeded") return null;
  const imp = r.segments.find((s) => s.draft_import?.error && sentBack(r, s) === revising)?.draft_import;
  return imp ? (imp.summary ?? imp.error ?? null) : null;
}

/** The open review of a segment, if the run waits at it. */
function reviewOf(r: RunOut, s: SegmentOut): CheckpointOut | undefined {
  if (r.status !== "awaiting_checkpoint") return undefined;
  return r.checkpoints.find((c) => c.status === "pending" && c.segment_seq === s.seq);
}

/** As the API: approving is refused while the draft its segment left is not imported. */
const NOT_IMPORTED = "the draft was not imported: retry import, or request changes";
/** As the API: blocking problems are the approve gate's (D3, gateOf), the feature set's and the priority order's included. */
function cannotApprove(c: CheckpointOut): string | null {
  if (c.status !== "pending") return null;
  const payload = c.payload as { import?: { error?: string | null } } | undefined;
  return payload?.import?.error ? NOT_IMPORTED : null;
}

/** As oracle.runs.gate (D3): a date reason is never waived; file-level problems never are. */
const DATE_CODES = ["unverified_date", "date_outside_now", "undated_source", "invalid_date"];
const DATE_NOT_WAIVED = "a date is never waived: remove it or add a date source";
const FILE_NOT_WAIVED = "a problem of the whole file is never waived: send it back to the agents";
/** As oracle.runs.gate.message. */
const gateMessage = (n: number) => `${n} blocking problem${n === 1 ? "" : "s"} left: fix or waive them, or send back to the agents`;
/** As service.CONSOLE_BLOCKED: a console approval held while blocking problems are open. */
export const CONSOLE_HELD = "Blocking problems are open: fix or waive them, then confirm";

/** As oracle.runs.gate (C6): a key the baseline does not know is fixed, never waived. */
const UNKNOWN_CODES = ["unknown_feature", "unknown_requirement", "unknown_goal", "unknown_dependency"];
const UNKNOWN_NOT_WAIVED = "This cannot be waived; leave it out or send it back";
/** As oracle.runs.feature_set.FILE_PROBLEMS: problems of the file itself. */
const FEATURE_SET_FILE_PROBLEMS = ["unreadable_yaml", "missing_file", "wrong_version", "wrong_document"];

/** As oracle.runs.gate.waivable: what each kind's spec lets a waiver answer (C8: nothing). */
function waivable(kind: string, code: string): boolean {
  if (kind === "baseline_confirm") return code === "goal_undecided";
  if (kind === "roadmap_items") return !DATE_CODES.includes(code);
  if (kind === "feature_set") return !UNKNOWN_CODES.includes(code) && !FEATURE_SET_FILE_PROBLEMS.includes(code) && code !== "no_features";
  return false;
}

/** As oracle.runs.gate.BLOCKING_SOURCES: each kind's stored blocking reasons and file-level problems. */
export type GateReason = Pick<ItemReason, "item" | "item_title" | "code" | "severity" | "label"> & { fixes?: ItemReason["fixes"] };
function blockingOf(cp: CheckpointOut, live?: GateReason[]): { reasons: GateReason[]; files: number } | null {
  // B2: Confirm the baseline's reasons are read live (a goal confirmed anywhere clears its own).
  if (cp.kind === "baseline_confirm") return live ? { reasons: live, files: 0 } : null;
  if (cp.kind === "roadmap_items") {
    const check = (cp.payload?.items_check ?? null) as ItemsCheck | null;
    return { reasons: check?.reasons ?? [], files: check?.file_problems ?? 0 };
  }
  const payload = cp.payload as { feature_set_check?: FeatureSetCheck | null; priority_check?: PriorityCheck | null } | undefined;
  const check = cp.kind === "feature_set" ? payload?.feature_set_check : cp.kind === "priority_order" ? payload?.priority_check : undefined;
  if (check === undefined) return null;
  const problems = (check?.problems ?? []).filter((p) => p.blocking !== false);
  const fileLevel = (p: (typeof problems)[number]) => !p.feature || (cp.kind === "feature_set" && FEATURE_SET_FILE_PROBLEMS.includes(p.code));
  const reasons = problems
    .filter((p) => !fileLevel(p))
    .map((p): GateReason => ({ item: p.feature!, item_title: null, code: p.code, severity: "blocking", label: p.message }));
  return { reasons, files: problems.filter(fileLevel).length };
}

/**
 * As the API (gate.OWNER_WAIVES, H4 §5): the reasons of the roadmap items review only an owner
 * waives. A waiver names them, never covers them by naming none, and is its own action (field
 * "owner"), so an approver's waiver on the same item neither replaces it nor is replaced by it.
 */
const OWNER_WAIVES = ["stopped_but_planned"];

/** As the API: an action answers a reason it names, every reason of its item when it names none, but a waiver naming none never an owner's. */
const answersCode = (a: { kind: string; answers?: string[] | null }, code: string) =>
  a.kind !== "question" && (a.answers?.length ? a.answers.includes(code) : a.kind !== "waive" || !OWNER_WAIVES.includes(code));

/** As the API: waiving another reason of the item adds it to the staged waiver before (naming none covers them all). */
function mergedAnswers(a: { kind: string; answers?: string[] | null }, existing?: { state: string; answers?: string[] | null }): string[] {
  const named = a.answers ?? [];
  if (a.kind !== "waive" || existing?.state !== "staged") return named;
  const before = existing.answers ?? [];
  return before.length && named.length ? [...before, ...named.filter((c) => !before.includes(c))] : [];
}

/**
 * As oracle.runs.gate.approve_gate: the stored blocking reasons a staged waiver does not
 * answer. D7: with `edits`, the gate Approve with edits re-checks: in the mock a staged edit
 * fixes the reasons it is a fix of (Remove date, Move to Later) and a drop the item's reasons.
 * A console approval applies no edits, so its gate is read without them. B2: `live`, the
 * reasons read live (Confirm the baseline's undecided goals).
 */
function gateOf(cp: CheckpointOut, actions: DraftActionRow[], edits = true, live?: GateReason[]): Schemas["Gate"] | null {
  const blocking =
    cp.status !== "pending" ? null : cp.kind === "eng_review" ? engReasons(cp, actions) : cp.kind === "eng_dates" ? datesReasons(cp, actions) : blockingOf(cp, live);
  if (!blocking) return null;
  const waives = (x: GateReason) =>
    waivable(cp.kind, x.code) &&
    actions.some((a) => a.state === "staged" && a.kind === "waive" && a.item_key === x.item && (!a.answers?.length || a.answers.includes(x.code)));
  const applied = edits ? editsOf(cp, actions) : [];
  const fixed = (x: GateReason) => applied.some((a) => (a.kind === "drop" && a.item_key === x.item) || (x.fixes ?? []).some((f) => isFix(a, f)));
  const left = blocking.reasons
    .filter((x) => x.severity === "blocking" && !waives(x) && !fixed(x))
    .map((x) => ({ item: x.item, item_title: x.item_title ?? null, code: x.code, label: x.label, waivable: waivable(cp.kind, x.code) }));
  const files = blocking.files;
  return { open: left.length === 0 && files === 0, blocking_open: left.length, file_problems: files, left };
}

/** As oracle.priorities.service (the compare read): not imported, else the closed gate's message. */
export function cannotApproveNow(db: RunsDb | undefined, cp: CheckpointOut): string | null {
  const gate = gateOf(cp, db?.drafts?.[cp.id]?.actions ?? []);
  return cannotApprove(cp) ?? (gate && !gate.open ? gateMessage(gate.blocking_open + gate.file_problems) : null);
}

/** B2: the goals from the run nobody decided, at Confirm the baseline (the gate's live reasons). */
function liveOf(ctx: RunsContext, cp: CheckpointOut, actions: DraftActionRow[]): GateReason[] | undefined {
  return cp.kind === "baseline_confirm" ? ctx.baselineReview?.(cp.run_id, actions).goals : undefined;
}

/** The gate of `cp` now, with its live reasons. */
function gateNow(ctx: RunsContext, cp: CheckpointOut, actions: DraftActionRow[], edits = true): Schemas["Gate"] | null {
  return gateOf(cp, actions, edits, liveOf(ctx, cp, actions));
}

/**
 * B2 (3.1 (7)): a Confirm the baseline send-back's note: the staged look-again actions, each
 * with its item and note, then the shared draft's note as "General".
 */
function lookAgainNote(ctx: RunsContext, cp: CheckpointOut, staged: DraftActionRow[], note: string | null): string | null {
  const looks = staged.filter((a) => a.kind === "look_again");
  if (cp.kind !== "baseline_confirm" || !looks.length) return note;
  const titles = ctx.baselineReview?.(cp.run_id, staged).titles ?? {};
  const lines = looks.map((a) => {
    const [type, key] = a.item_key.split(/:(.*)/);
    const said = (a.value as { note?: string } | null)?.note ?? a.note ?? "";
    return `- ${type} ${key} (${titles[a.item_key] ?? key})${said ? `: ${said}` : ""}`;
  });
  return ["Look again at these items:", ...lines, ...(note ? [`General: ${note}`] : [])].join("\n");
}

/**
 * The checkpoint with its gate, and Approve refused while the gate is closed (D3); D7: the
 * Approve button's words and the staged actions only the agents can carry out.
 */
function gated(ctx: RunsContext, cp: CheckpointOut): CheckpointOut {
  const actions = ctx.db.drafts?.[cp.id]?.actions ?? [];
  const gate = gateNow(ctx, cp, actions);
  const closed = gate && !gate.open ? gateMessage(gate.blocking_open + gate.file_problems) : null;
  return { ...cp, gate, cannot_approve: cp.cannot_approve ?? closed, approve_label: approveLabel(editsOf(cp, actions).length), needs_agents: needsAgentsOf(cp, actions) };
}

// ---------------------------------------------------------------- D7 approve with edits

/** Staged actions Oracle applies to the file on Approve (they count in "Approve with {n} edits"). */
const APPLIED_KINDS = ["edit", "drop", "restore"];
/** Staged actions only the agents carry out: Approve waits until they are sent back or removed. */
const AGENT_KINDS = ["split", "merge", "question"];

/** The staged edits Oracle applies at a pending Roadmap items checkpoint. */
function editsOf(cp: CheckpointOut, actions: DraftActionRow[]): DraftActionRow[] {
  if (cp.kind !== "roadmap_items" || cp.status !== "pending") return [];
  return actions.filter((a) => a.state === "staged" && APPLIED_KINDS.includes(a.kind));
}

/** As CheckpointOut.needs_agents: staged split, merge or (unanswered) question actions. */
function needsAgentsOf(cp: CheckpointOut, actions: DraftActionRow[]): Schemas["NeedsAgents"][] {
  if (cp.status !== "pending") return [];
  return actions.filter((a) => a.state === "staged" && AGENT_KINDS.includes(a.kind)).map((a) => ({ action_id: a.id, item: a.item_key, kind: a.kind }));
}

const approveLabel = (n: number) => (n === 0 ? "Approve" : `Approve with ${n} edit${n === 1 ? "" : "s"}`);

const needsAgentsMessage = (list: Schemas["NeedsAgents"][]) =>
  list.map((x) => `${x.kind.charAt(0).toUpperCase()}${x.kind.slice(1)} on ${x.item} needs the agents: send back, or remove it to approve.`).join(" ");

const ITEM_LINE = (id: string) => new RegExp(`^\\s*- \\{?id: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,}\\s]`);
const itemIds = (lines: string[]) => lines.map((l) => /^\s*- \{?id: ([\w-]+)/.exec(l)?.[1]).filter((x): x is string => !!x);
const dependsOf = (line: string) => (/depends_on: \[([^\]]*)\]/.exec(line)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const withDepends = (line: string, ids: string[]) => line.replace(/depends_on: \[[^\]]*\]/, `depends_on: [${ids.join(", ")}]`);

/**
 * As oracle.runs.apply_edits.apply, over the mock's file of one flow-style item per line: the
 * staged edits in a fixed order (changes, restores, then drops), with the applied entries and
 * what the result leaves wrong (a dependency on an item not in the file).
 */
function applyEdits(text: string, edits: DraftActionRow[], reasons: ItemReason[]): { text: string; applied: Record<string, unknown>[]; problems: string[] } {
  const lines = text.split("\n");
  const at = (id: string) => lines.findIndex((l) => ITEM_LINE(id).test(l));
  const applied: Record<string, unknown>[] = [];
  const rank = (a: DraftActionRow) => ["edit", "restore", "drop"].indexOf(a.kind);
  for (const a of [...edits].sort((x, y) => rank(x) - rank(y))) {
    const id = a.item_key;
    const i = at(id);
    if (a.kind === "drop") {
      if (i < 0) continue;
      lines.splice(i, 1);
      for (let j = 0; j < lines.length; j++) if (dependsOf(lines[j]).includes(id)) lines[j] = withDepends(lines[j], dependsOf(lines[j]).filter((x) => x !== id));
      applied.push({ id, action: "drop", text: `${id} dropped` });
      continue;
    }
    if (a.kind === "restore") {
      if (i >= 0) continue;
      const title = reasons.find((x) => x.item === id)?.item_title ?? id;
      const end = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      lines.splice(end, 0, `  - {id: ${id}, title: ${title}}`);
      applied.push({ id, action: "restore", text: `${id} restored from the comparison base` });
      continue;
    }
    if (i < 0) continue;
    const field = a.field ?? "";
    let line = lines[i];
    let said: string;
    if (field === "milestone_date") {
      line = line.replace(/, date: [^,}]+/, "").replace(/, date_source: [^,}]+/, "");
      said = `${id} milestone date removed`;
    } else if (field === "depends_on") {
      const v = (a.value ?? {}) as { add?: string[]; remove?: string[] };
      const had = dependsOf(line);
      const now = [...had.filter((x) => !(v.remove ?? []).includes(x)), ...(v.add ?? []).filter((x) => !had.includes(x))];
      line = /depends_on: \[/.test(line) ? withDepends(line, now) : line.replace(/\}\s*$/, `, depends_on: [${now.join(", ")}]}`);
      said = `${id} depends_on [${had.join(", ")}] → [${now.join(", ")}]`;
    } else if (field.startsWith("clear:")) {
      line = line.replace(new RegExp(`, ${field.slice(6)}: (\\{[^}]*\\}|\\[[^\\]]*\\]|[^,}]+)`), "");
      said = `${id} ${field.slice(6).replace("_", " ")} cleared`;
    } else {
      const value = String(a.value ?? "");
      const was = new RegExp(`\\b${field}: ([^,}]+)`).exec(line)?.[1] ?? null;
      line = was != null ? line.replace(new RegExp(`\\b${field}: [^,}]+`), `${field}: ${value}`) : line.replace(/\}\s*$/, `, ${field}: ${value}}`);
      said = `${id} ${field.replace("_", " ")} ${was ?? "none"} → ${value}`;
    }
    lines[i] = line;
    applied.push({ id, action: "change", field, value: a.value ?? null, text: said });
  }
  const known = itemIds(lines);
  const problems = lines.flatMap((l) => {
    const id = /^\s*- \{?id: ([\w-]+)/.exec(l)?.[1];
    return id ? dependsOf(l).filter((d) => !known.includes(d)).map((d) => `${id} depends on ${d}, which is not in the file`) : [];
  });
  return { text: lines.join("\n"), applied, problems };
}

/** As decide_checkpoint's re-check: the items check of the edited file (fixed reasons gone). */
function recheck(check: ItemsCheck, text: string, edits: DraftActionRow[]): ItemsCheck {
  const ids = itemIds(text.split("\n"));
  const dropped = edits.filter((a) => a.kind === "drop").map((a) => a.item_key);
  const fixed = (x: ItemReason) => dropped.includes(x.item) || x.fixes.some((f) => edits.some((a) => isFix(a, f)));
  const reasons = check.reasons.filter((x) => !fixed(x));
  const gone = check.reasons.filter(fixed);
  const problems = check.problems.filter((p) => !p.item || (!dropped.includes(p.item) && !gone.some((x) => x.item === p.item && x.code === p.code)));
  const by_horizon: Record<string, number> = { now: 0, next: 0, later: 0 };
  for (const l of text.split("\n")) {
    const h = /^\s*- \{?id: .*\bhorizon: (\w+)/.exec(l)?.[1];
    if (h) by_horizon[h] = (by_horizon[h] ?? 0) + 1;
  }
  return withReasons({ items: ids.length, by_horizon: by_horizon as ItemsCheck["by_horizon"], problems }, reasons, check.base);
}

/** A staged action is this reason's fix: the same item, kind, field and value. */
function isFix(a: DraftActionRow, f: ItemReason["fixes"][number]): boolean {
  return (
    f.action.kind === a.kind &&
    f.action.item === a.item_key &&
    (f.action.field ?? null) === (a.field ?? null) &&
    JSON.stringify(f.action.value ?? null) === JSON.stringify(a.value ?? null)
  );
}

/** As the API's _run_version: a version this run imported (any segment or review), as "slug vN". */
function runVersion(r: RunOut): string | null {
  const imports = [...r.segments.map((s) => s.draft_import), ...r.checkpoints.map((c) => (c.payload as { import?: SegmentOut["draft_import"] }).import)];
  const imp = imports.find((i) => i && i.version != null && !i.error);
  return imp ? `${imp.slug} v${imp.version}` : null;
}

/** As the API's one_version (owner, 2026-10-25): why a finished run's refused draft stays refused. */
function oneVersion(version: string): string {
  return `this run already imported ${version}, and a finished run imports one version only, so this draft is not imported. Start a new run to draft it again.`;
}

/** As the API's NO_DOCUMENT_SINCE (#583 review): runs that finished before the No document row shipped get none. */
export const NO_DOCUMENT_SINCE = "2026-10-25T00:00:00Z";

/**
 * As the API (owner, 2026-10-25): a run that finished with no document, why and what to do; else null.
 * The row clears itself (#583 review) once the run imported a version (Retry import), or once its
 * document has a version made after the run finished (a later run imported it).
 */
function noDocument(ctx: RunsContext, r: RunOut): string | null {
  const s = r.segments.find((x) => x.draft_import?.error);
  if (r.status !== "succeeded" || !s || runVersion(r)) return null;
  if (!r.finished_at || Date.parse(r.finished_at) < Date.parse(NO_DOCUMENT_SINCE)) return null;
  if (ctx.versionAfter?.(r.document_id ?? null, r.document_slug ?? null, r.finished_at)) return null;
  const imp = s.draft_import!;
  const action = s.can_retry_draft_import
    ? "Open the run and use Retry import once the problems are fixed, or start a new run."
    : "Start a new run to draft it again.";
  const what = r.document_slug ?? `The ${r.flow_title} run`;
  return `${what} finished without a document: Oracle refused its draft (${imp.summary ?? imp.error}) and the run was approved past it. ${action}`;
}

/** The decided review of a finished run's segment whose draft was refused (owners retry it). */
function finishedReview(r: RunOut, s: SegmentOut): CheckpointOut | undefined {
  if (r.status !== "succeeded" || r.segments.some((x) => x.draft_import && !x.draft_import.error)) return undefined;
  return r.checkpoints.filter((c) => c.segment_seq === s.seq && c.status !== "pending").pop();
}

/** D10: the kinds decided in their version (as oracle.runs.review_link.KINDS). */
const RUN_REVIEW_KINDS: readonly string[] = ["prd_review", "roadmap_review"];

/** D10: the version a run review checkpoint reviews (`payload.import`), when its draft was imported. */
export function reviewedVersion(c: Pick<CheckpointOut, "kind" | "payload">): { document_id: string; slug: string; version: number } | null {
  const imp = (c.payload as { import?: { document_id?: string | null; slug?: string | null; version?: number | null } }).import;
  return RUN_REVIEW_KINDS.includes(c.kind) && imp?.document_id && imp.slug && imp.version
    ? { document_id: imp.document_id, slug: imp.slug, version: imp.version }
    : null;
}

function reviewLink(c: CheckpointOut): string | null {
  const v = reviewedVersion(c);
  return v ? `/documents/${v.slug}/v/${v.version}?run_review=${c.id}` : null;
}

/** D10: the document's feedback a Send back carries (open items and staged changes). */
export function sendBackEntries(ctx: Pick<RunsContext, "feedback" | "staged">, documentId: string, version: number): number {
  return ctx.feedback.filter((f) => f.document_id === documentId && f.raised_on_version <= version && (f.status === "open" || ctx.staged?.(f.id))).length;
}

/**
 * D10: the version's review approved its run review (the last section approved, or the
 * version published): decided as an Approve, audited by the API `via: document_review`.
 */
export function approveRunReview(ctx: RunsContext, runId: string, checkpointId: string) {
  const r = ctx.db.runs.find((x) => x.id === runId);
  const cp = r?.checkpoints.find((c) => c.id === checkpointId);
  if (!r || !cp || cp.status !== "pending" || r.status !== "awaiting_checkpoint") return;
  Object.assign(cp, { status: "approved", note: null, decided_by: ctx.userId, decided_at: ctx.now() });
  cp.payload = { ...cp.payload, decided: { role: ctx.userRole ?? null, via: "oracle" } };
  next(ctx, r, r.segments.find((x) => x.seq === cp.segment_seq)!);
  refresh(r);
}

function refresh(r: RunOut) {
  r.progress = progressOf(r);
  r.draft_rejected = refused(r, false);
  r.sent_back = refused(r, true);
  for (const s of r.segments) s.sent_back = sentBack(r, s);
  r.spent_usd = round2(r.segments.reduce((sum, s) => sum + s.cost_usd, 0));
  r.waiting_on = r.checkpoints.find((c) => c.status === "pending")?.kind ?? null;
  // As the API: waiting on its checkpoint, a decision recorded there and not delivered yet.
  // Oracle's send-back means no decision is owed: Revising wins.
  r.delivering = r.status === "awaiting_checkpoint" && !r.sent_back ? (r.checkpoints.find((c) => c.delivery)?.kind ?? null) : null;
  for (const c of r.checkpoints) Object.assign(c, { can_decide: c.status === "pending", cannot_approve: cannotApprove(c), review_link: reviewLink(c) });
  // D10: a run waiting at its PRD or roadmap review is decided in the version.
  r.review_link = r.checkpoints.find((c) => c.status === "pending")?.review_link ?? null;
  // As the API: a refused draft whose file is kept, while the run waits at its review.
  const file = r.document_kind === "roadmap" ? "roadmap.md" : "prd.md";
  for (const s of r.segments) {
    s.can_retry_draft_import = !!s.draft_import?.error && s.artifacts.includes(file) && !!(reviewOf(r, s) ?? finishedReview(r, s));
  }
  const version = r.status === "succeeded" ? runVersion(r) : null;
  for (const s of r.segments) {
    const why = version && s.draft_import?.error ? oneVersion(version) : null;
    s.draft_retry_refused = why && why[0].toUpperCase() + why.slice(1);
  }
}

/** As the API (D5): a person sent the segment back, so its files are kept as the previous attempt (one level). */
function keepPrevious(ctx: RunsContext, r: RunOut, s: SegmentOut) {
  const last = s.attempts[s.attempts.length - 1];
  if (!last || s.artifacts.length === 0) return;
  for (const name of s.previous_attempt?.artifacts ?? []) delete ctx.db.artifacts[`${r.id}|${s.seq}|${name}|${s.previous_attempt!.attempt}`];
  for (const name of s.artifacts) ctx.db.artifacts[`${r.id}|${s.seq}|${name}|${last.attempt}`] = ctx.db.artifacts[`${r.id}|${s.seq}|${name}`];
  s.previous_attempt = { attempt: last.attempt, artifacts: [...s.artifacts] };
}

function submit(ctx: RunsContext, r: RunOut, s: SegmentOut, note: string | null = null) {
  if (note) keepPrevious(ctx, r, s);
  s.status = "running";
  s.workflow_id = `mock-wf-${ctx.uuid().slice(0, 8)}`;
  s.started_at ??= ctx.now();
  s.finished_at = null;
  Object.assign(s, { agents: [], checked_at: null });
  s.attempts.push({ attempt: s.attempts.length + 1, workflow_id: s.workflow_id, submitted_at: ctx.now(), cost_usd: 0, note, state: "running" });
  r.status = "running";
}

function finish(ctx: RunsContext, r: RunOut, status: RunOut["status"]) {
  r.status = status;
  r.finished_at = ctx.now();
}

function next(ctx: RunsContext, r: RunOut, s: SegmentOut) {
  const later = r.segments.find((x) => x.seq > s.seq && x.status !== "skipped");
  if (later) submit(ctx, r, later);
  else finish(ctx, r, "succeeded");
}

/** A feature set as feature_set.yaml lists it (C6, oracle.runs.feature_set). */
interface FeatureSetSpec {
  features: {
    key: string;
    title: string;
    summary: string;
    goals: { key: string; contribution: number }[];
    depends_on: string[];
    confidence: number;
    requirements: { key: string; text: string; acceptance: string[] }[];
  }[];
  excluded: { key: string; reason: string }[];
}

/** The local runtime's feature set: clean, as the API's FakeRuntime leaves it. */
const LOCAL_FEATURE_SET: FeatureSetSpec = {
  features: [
    {
      key: "price-early",
      title: "Show the price early",
      summary: "Buyers see the full price before checkout",
      goals: [{ key: "g1", contribution: 2 }],
      depends_on: [],
      confidence: 0.8,
      requirements: [{ key: "price-early-total", text: "The cart shows the total with delivery before checkout", acceptance: ["Delivery cost is included"] }],
    },
    {
      key: "guest-checkout",
      title: "Guest checkout",
      summary: "First-time buyers pay without an account",
      goals: [{ key: "g1", contribution: 3 }],
      depends_on: ["price-early"],
      confidence: 0.7,
      requirements: [{ key: "guest-checkout-email", text: "A guest gives an email address only", acceptance: ["No password is asked for"] }],
    },
    {
      key: "order-tracking",
      title: "Order tracking",
      summary: "Buyers follow their order after paying",
      goals: [{ key: "g1", contribution: 1 }],
      depends_on: [],
      confidence: 0.6,
      requirements: [{ key: "order-tracking-link", text: "The confirmation email links to the order's status", acceptance: ["The link works without signing in"] }],
    },
  ],
  excluded: [{ key: "gift-wrapping", reason: "Serves no confirmed goal" }],
};

const flow = (items: string[]) => `[${items.map((x) => JSON.stringify(x)).join(", ")}]`;

/** feature_set.yaml (version 1) for a set. */
function featureSetYaml(spec: FeatureSetSpec, document: string | null | undefined,segment: string, attempt: number): string {
  const lines = [`# ${segment} (attempt ${attempt})`, "version: 1", `document: ${document ?? "example-prd"}`, "features:"];
  for (const f of spec.features) {
    lines.push(
      `  - key: ${f.key}`,
      `    title: ${f.title}`,
      `    summary: ${f.summary}`,
      `    goals: [${f.goals.map((g) => `{key: ${g.key}, contribution: ${g.contribution}}`).join(", ")}]`,
      `    depends_on: ${flow(f.depends_on)}`,
      `    confidence: ${f.confidence}`,
      "    requirements:",
    );
    for (const r of f.requirements) lines.push(`      - key: ${r.key}`, `        text: ${r.text}`, `        acceptance: ${flow(r.acceptance)}`);
  }
  lines.push("excluded:");
  for (const e of spec.excluded) lines.push(`  - key: ${e.key}`, `    reason: ${e.reason}`);
  return `${lines.join("\n")}\n`;
}

/** The counts of a set's check, with the problems and flags given. */
function checkOf(spec: FeatureSetSpec, problems: FeatureSetCheck["problems"] = [], flags: FeatureSetCheck["flags"] = {}): FeatureSetCheck {
  return {
    features: spec.features.length,
    requirements: spec.features.reduce((n, f) => n + f.requirements.length, 0),
    excluded: spec.excluded.length,
    problems,
    flags,
  };
}

/** The proposed scope a feature-set segment's attempt writes (oracle.runs.feature_set.write_scope). */
function proposeScope(ctx: Pick<RunsContext, "db" | "uuid">, r: RunOut, seq: number, attempt: number, spec: FeatureSetSpec, check: FeatureSetCheck) {
  const scopes = ((ctx.db.scopes ??= {})[r.id] ??= []);
  // Any other proposed scope of the run is superseded.
  for (const x of scopes) if (x.status === "proposed") Object.assign(x, { status: "superseded", lock_version: x.lock_version + 1 });
  const feature = (key: string): PrdScopeOut["features"][number] => ({
    id: ctx.uuid(),
    key,
    title: key,
    decision: "include",
    decision_reason: null,
    origin: "agent",
    goals: [],
    depends_on: [],
    blocker_keys: [],
    confidence: null,
    flags: [],
    entity_id: null,
    proposal_id: null,
    requirements: [],
  });
  scopes.push({
    id: ctx.uuid(),
    run_id: r.id,
    document_id: r.document_id,
    segment_seq: seq,
    attempt,
    status: "proposed",
    check,
    features: [
      ...spec.features.map((f) => ({
        ...feature(f.key),
        title: f.title,
        goals: f.goals.map((g) => ({ goal_id: null, key: g.key, contribution: g.contribution })),
        depends_on: f.depends_on,
        confidence: f.confidence,
        flags: check.flags[f.key] ?? [],
        requirements: f.requirements.map((q) => ({
          id: ctx.uuid(),
          key: q.key,
          title: q.text,
          text: q.text,
          acceptance: q.acceptance,
          decision: "keep" as const,
          decision_reason: null,
          origin: "agent" as const,
          entity_id: null,
          proposal_id: null,
        })),
      })),
      ...spec.excluded.map((e) => ({ ...feature(e.key), decision: "exclude" as const, decision_reason: e.reason })),
    ],
    approved_by: null,
    approved_at: null,
    lock_version: 1,
  });
}

/** As the API at the feature-set stop: approving approves the run's proposed scope (`by` null: the stop was off), requesting changes supersedes it. */
function decideScope(ctx: Pick<RunsContext, "db" | "now">, r: RunOut, decision: "approved" | "changes_requested", by: string | null) {
  const scope = (ctx.db.scopes?.[r.id] ?? []).filter((x) => x.status === "proposed").pop();
  if (!scope) return;
  if (decision === "changes_requested") {
    Object.assign(scope, { status: "superseded", lock_version: scope.lock_version + 1 });
    return;
  }
  Object.assign(scope, { status: "approved", approved_by: by, approved_at: ctx.now(), lock_version: scope.lock_version + 1 });
  // A document has one approved scope.
  if (!scope.document_id) return;
  for (const x of Object.values(ctx.db.scopes ?? {}).flat()) {
    if (x !== scope && x.status === "approved" && x.document_id === scope.document_id) Object.assign(x, { status: "superseded", lock_version: x.lock_version + 1 });
  }
}

/** A priority order as priority.yaml lists it (C8, oracle.priorities.run_order): ranks follow the list. */
interface OrderSpec {
  method: Method;
  order: { key: string; score: number; explanation: string }[];
}

/** The local runtime's order of its feature set: clean. */
const LOCAL_ORDER: OrderSpec = {
  method: "goal_weighted",
  order: [
    { key: "price-early", score: 4.8, explanation: "G1 weight 3 x contribution 2 x confidence 0.8 / effort 1" },
    { key: "guest-checkout", score: 6.3, explanation: "Needs price-early first; G1 weight 3 x contribution 3 x 0.7 / 1" },
    { key: "order-tracking", score: 1.8, explanation: "G1 weight 3 x contribution 1 x 0.6 / 1" },
  ],
};

/** priority.yaml (version 1) for an order. */
function priorityYaml(spec: OrderSpec, segment: string, attempt: number): string {
  const lines = [`# ${segment} (attempt ${attempt})`, "version: 1", `method: ${spec.method}`, "order:"];
  spec.order.forEach((o, i) => lines.push(`  - key: ${o.key}`, `    rank: ${i + 1}`, `    score: ${o.score}`, `    explanation: ${JSON.stringify(o.explanation)}`));
  return `${lines.join("\n")}\n`;
}

/** The approved PRD scope a run's order must rank (C6), else null. */
function scopeOf(ctx: Pick<RunsContext, "db">, r: RunOut): PrdScopeOut["features"] | null {
  const scope = (ctx.db.scopes?.[r.id] ?? []).filter((x) => x.status === "approved").pop();
  return scope ? scope.features.filter((f) => f.decision === "include") : null;
}

/**
 * As the API's check (oracle.priorities.run_order.check_order), for the codes the mock's
 * orders can show: unknown_feature, not_in_scope, missing_feature, before_prerequisite
 * (blocking); differs_from_live, no_goal (advisory). The live ranking is the mock's
 * (./lane-f.ts), restricted to the ranked features.
 */
function checkOrder(spec: OrderSpec, scope: PrdScopeOut["features"] | null): PriorityCheck {
  const live = ranking(spec.method).features;
  const keys = spec.order.map((o) => o.key);
  const restricted = live.filter((f) => keys.includes(f.key)).map((f) => f.key);
  const rank = Object.fromEntries(keys.map((k, i) => [k, i + 1]));
  const deps: Record<string, string[]> = Object.fromEntries(live.map((f) => [f.key, [...f.depends_on]]));
  for (const f of scope ?? []) deps[f.key] = [...(deps[f.key] ?? []), ...f.depends_on];
  const problems: PriorityCheck["problems"] = [];
  const add = (code: string, feature: string, message: string, blocking = true) => problems.push({ code, blocking, feature, message });
  const inScope = new Set((scope ?? []).map((f) => f.key));
  for (const k of keys) {
    if (!live.some((f) => f.key === k) && !inScope.has(k)) add("unknown_feature", k, `${k} is not a feature of the baseline or the scope`);
    else if (scope && !inScope.has(k)) add("not_in_scope", k, `${k} is not included in the approved PRD scope`);
  }
  for (const f of scope ?? []) if (!(f.key in rank)) add("missing_feature", f.key, `${f.key} is in the approved PRD scope and not ranked`);
  for (const k of keys) {
    for (const d of [...new Set(deps[k] ?? [])].sort()) {
      if (d in rank && rank[d] > rank[k]) add("before_prerequisite", k, `${k} is ranked ${rank[k]}, above ${d} (rank ${rank[d]}), which it depends on`);
    }
  }
  const order = spec.order.map((o, i) => {
    const at = restricted.indexOf(o.key);
    return { key: o.key, rank: i + 1, score: o.score, explanation: o.explanation, live_rank: at < 0 ? null : at + 1 };
  });
  for (const o of order) {
    if (o.live_rank != null && Math.abs(o.live_rank - o.rank) > 2) {
      add("differs_from_live", o.key, `${o.key} is ranked ${o.rank} here and ${o.live_rank} in the live ranking`, false);
    }
    if (live.find((f) => f.key === o.key)?.flags.includes("no_confirmed_goal")) {
      add("no_goal", o.key, `${o.key} serves no confirmed goal in the live ranking`, false);
    }
  }
  return { method: spec.method, features: order.length, problems, order };
}

/** The PRD a run's order is for: its document, else the slug the run writes. */
function orderDocument(ctx: Pick<RunsContext, "documents">, r: RunOut): SnapshotRow["document"] {
  const doc = r.document_id ? ctx.documents.find((d) => d.id === r.document_id) : undefined;
  if (doc) return { id: doc.id, slug: doc.slug, title: doc.title };
  return r.document_slug ? { id: null, slug: r.document_slug, title: null } : null;
}

/**
 * As the API at the priority segment's end (oracle.priorities.run_order.propose): the order
 * becomes the run's proposed snapshot; the run's other proposed one is discarded, one for
 * the same attempt is replaced.
 */
function proposeOrder(ctx: Pick<RunsContext, "db" | "uuid" | "now" | "documents">, r: RunOut, seq: number, attempt: number, spec: OrderSpec, check: PriorityCheck): SnapshotRow {
  const all = (ctx.db.priority_snapshots ??= []);
  const same = all.find((x) => x.run_id === r.id && x.status === "proposed" && x.params.segment_seq === seq && x.params.attempt === attempt);
  for (const x of all) if (x !== same && x.run_id === r.id && x.status === "proposed") Object.assign(x, { status: "discarded", decided_at: ctx.now() });
  const live = Object.fromEntries(ranking(spec.method).features.map((f) => [f.key, f]));
  const rows = check.order!.filter((o) => live[o.key]).map((o) => ({ ...live[o.key], rank: o.rank, live_rank: o.live_rank, run_explanation: o.explanation }));
  const snap: SnapshotRow = {
    id: same?.id ?? ctx.uuid(),
    method: spec.method,
    created_by: null,
    created_at: same?.created_at ?? ctx.now(),
    note: null,
    feature_count: rows.length,
    top: rows.slice(0, 5).map((f) => f.key),
    status: "proposed",
    run_id: r.id,
    document: orderDocument(ctx, r),
    decided_by: null,
    decided_at: null,
    params: { segment_seq: seq, attempt },
    ranking: rows,
    checkpoint_id: null,
    scope_id: null,
    check_result: check,
  };
  if (same) Object.assign(same, snap);
  else all.push(snap);
  return same ?? snap;
}

/** As the API (rules 3-5): approving saves the order for the PRD (`by` null: Oracle, the stop was off); requesting changes discards it. */
function decideOrder(ctx: Pick<RunsContext, "db" | "now" | "documents">, r: RunOut, cp: CheckpointOut, decision: "approved" | "changes_requested", by: string | null) {
  const snap = (ctx.db.priority_snapshots ?? []).find((x) => x.id === cp.payload.priority_snapshot_id && x.status === "proposed");
  if (!snap) return;
  Object.assign(snap, { status: decision === "approved" ? "saved" : "discarded", decided_by: by, decided_at: ctx.now() });
  if (decision === "approved") snap.document = orderDocument(ctx, r) ?? snap.document;
}

/** The priority stop's note when Oracle saved the order itself (H11 ``priorities`` at Act). */
const ORDER_SAVED_BY_ORACLE = "Oracle saved this order: Order priorities is set to Act within limits.";

const goalsOf = (row: SnapshotRow["ranking"][number]) => new Set((row.explanation?.goals ?? []).map((g) => String(g.goal)));

/**
 * As oracle.priorities.run_order.outside_limits: why an order is outside the limits, or null.
 * Compared with the live ranking of the same features, a feature moves more than
 * `most` places, or passes one that shares no goal with it. Features the live ranking does
 * not hold are not moves.
 */
function outsideLimits(rows: SnapshotRow["ranking"], most: number): string | null {
  const ranked = rows.filter((r) => r.live_rank != null).sort((a, b) => a.rank - b.rank);
  for (const [i, r] of ranked.entries()) {
    const moved = Math.abs(i + 1 - r.live_rank!);
    if (moved > most) return `${r.key} moves ${moved === 1 ? "1 place" : `${moved} places`}, more than ${most}`;
  }
  for (const [i, a] of ranked.entries()) {
    for (const b of ranked.slice(i + 1)) {
      const ga = goalsOf(a);
      if (a.live_rank! > b.live_rank! && ![...goalsOf(b)].some((g) => ga.has(g))) return `${a.key} passes ${b.key}, which serves another goal`;
    }
  }
  return null;
}

/** As the API's _oracle_saves_order: ``priorities`` at Act, nothing blocking, every move within one goal and the limit. */
function oracleSavesOrder(ctx: RunsContext, check: PriorityCheck, snap: SnapshotRow): boolean {
  const a = ctx.autonomy;
  if (!a || a.level() !== "act") return false;
  if (check.problems.some((p) => p.blocking ?? true)) return false;
  const limits = a.limits();
  if (!limits) return false;
  return outsideLimits(snap.ranking, Number(limits.max_rank_move ?? 0)) === null;
}

/** As the API's _tell_order_saved: the run's starter gets an "Oracle did" row, with no Undo. */
function tellOrderSaved(ctx: RunsContext, r: RunOut) {
  const doc = r.document_id ? ctx.documents.find((d) => d.id === r.document_id) : undefined;
  const name = doc?.title ?? r.document_slug ?? "this run";
  ctx.autonomy?.acted({
    summary: `Saved the priority order of ${name}, within one goal and your limit`,
    subject: { kind: "run", key: r.id, href: `/runs/${r.id}` },
    undo: null,
    notify: r.created_by ? [r.created_by] : [],
  });
}

function fileContent(name: string, segment: string, attempt: number, document?: string | null): string {
  if (name === "tech_briefs.yaml") return briefsYaml(LOCAL_BRIEFS, attempt);
  if (name === "eng_dates.yaml") return datesYaml({ ...LOCAL_DATES, prd: null, problems: [] }, attempt);
  if (name === "feature_set.yaml") return featureSetYaml(LOCAL_FEATURE_SET, document, segment, attempt);
  if (name === "priority.yaml") return priorityYaml(LOCAL_ORDER, segment, attempt);
  if (name === "prd.md") return `---\ntitle: Example product PRD\n---\n\n# Example product PRD {#title}\n\nDraft ${attempt}, a sample.\n`;
  if (name === "roadmap.md") return `---\ntitle: Example product roadmap\nkind: roadmap\n---\n\n# Example product roadmap {#roadmap}\n\nDraft ${attempt}, a sample.\n`;
  if (name === "roadmap_items.yaml") {
    return `# ${segment} (sample, attempt ${attempt})\nversion: 1\nitems:\n  - id: price-early\n    title: Show the price early\n    outcome: Fewer buyers drop off at checkout\n    horizon: now\n    milestone: Beta\n    confidence: medium\n    prd_section: features\n`;
  }
  if (name.endsWith(".yaml")) return `# ${segment} (attempt ${attempt})\nitems:\n  - key: g1\n    title: Raise first-order completion to 70%\n    confidence: 0.82\n`;
  return `# ${segment}\n\nA sample draft (attempt ${attempt}).\n`;
}

function advance(ctx: RunsContext, r: RunOut, s: SegmentOut) {
  const def = flowOf(r.flow).segments.find((x) => x.name === s.name)!;
  const attempt = s.attempts.length;
  for (const name of def.outputs) ctx.db.artifacts[`${r.id}|${s.seq}|${name}`] = fileContent(name, s.name, attempt, r.document_slug);
  s.artifacts = [...def.outputs].sort();
  // The local runtime's one item cites PRD section "features", as the API's FakeRuntime does.
  if (def.outputs.includes("roadmap_items.yaml")) {
    const known = r.source ? ctx.sectionKeys(r.source.version_id) : [];
    s.items_check = localItemsCheck(known.includes("features"), r.source ?? null);
  }
  // C6: the local runtime's feature set checks clean, and its attempt writes a proposed scope.
  if (def.outputs.includes("feature_set.yaml")) {
    s.feature_set_check = checkOf(LOCAL_FEATURE_SET);
    proposeScope(ctx, r, s.seq, attempt, LOCAL_FEATURE_SET, s.feature_set_check);
  }
  // C8: the local runtime's order checks against the approved scope, and becomes a proposed snapshot.
  let snapshot: SnapshotRow | null = null;
  // F4: the architect's briefs, one per feature of the run's feature set, checked as the stop reads them.
  const briefs = def.outputs.includes("tech_briefs.yaml") ? briefsCheckOf(r.id === ENG_CHECK_RUN ? SEEDED_BRIEFS : LOCAL_BRIEFS) : null;
  // F4 lane B: the architect's dates for the draft's Now items, checked as the stop reads them.
  const dates = def.outputs.includes("eng_dates.yaml") ? datesCheckOf(r, r.id === ENG_DATES_RUN ? SEEDED_DATES : LOCAL_DATES) : null;
  if (dates) ctx.db.artifacts[`${r.id}|${s.seq}|eng_dates.yaml`] = datesYaml(dates, attempt);
  if (def.outputs.includes("priority.yaml")) {
    s.priority_check = checkOrder(LOCAL_ORDER, scopeOf(ctx, r));
    snapshot = proposeOrder(ctx, r, s.seq, attempt, LOCAL_ORDER, s.priority_check);
  }
  if ((def.outputs.includes("prd.md") || def.outputs.includes("roadmap.md") || def.outputs.includes("update.md") || def.outputs.includes("pricing.md")) && r.document_slug) {
    const imp = ctx.importDraft(r.document_slug, r);
    s.draft_import = { ...imp, created: true, warnings: [], error: null, problems: [], summary: null };
    r.document_id = imp.document_id ?? null;
    // As the API (fill_document): once the draft imports, the run's scopes and orders name the document.
    for (const x of ctx.db.scopes?.[r.id] ?? []) x.document_id ??= r.document_id;
    for (const x of ctx.db.priority_snapshots ?? []) if (x.run_id === r.id && !x.document?.id) x.document = orderDocument(ctx, r);
  }
  const payload = {
    segment_seq: s.seq,
    segment: s.name,
    attempt,
    artifacts: s.artifacts,
    ...(s.feature_set_check ? { feature_set_check: s.feature_set_check } : {}),
    ...(snapshot ? { priority_check: s.priority_check, priority_snapshot_id: snapshot.id } : {}),
    ...(briefs ? { briefs_check: briefs } : {}),
    ...(dates ? { dates_check: dates } : {}),
    // As the API: the review of an imported draft names its version.
    ...(s.draft_import?.version ? { import: { document_id: s.draft_import.document_id, slug: s.draft_import.slug, kind: r.document_kind, version: s.draft_import.version } } : {}),
  };
  if (!def.checkpoint) {
    // No stop (F5-2's code_map index): the run goes on, or ends.
    next(ctx, r, s);
    return;
  }
  const stopOn = r.knobs.checkpoints[def.checkpoint] ?? true;
  // H11 ``priorities`` at Act: Oracle saves an order inside the limits itself.
  const oracleOrders = stopOn && !!snapshot && oracleSavesOrder(ctx, s.priority_check!, snapshot);
  const on = stopOn && !oracleOrders;
  if (!stopOn && s.feature_set_check) decideScope(ctx, r, "approved", null);
  const cp: CheckpointOut = {
    id: ctx.uuid(),
    run_id: r.id,
    // As the API: the feedback loop on a roadmap is a roadmap review.
    kind: def.checkpoint === "prd_review" && r.document_kind === "roadmap" ? "roadmap_review" : def.checkpoint,
    status: on ? "pending" : "skipped",
    approver_role: def.approver_role,
    segment_seq: s.seq,
    decided_by: null,
    decided_at: on ? null : ctx.now(),
    note: on ? null : oracleOrders ? ORDER_SAVED_BY_ORACLE : "Turned off when the run started.",
    payload,
    created_at: ctx.now(),
    can_decide: on,
    lead_stop: false,
    cannot_approve: null,
    approve_label: "Approve",
    needs_agents: [],
  };
  r.checkpoints.push(cp);
  if (snapshot) snapshot.checkpoint_id = cp.id;
  if (!on && snapshot) {
    // Rule 5: a clean order is saved by Oracle; a blocking one fails the run.
    const blocking = (s.priority_check?.problems ?? []).filter((p) => p.blocking);
    if (blocking.length) {
      r.error = `priority.yaml was rejected: ${blocking.slice(0, 5).map((p) => `[${p.code}] ${p.message}`).join("; ")}`;
      return finish(ctx, r, "failed");
    }
    decideOrder(ctx, r, cp, "approved", null);
    if (oracleOrders) tellOrderSaved(ctx, r);
  }
  if (on) r.status = "awaiting_checkpoint";
  else next(ctx, r, s);
}

/** Tests: a count of runs every check reports it could not read. */
export const MOCK_TICK_ERRORS_KEY = "po-mock-tick-errors";

function tick(ctx: RunsContext): Schemas["TickOut"] {
  const out = {
    runs_checked: 0,
    segments_finished: 0,
    runs_advanced: 0,
    runs_paused: 0,
    errors: [] as string[],
    member_follow_ups: 0,
  };
  // Decisions recorded and not delivered yet: SwarmCloud takes them now, and the run goes on
  // (its next segment runs from the next tick).
  const delivered = new Set<string>();
  for (const r of ctx.db.runs) {
    const owed = r.checkpoints.find((c) => c.delivery);
    if (!owed) continue;
    const wait = { ...((owed.payload.wait as Record<string, unknown> | undefined) ?? {}) };
    delete wait.posting;
    Object.assign(owed, { delivery: null, payload: { ...owed.payload, wait } });
    const s = r.segments.find((x) => x.seq === owed.segment_seq)!;
    if (owed.status === "approved") next(ctx, r, s);
    else submit(ctx, r, s, owed.note);
    startedInCheck(ctx, r);
    refresh(r);
    delivered.add(r.id);
    out.runs_checked += 1;
  }
  for (const r of ctx.db.runs) {
    if (r.status !== "running" || delivered.has(r.id)) continue;
    // E1: a draft's items run is finished by the draft roadmap's own tick (./draft-roadmap.ts).
    if (r.flow === DRAFT_ITEMS_FLOW) continue;
    out.runs_checked += 1;
    if (ctx.slowAgents && agentsWorking(ctx, r)) continue;
    if (r.waiting_for) {
      // F4 lane B, as the API re-checks each tick: the version's roadmap items are ready
      // now, so the Engineering dates step starts (a workflow of its own).
      const waiting = r.segments.find((x) => x.status === "pending" && x.name === "eng_dates");
      r.waiting_for = null;
      if (waiting) submit(ctx, r, waiting);
      refresh(r);
      continue;
    }
    const done = finishRunning(ctx, r);
    if (done === "none") continue;
    out.segments_finished += 1;
    if (done === "paused") out.runs_paused += 1;
    else out.runs_advanced += 1;
    startedInCheck(ctx, r);
  }
  // Tests: runs the check could not read (the API lists each with its error).
  const failing = typeof localStorage === "undefined" ? null : localStorage.getItem(MOCK_TICK_ERRORS_KEY);
  if (failing) for (let i = 0; i < Number(failing); i++) out.errors.push(`run ${i + 1}: SwarmCloud did not answer`);
  return out;
}

/** #258: a segment that started during this check shows what the check read of its agents. */
function startedInCheck(ctx: RunsContext, r: RunOut) {
  const s = r.segments.find((x) => x.status === "running");
  if (!s || s.checked_at) return;
  if (ctx.slowAgents) agentsWorking(ctx, r);
  else s.checked_at = ctx.now();
}

/** #258 "slow-agents": the first tick of a running segment reads its agents working; true if it did. */
function agentsWorking(ctx: RunsContext, r: RunOut): boolean {
  const s = r.segments.find((x) => x.status === "running");
  if (!s || s.checked_at) return false;
  const each = round2(((s.estimate_usd ?? 0) / 3) / Math.max(s.roles.length, 1));
  const now = ctx.now();
  s.agents = s.roles.map((role) => ({ role, state: "running", started_at: s.started_at, heartbeat_at: now, cost_usd: each }));
  s.checked_at = now;
  const a = s.attempts[s.attempts.length - 1];
  a.cost_usd = round2(each * s.roles.length);
  s.cost_usd = round2(s.attempts.reduce((sum, x) => sum + x.cost_usd, 0));
  refresh(r);
  return true;
}

/** The agents finish the run's running segment (at 90% of its estimate), and the run goes on. */
function finishRunning(ctx: RunsContext, r: RunOut): "none" | "paused" | "advanced" {
  const s = r.segments.find((x) => x.status === "running");
  if (!s) return "none";
  const a = s.attempts[s.attempts.length - 1];
  a.cost_usd = round2((s.estimate_usd ?? 0) * 0.9);
  a.state = "succeeded";
  s.cost_usd = round2(s.attempts.reduce((sum, x) => sum + x.cost_usd, 0));
  s.status = "succeeded";
  s.finished_at = ctx.now();
  Object.assign(s, { agents: [], checked_at: null });
  refresh(r);
  if (r.overrun_ceiling_usd != null && r.spent_usd > r.overrun_ceiling_usd) {
    r.status = "paused_overrun";
    return "paused";
  }
  advance(ctx, r, s);
  refresh(r);
  return "advanced";
}

/** E1 part B: the draft items a Build roadmap run's items step reuses, unless it derives them again. */
function itemsReuse(ctx: RunsContext, r: RunOut) {
  if (r.flow !== "prd_to_roadmap" || r.knobs.reuse_draft_items === false || !r.source) return null;
  return ctx.draftItemsToReuse?.(r.source.document_id, r.source.version) ?? null;
}

type ItemsReused = { version: number; ready_at: string | null };

/** The draft items the run's estimate reused (the API's draft_items_reused knob): Start uses them. */
const estimated = (r: RunOut) => r as RunOut & { draft_items_reused?: ItemsReused | null };

/** As the API: a run estimated with reused draft items still has the same ones at start (else 409). */
function itemsChanged(ctx: RunsContext, r: RunOut): Response | null {
  const knob = estimated(r).draft_items_reused;
  if (!knob || JSON.stringify(itemsReuse(ctx, r)) === JSON.stringify(knob)) return null;
  return fail(409, "the PRD version's draft roadmap items changed since the estimate: estimate the run again");
}

/** "Reused: the roadmap items of v3, derived 20 Oct", as the API: the Company time zone's day. */
function itemsReusedNote(reuse: ItemsReused) {
  const on = reuse.ready_at ? monthDay(reuse.ready_at).split(" ").reverse().join(" ") : null;
  return `Reused: the roadmap items of v${reuse.version}${on ? `, derived ${on}` : ""}`;
}

function launch(ctx: RunsContext, r: RunOut) {
  r.started_at = ctx.now();
  r.overrun_ceiling_usd = round2((r.estimate_usd ?? 0) * FACTOR);
  for (const s of r.segments.filter(skippedOff)) Object.assign(s, { status: "skipped", cost_usd: 0, estimate_usd: 0, note: OFF_NOTE, finished_at: ctx.now() });
  const reused = reusedReview(r);
  const first = r.segments[0];
  if (reused && first?.name === "baseline") {
    // C4: the reused baseline segment runs no step and costs nothing; its stop is skipped.
    const on = monthDay(reused.approved_at);
    Object.assign(first, { status: "skipped", cost_usd: 0, estimate_usd: 0, reused, note: `Reused the baseline approved ${on}`, started_at: ctx.now(), finished_at: ctx.now() });
    r.checkpoints.push({
      id: ctx.uuid(), run_id: r.id, kind: "baseline_confirm", status: "skipped", approver_role: "approver",
      segment_seq: first.seq, decided_by: null, decided_at: ctx.now(), note: `Reused the baseline approved ${on}`, payload: {},
      created_at: ctx.now(), can_decide: false, lead_stop: false, cannot_approve: null, approve_label: "Approve", needs_agents: [],
    });
    submit(ctx, r, r.segments[1]);
    return;
  }
  const items = estimated(r).draft_items_reused;
  if (items && first?.name === "roadmap_items") {
    // E1 part B: the items step runs nothing and costs nothing; its stop opens at once.
    Object.assign(first, { status: "succeeded", cost_usd: 0, estimate_usd: 0, note: itemsReusedNote(items), started_at: ctx.now(), finished_at: ctx.now() });
    first.attempts.push({ attempt: first.attempts.length + 1, workflow_id: null, submitted_at: ctx.now(), cost_usd: 0, note: null, state: "succeeded" });
    r.status = "running";
    advance(ctx, r, first);
    return;
  }
  submit(ctx, r, first);
}

function inbox(ctx: RunsContext): Schemas["InboxOut"] {
  const mine = (c: CheckpointOut, r: RunOut) => !ctx.mayDecide || ctx.mayDecide(c, r.flow);
  const checkpoints = ctx.db.runs.flatMap((r) =>
    r.checkpoints
      .filter((c) => c.status === "pending" && mine(c, r))
      .map((c) => ({
        ...gated(ctx, c),
        // As the API's may_decide: by the stop's role (an engineering stop as `mine` says).
        can_decide: ctx.userRole == null || atLeast(ctx.userRole, c.approver_role) || (!!ctx.mayDecide && ENGINEERING_KINDS.includes(c.kind)),
        flow: r.flow,
        flow_title: r.flow_title,
        document_slug: r.document_slug,
        document_title: docTitle(ctx, r),
        segment_title: r.segments.find((s) => s.seq === c.segment_seq)?.title ?? null,
        // D9: what it needs of me and how much, from the same review read.
        summary: inboxSummary(ctx, r, c),
      })),
  ).filter((c) => c.can_decide); // qa-company-4: as the API's inbox, only the stops I may decide.
  // Decided, not delivered to the run yet: shown, nothing to decide, not in the total.
  const deliveries = ctx.db.runs.flatMap((r) =>
    r.checkpoints
      .filter((c) => c.delivery && !r.segments.some((s) => sentBack(r, s)) && mine(c, r))
      .map((c) => ({
        ...c,
        can_decide: false,
        flow: r.flow,
        flow_title: r.flow_title,
        document_slug: r.document_slug,
        document_title: docTitle(ctx, r),
        segment_title: r.segments.find((s) => s.seq === c.segment_seq)?.title ?? null,
      })),
  );
  // The inbox embeds summaries without their progress, as the API does.
  const bare = (r: RunOut) => ({ ...summary(r), document_title: docTitle(ctx, r), progress: null, delivering: null });
  // qa-company-4: as the API, cost approvals and overruns wait on owners only.
  const owner = ctx.userRole == null || ctx.userRole === "owner";
  const approvals = owner ? ctx.db.runs.filter((r) => r.status === "awaiting_approval").map(bare) : [];
  const overruns = owner ? ctx.db.runs.filter((r) => r.status === "paused_overrun").map(bare) : [];
  const byDoc = new Map<string, FeedbackRow[]>();
  for (const f of ctx.feedback.filter((x) => x.status === "open" && !ctx.staged?.(x.id)).sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    byDoc.set(f.document_id, [...(byDoc.get(f.document_id) ?? []), f]);
  }
  const feedback = [...byDoc.entries()].flatMap(([docId, items]) => {
    const d = ctx.documents.find((x) => x.id === docId);
    if (!d) return [];
    const status = (f: FeedbackRow) => ctx.suggestionStatus?.(f.id) ?? null;
    // As the API: what each open item waits for, and the first one in the review panel's order.
    const counts = { suggestions: 0, accepted: 0, comments: 0, verdicts: 0, other: 0 };
    for (const f of items) {
      const s = status(f);
      counts[
        s === "open" ? "suggestions" : s === "accepted" ? "accepted" : f.kind === "comment" ? "comments" : f.kind === "section_review" ? "verdicts" : "other"
      ]++;
    }
    const first = items
      .filter((f) => f.section_key)
      .sort((a, b) => a.raised_on_version - b.raised_on_version || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
    return [
      {
        document_id: d.id,
        slug: d.slug,
        title: d.title,
        latest_version: ctx.latestVersion(d.id),
        open_count: items.length,
        counts,
        first_section_key: first?.section_key ?? null,
        items: items.slice(0, 5).map((f) => ({
          id: f.id,
          summary: f.summary,
          kind: f.kind,
          section_key: f.section_key ?? null,
          raised_on_version: f.raised_on_version,
          created_at: f.created_at,
          state: "open" as const,
          staged_for_agents: false,
          suggestion_status: status(f),
        })),
      },
    ];
  });
  // Runs whose output Oracle stopped trying to import (owners: Retry).
  const imports = ctx.db.runs.filter((r) => r.can_retry_import && !FINAL.includes(r.status)).map((r) => ({ ...summary(r), document_title: docTitle(ctx, r) }));
  // Owners only: runs that finished with no document (owner, 2026-10-25).
  const finished = ctx.userRole === "owner" || ctx.userRole == null ? ctx.db.runs.filter((r) => r.status === "succeeded") : [];
  for (const r of finished) refresh(r);
  const no_documents = finished.flatMap((r) => {
    const why = noDocument(ctx, r);
    return why ? [{ ...summary(r), document_title: docTitle(ctx, r), no_document: why }] : [];
  });
  // Runs that wait on their owner (stuck: Retry, Stop cancelling, Retry lookup, Cancel again,
  // Dismiss), and work given up on that is still looked for (shown only, not in the total).
  const lookups = ctx.db.runs.filter((r) => r.stuck).map((r) => ({ ...summary(r), document_title: docTitle(ctx, r) }));
  const searches = ctx.db.runs.filter((r) => r.searching).map((r) => ({ ...summary(r), document_title: docTitle(ctx, r) }));
  // Refused drafts Oracle sent back to the writer itself, being revised: the review's state,
  // shown only (nothing to decide, not in the total).
  const revising = ctx.db.runs.filter((r) => r.segments.some((s) => sentBack(r, s))).map(bare);
  return {
    // Launch rows (H6) are added by the server (./launches.ts); date rows (F3) too.
    launches: [],
    // A5: access request rows are added by the server (./server.ts).
    access_requests: [],
    // Simple S8: minutes sent to me as an attendee (./simple-meetings.ts adds them).
    simple_minutes: [],
    // H10 request rows: none in the mock yet (lane 2 adds the requests-why-not scenario).
    requests: [],
    // INT2: intakes Oracle couldn't read twice in a row; none in the mock yet (lane 2 adds them).
    intake_reads: [],
    // Simple S3a: proposals and decisions on them are added by the server (./simple-changes.ts).
    simple_proposals: [],
    simple_decisions: [],
    simple_approvals: [],
    dates: [],
    // Track rows (F2) are added by the server (./roadmap.ts).
    tracks: [],
    // Ritual rows (H2): the mock has no rituals yet (the UI lane adds them); outcome rows (H3) are added by ./quality.ts.
    rituals: [],
    outcomes: [],
    // Metric rows (H5): the mock has no metrics yet (the UI lane adds them).
    metrics: [],
    // G6: discussion rows are added by the server (./discussions.ts).
    discussions: [],
    checkpoints,
    deliveries,
    approvals,
    // The decision log's rows are added by the server (./decisions.ts).
    decisions: [],
    overruns,
    lookups,
    searches,
    revising,
    imports,
    no_documents,
    feedback,
    revoke_failures: [],
    // O5: share links Oracle revoked with their creator or document (owners); none here.
    share_revocations: [],
    access_failures: [],
    // The weekly alignment reports and their failed posts: the server adds them (./reports.ts).
    reports: [],
    report_failures: [],
    oracle_actions: [],
    // Every new or open item (C1e, 2026-10-20): the server adds the feedback items' New + Open (./next-draft.ts).
    total: checkpoints.length + approvals.length + overruns.length + lookups.length + imports.length + no_documents.length,
    // Feedback states (C1e) are added by the server, which holds the suggestions (./next-draft.ts).
    items: [],
    counts: { new: 0, open: 0, staged: 0, declined: 0, done: 0 },
    staged: [],
    needs_me: 0,
    last_seen_at: null,
  };
}

/** Handles /v1/flows, /v1/runs/*, /v1/inbox and /v1/internal/tick; null for anything else. */
export async function routeRuns(ctx: RunsContext, req: Request, p: string[]): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "flows" && m === "GET") return json(200, flowCatalog());
  if (p[1] === "inbox" && m === "GET") return json(200, inbox(ctx));
  if (p[1] === "internal" && p[2] === "tick" && m === "POST") return json(200, tick(ctx));
  // C6: the document's approved PRD scope, by id or slug (a new PRD's run names it by slug).
  if (p[1] === "documents" && p.length === 4 && p[3] === "scope" && m === "GET") {
    const doc = ctx.documents.find((d) => d.id === p[2] || d.slug === p[2]);
    const ofDoc = (x: PrdScopeOut) => {
      const run = ctx.db.runs.find((y) => y.id === x.run_id);
      return (!!doc && (x.document_id === doc.id || run?.document_id === doc.id)) || run?.document_slug === p[2] || x.document_id === p[2];
    };
    const found = Object.values(ctx.db.scopes ?? {})
      .flat()
      .filter((x) => x.status === "approved" && ofDoc(x))
      .sort((a, b) => (b.approved_at ?? "").localeCompare(a.approved_at ?? ""))[0];
    return found ? json(200, found) : fail(404, `document ${p[2]} has no approved PRD scope`);
  }
  // C7: the feature-set stop's rows (./scope.ts), and a run's latest scope.
  const scoped = await routeScopes(ctx, req, p);
  if (scoped) return scoped;
  if (p[1] !== "runs") return null;

  if (p.length === 2 && m === "GET") {
    const status = new URL(req.url).searchParams.get("status");
    return json(
      200,
      ctx.db.runs
        .filter((r) => !status || r.status === status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((r) => {
          // As the API: the row's Decide follows the run page's can_decide for its waiting checkpoint.
          const cp = r.checkpoints.find((c) => c.status === "pending");
          return { ...summary(r), document_title: docTitle(ctx, r), can_decide: !!cp && mayStage(ctx, r, cp, ctx.userRole ?? null) };
        }),
    );
  }
  if (p.length === 2 && m === "POST") {
    const input = await body<Schemas["RunCreate"]>();
    const flow = flowOf(input.flow);
    // H8: only an owner drafts an update.
    if (input.flow === "update_draft" && ctx.userRole !== "owner") return fail(403, "Only an owner can draft an update");
    // H9: approvers and owners draft a pricing memo.
    if (input.flow === "pricing_memo" && ctx.userRole !== "owner" && ctx.userRole !== "approver") return fail(403, "Requires the approver role");
    const knobs = resolveKnobs(input.flow, input.knobs);
    if (typeof knobs === "string") return fail(422, knobs);
    const goals = targetGoals(ctx, input.flow, input.knobs?.goals);
    if (typeof goals === "string") return fail(422, goals);
    knobs.goals = goals ?? [];
    const refused = buildUnderWay(ctx, input.flow);
    if (refused) return refused;
    // A flow that writes no document names none, reads none and takes no template.
    const noDocument = !flow.writes_document;
    if (noDocument && [input.document, input.source, input.source_version, input.template, input.theme].some((v) => v != null)) {
      return fail(422, `the ${flow.title} flow writes no document`);
    }
    const find = (ref: string) => ctx.documents.find((d) => d.slug === ref || d.id === ref);
    // C4: a Baseline to PRD run takes a PRD template; the feedback loop still refuses one.
    const templated = flow.target_kind === "roadmap" || input.flow === "baseline_to_prd";
    if (!templated && (input.template || input.theme)) return fail(422, `the ${flow.title} flow takes no template or theme`);
    // prd_to_roadmap reads an approved PRD version (422 when there is none).
    let source: VersionSource | null = null;
    if (flow.source_kind) {
      const name = KIND_NAME[flow.source_kind];
      if (!input.source) return fail(422, `name the approved ${name} to build from`);
      const from = find(input.source);
      if (!from) return fail(422, `document '${input.source}' not found`);
      if (from.kind !== flow.source_kind) return fail(422, `document '${input.source}' is a ${KIND_NAME[from.kind]}, not a ${name}`);
      const found = ctx.sourceVersion(from.id, input.source_version ?? null);
      if (typeof found === "string") return fail(422, found);
      source = found;
    } else if (input.source || input.source_version != null) {
      return fail(422, `the ${flow.title} flow reads no source document`);
    }
    // "<prd>-roadmap": that roadmap's next version, or a new roadmap.
    let ref = input.document;
    if (!ref && source) {
      const base = `${source.slug}-roadmap`;
      ref = base;
      for (let n = 2; find(ref) && find(ref)!.kind !== flow.target_kind; n++) ref = `${base}-${n}`;
    }
    if (!ref && !noDocument) return fail(422, "name the PRD: an existing document, or a new slug to create");
    const doc = ref ? find(ref) : undefined;
    if (flow.requires_document && !doc) return fail(422, `document '${ref}' not found`);
    if (input.flow === "pricing_memo" && doc && doc.kind !== "pricing") {
      return fail(422, `document '${ref}' is a ${KIND_NAME[doc.kind]}; the ${flow.title} flow drafts a pricing memo`);
    }
    if (input.flow === "strategy_draft" && doc && doc.kind !== "vision" && doc.kind !== "strategy") {
      return fail(422, `document '${ref}' is a ${KIND_NAME[doc.kind]}; the ${flow.title} flow drafts a vision or a product strategy`);
    }
    // As the API (oracle.strategy.brief): the brief from Company › Strategy fits its document.
    const brief = input.strategy_brief;
    if (brief) {
      if (input.flow !== "strategy_draft" || !doc) return fail(422, "only a Vision or strategy draft run takes a brief");
      if (doc.kind === "vision" && (brief.horizon_from || brief.horizon_to)) return fail(422, "a vision's horizon is in years");
      if (doc.kind === "strategy" && brief.horizon_years != null) return fail(422, "a product strategy's horizon is its dates");
      if (brief.horizon_from && brief.horizon_to && brief.horizon_to <= brief.horizon_from) return fail(422, "the horizon ends before it starts");
      if (brief.from_approved && typeof ctx.sourceVersion(doc.id, null) === "string") {
        return fail(422, `the ${KIND_NAME[doc.kind]} has no approved version to start from`);
      }
    }
    const observing = doc ? ctx.draftRefusal?.(input.flow, doc.kind) : null;
    if (observing) return fail(409, observing);
    if (doc && flow.target_kind && doc.kind !== flow.target_kind) {
      return fail(422, `document '${ref}' is a ${KIND_NAME[doc.kind]}, not a ${KIND_NAME[flow.target_kind]}`);
    }
    const roadmap = flow.target_kind === "roadmap";
    const run: RunOut = {
      id: ctx.uuid(),
      flow: input.flow,
      flow_title: flow.title,
      status: "draft",
      document_id: doc?.id ?? null,
      document_slug: doc?.slug ?? ref ?? null,
      document_kind: doc?.kind ?? flow.target_kind ?? null,
      source,
      template: roadmap ? (input.template ?? doc?.template ?? ROADMAP_DEFAULTS.template) : templated ? (input.template ?? doc?.template ?? PRD_DEFAULT_TEMPLATE) : null,
      theme: roadmap ? (input.theme ?? doc?.theme ?? ROADMAP_DEFAULTS.theme) : templated ? (input.theme ?? doc?.theme ?? null) : null,
      estimate_usd: null,
      spent_usd: 0,
      created_by: ctx.userId,
      created_at: ctx.now(),
      started_at: null,
      finished_at: null,
      waiting_on: null,
      error: null,
      can_retry: false,
      can_stop_cancelling: false,
      can_retry_lookup: false,
      cancel_again: [],
      can_dismiss_overrun: false,
      can_decide: false,
      can_retry_import: false,
      knobs,
      snapshot_id: null,
      snapshot_as_of: null,
      approved_by: null,
      approved_at: null,
      needs_approval: false,
      overrun_ceiling_usd: null,
      runtime: "fake",
      notes: FLOW_CATALOG.runtime_notes,
      note_refs: [],
      segments: segmentsFor(input.flow, knobs, ctx.uuid),
      checkpoints: [],
      token_read_only: false,
      open_proposals: 0,
    };
    ctx.db.runs.push(run);
    return json(201, run);
  }

  const r = ctx.db.runs.find((x) => x.id === p[2]);
  if (!r) return fail(404, `run ${p[2]} not found`);
  const done = (status = 200) => {
    refresh(r);
    // As the API: a checkpoint is decided by its approver role or above; an engineering stop
    // by the engineering leads and owners once one is named (A3, ctx.mayDecide).
    const checkpoints = r.checkpoints.map((c) => ({
      ...gated(ctx, c),
      can_decide:
        c.can_decide &&
        (ctx.mayDecide && ENGINEERING_KINDS.includes(c.kind) ? ctx.mayDecide(c, r.flow) : atLeast(ctx.userRole, c.approver_role)),
      // B6: Oracle offers a goals interview once the baseline is approved; it starts nothing itself.
      ...(c.kind === "baseline_confirm" && c.status === "approved" && ctx.vagueGoals ? { vague_goals: ctx.vagueGoals() } : {}),
      lead_stop: !!ctx.leadStop?.(c, r.flow),
    }));
    // As the API (#556, #561 review): stored errors read in words, a failed one in the past.
    const segments = r.segments.map((s) => (s.error ? { ...s, error: readableRefusal(s.error, s.status === "failed") } : s));
    const can_decide = checkpoints.some((c) => c.status === "pending" && c.can_decide);
    return json(status, { ...r, document_title: docTitle(ctx, r), error: readableRefusal(r.error, r.status === "failed"), segments, checkpoints, can_decide, open_proposals: ctx.openProposals?.(r.id) ?? 0 });
  };

  if (p.length === 3 && m === "GET") return done();
  if (p.length === 4 && p[3] === "scope" && m === "GET") {
    // C6: the run's latest scope, any status.
    const latest = [...(ctx.db.scopes?.[r.id] ?? [])].sort((a, b) => a.segment_seq - b.segment_seq || a.attempt - b.attempt).pop();
    return latest ? json(200, latest) : fail(404, `run ${r.id} has no PRD scope`);
  }
  if (p.length === 3 && m === "PATCH") {
    if (r.status !== "draft") return fail(409, "only a draft run can be changed");
    const patch = await body<Schemas["RunPatch"]>();
    if (patch.knobs) {
      const knobs = resolveKnobs(r.flow, patch.knobs);
      if (typeof knobs === "string") return fail(422, knobs);
      const goals = targetGoals(ctx, r.flow, patch.knobs.goals);
      if (typeof goals === "string") return fail(422, goals);
      knobs.goals = goals ?? r.knobs.goals ?? [];
      // As the API: an omitted reuse_draft_items keeps the run's choice.
      if (r.flow === "prd_to_roadmap" && patch.knobs.reuse_draft_items == null) knobs.reuse_draft_items = r.knobs.reuse_draft_items;
      r.knobs = knobs;
    }
    if (patch.document) {
      const doc = ctx.documents.find((d) => d.slug === patch.document || d.id === patch.document);
      r.document_id = doc?.id ?? null;
      r.document_slug = doc?.slug ?? patch.document;
    }
    if (r.document_kind === "roadmap" || r.flow === "baseline_to_prd") {
      if (patch.template) r.template = patch.template;
      if (patch.theme) r.theme = patch.theme;
    }
    r.segments = segmentsFor(r.flow, r.knobs, ctx.uuid);
    r.estimate_usd = null;
    // As the API: what the run reuses is decided again by its next estimate.
    estimated(r).draft_items_reused = null;
    r.needs_approval = false;
    return done();
  }

  const action = p[3];
  if (action === "estimate" && m === "POST") {
    if (r.status !== "draft") return fail(409, "only a draft run can be estimated");
    const stale = notReusable(r);
    if (stale) return stale;
    // C4: a reused baseline segment does not run, so it costs nothing.
    const reused = reusedReview(r);
    // E1 part B: a Build roadmap run reusing the draft items runs no items step.
    const items = itemsReuse(ctx, r);
    estimated(r).draft_items_reused = items;
    const free = (name: string) => (!!reused && name === "baseline") || (!!items && name === "roadmap_items");
    for (const s of r.segments) s.estimate_usd = free(s.name) || skippedOff(s) ? 0 : segEstimate(s.roles, r.knobs.depth);
    const total = round2(r.segments.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0));
    r.estimate_usd = total;
    r.needs_approval = total > THRESHOLD;
    const budget = r.knobs.budget_usd ?? null;
    return json(200, {
      run_id: r.id,
      depth: r.knobs.depth,
      total_usd: total,
      segments: r.segments.map((s) => {
        const skip = !!reused && s.name === "baseline";
        const fromDraft = items && s.name === "roadmap_items" ? items : null;
        return {
          seq: s.seq, name: s.name, title: s.title, roles: s.roles, estimate_usd: s.estimate_usd ?? 0, reused: skip || !!fromDraft,
          reused_from_version: fromDraft?.version ?? null,
          note: skip && reused ? `Current baseline, approved ${monthDay(reused.approved_at)}` : fromDraft ? itemsReusedNote(fromDraft) : skippedOff(s) ? OFF_NOTE : null,
        };
      }),
      approval_threshold_usd: THRESHOLD,
      needs_approval: total > THRESHOLD,
      budget_usd: budget,
      within_budget: budget == null || total <= budget,
    } satisfies Schemas["EstimateOut"]);
  }
  if (action === "start" && m === "POST") {
    if (r.status !== "draft") return fail(409, `run is ${r.status}, not a draft`);
    if (r.estimate_usd == null) return fail(409, "estimate the run first");
    const stale = notReusable(r) ?? itemsChanged(ctx, r);
    if (stale) return stale;
    const refused = buildUnderWay(ctx, r.flow);
    if (refused) return refused;
    if (r.knobs.budget_usd != null && r.estimate_usd > r.knobs.budget_usd) return fail(422, "the estimate is over the budget");
    r.snapshot_id = ctx.uuid();
    r.snapshot_as_of = ctx.now();
    if (r.estimate_usd > THRESHOLD) r.status = "awaiting_approval";
    else launch(ctx, r);
    // H8, H9: the local runtime writes an update or pricing memo draft at once, so it opens on it.
    if ((r.flow === "update_draft" || r.flow === "pricing_memo") && (r.status as RunOut["status"]) === "running") finishRunning(ctx, r);
    return done();
  }
  if (action === "approve" && m === "POST") {
    if (r.status !== "awaiting_approval") return fail(409, `run is ${r.status}, not awaiting approval`);
    const changed = itemsChanged(ctx, r);
    if (changed) return changed;
    r.approved_by = ctx.userId;
    r.approved_at = ctx.now();
    launch(ctx, r);
    return done();
  }
  if (action === "resume" && m === "POST") {
    if (r.status !== "paused_overrun") return fail(409, `run is ${r.status}, not paused on overrun`);
    r.overrun_ceiling_usd = round2(r.spent_usd + (r.estimate_usd ?? 0) * (FACTOR - 1));
    r.status = "running";
    const last = [...r.segments].reverse().find((s) => s.status === "succeeded");
    if (!r.segments.some((s) => s.status === "running") && last && !r.checkpoints.some((c) => c.segment_seq === last.seq)) {
      advance(ctx, r, last);
    }
    return done();
  }
  if (action === "cancel" && m === "POST") {
    if (FINAL.includes(r.status)) return fail(409, `run is already ${r.status}`);
    for (const s of r.segments) if (s.status === "running" || s.status === "pending") s.status = "cancelled";
    for (const c of r.checkpoints) {
      if (c.status === "pending") Object.assign(c, { status: "skipped", note: "Run cancelled.", decided_at: ctx.now() });
    }
    finish(ctx, r, "cancelled");
    // A run cancelled from the Inbox no longer waits on its lost submission or its 404s.
    Object.assign(r, { can_retry: false, can_stop_cancelling: false, can_retry_lookup: false, stuck: null, queue_wait: null });
    // Nothing waits in SwarmCloud's queue once the run ended (api: queue_wait is a running run's).
    for (const s of r.segments) s.queue_wait = null;
    return done();
  }
  if (action === "retry" && m === "POST") {
    if (!r.can_retry) return fail(409, "nothing to retry: no lost submission of this run is past the lookup cap");
    Object.assign(r, { can_retry: false, stuck: null });
    return done();
  }
  if (action === "stop-cancelling" && m === "POST") {
    if (!r.can_stop_cancelling) return fail(409, "nothing to stop: no cancel of this run waits on SwarmCloud's 404s");
    Object.assign(r, { can_stop_cancelling: false, stuck: null });
    if (!FINAL.includes(r.status)) {
      // P3d: Stop cancelling on a run that has not ended ends it.
      for (const s of r.segments) if (s.status === "running" || s.status === "pending") s.status = "cancelled";
      for (const c of r.checkpoints) {
        if (c.status === "pending") Object.assign(c, { status: "skipped", note: "Run ended: an approver stopped cancelling its workflow.", decided_at: ctx.now() });
      }
      finish(ctx, r, "cancelled");
      r.error = "Stop cancelling ended the run: its spend still counts on the run until SwarmCloud stops it.";
    }
    return done();
  }
  if (action === "retry-lookup" && m === "POST") {
    if (!r.can_retry_lookup) return fail(409, "nothing to look up: no workflow of this run has an unknown cost");
    Object.assign(r, { can_retry_lookup: false, stuck: null });
    return done();
  }
  if (action === "retry-import" && m === "POST") {
    if (!r.can_retry_import) return fail(409, "nothing to retry: no import of this run has stopped");
    for (const s of r.segments) if (s.status === "failed") Object.assign(s, { status: "succeeded", error: null });
    Object.assign(r, { can_retry_import: false, import_failed: null });
    return done();
  }
  if (action === "cancel-again" && m === "POST") {
    const { workflow_id } = await body<Schemas["CancelAgain"]>();
    if (!(r.cancel_again ?? []).includes(workflow_id)) {
      // #396: the refusal a person reads names no workflow id; the id stays in refs, as in the API.
      return json(409, { detail: "nothing to cancel again: that workflow is not one Oracle stopped cancelling for this run", refs: { workflow: workflow_id } });
    }
    r.cancel_again = (r.cancel_again ?? []).filter((w) => w !== workflow_id);
    return done();
  }
  if (action === "dismiss-overrun" && m === "POST") {
    if (!r.can_dismiss_overrun) return fail(409, "nothing to dismiss: no overrun of this run is shown, or a workflow of it is still read");
    Object.assign(r, { can_dismiss_overrun: false, stuck: null });
    return done();
  }
  if (action === "checkpoints" && p[5] === "review.yaml" && m === "GET") {
    const cp = r.checkpoints.find((c) => c.id === p[4]);
    if (!cp) return fail(404, `checkpoint ${p[4]} not found`);
    if (cp.status === "pending" || !cp.review || cp.review.kind === "edits") return fail(404, "no review was sent back at this checkpoint");
    return new Response(renderReview(cp.review, cp.decided_at), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (action === "checkpoints" && p[4] && p[5] !== "decide") {
    const cp = r.checkpoints.find((c) => c.id === p[4]);
    if (!cp) return fail(404, `checkpoint ${p[4]} not found`);
    return routeDraft(ctx, r, cp, req, p.slice(5));
  }
  if (action === "checkpoints" && p[5] === "decide" && m === "POST") {
    const cp = r.checkpoints.find((c) => c.id === p[4]);
    if (!cp) return fail(404, "checkpoint not found");
    if (cp.status === "approved" || cp.status === "changes_requested") {
      // A recorded decision is final, delivered to the run or not yet.
      return fail(409, `already decided: this checkpoint is ${cp.status.replace("_", " ")}; a recorded decision is final`);
    }
    if (cp.status !== "pending" || r.status !== "awaiting_checkpoint") return fail(409, `checkpoint is ${cp.status}`);
    if (!mayStage(ctx, r, cp, ctx.userRole ?? null)) return fail(403, ENGINEERING_KINDS.includes(cp.kind) && ctx.mayDecide ? LEAD_ONLY : `Requires the ${cp.approver_role} role`);
    // H8: an update's review stop is an owner's to decide.
    if (cp.approver_role === "owner" && ctx.userRole !== "owner") return fail(403, "Only an owner can decide this stop");
    // D10: a run review's Approve draft and Send back are the designated decider's.
    const decider = ctx.reviewDecider?.(cp);
    if (decider && decider !== ctx.member?.id) return fail(403, "Only the designated decider decides this run review");
    const { decision, note, expected_revision } = await body<Schemas["CheckpointDecision"]>();
    const draft = draftOf(ctx, cp.id);
    const changedBy = ctx.reviewChange?.();
    if (changedBy) bump(draft, displayName(changedBy));
    if (expected_revision != null && expected_revision !== draft.revision) return json(409, { detail: reviewChanged(draft, expected_revision) });
    const blocked = cannotApprove(cp);
    if (decision === "approved" && blocked) return fail(409, blocked);
    // D7: split, merge and open questions need the agents; Approve waits until they are removed.
    const agents = decision === "approved" ? needsAgentsOf(cp, draft.actions) : [];
    if (agents.length) return json(409, { detail: { code: "needs_agents", message: needsAgentsMessage(agents), actions: agents.map((x) => x.action_id) } });
    const edits = decision === "approved" ? editsOf(cp, draft.actions) : [];
    // W5: confirming a console approval decides it as an approval (the console's MERGE).
    const confirming = decision === "confirm" && cp.console?.needs === "confirm" && cp.console.verdict === "MERGE";
    if (decision === "confirm" && !confirming) return fail(422, "nothing recorded in SwarmCloud's console waits to be confirmed here");
    // W5: a console approval applies no staged edits, so its gate reads none.
    const gate = gateNow(ctx, cp, draft.actions, !confirming);
    if ((decision === "approved" || confirming) && gate && !gate.open) {
      const n = gate.blocking_open + gate.file_problems;
      if (edits.length) {
        // D7: re-checked after the edits; nothing changes (the edits stay staged).
        const what = gate.left.map((x) => `${x.item_title ?? x.item}: ${x.label}`).join("; ");
        const message = `After the edits, ${n} blocking problem${n === 1 ? " is" : "s are"} left${what ? `: ${what}` : ""}`;
        return json(409, { detail: { code: "edits_leave_problems", message, left: gate.left } });
      }
      return json(409, { detail: { code: "blocking_open", message: gateMessage(n), left: gate.left } });
    }
    const fileKey = `${r.id}|${cp.segment_seq}|roadmap_items.yaml`;
    const edited = edits.length
      ? applyEdits(ctx.db.artifacts[fileKey] ?? "", edits, r.segments.find((x) => x.seq === cp.segment_seq)?.items_check?.reasons ?? [])
      : null;
    if (edited?.problems.length) {
      const n = edited.problems.length;
      const message = `After the edits, ${n} blocking problem${n === 1 ? " is" : "s are"} left: ${edited.problems.join("; ")}`;
      return json(409, { detail: { code: "edits_leave_problems", message, left: [] } });
    }
    // D8: the note defaults to the shared draft's.
    const general = (note ?? draft.note)?.trim() || null;
    // D4: a send-back says something: a staged action or a note.
    const staged = draft.actions.filter((a) => a.state === "staged");
    // B2: Confirm the baseline sends its staged look-again actions as one structured note.
    const text = decision === "changes_requested" ? lookAgainNote(ctx, cp, staged, general) : general;
    // D10: a run review sends back the document's own feedback; the note is optional.
    const reviewed = reviewedVersion(cp);
    if (decision === "changes_requested" && !text && reviewed && !sendBackEntries(ctx, reviewed.document_id, reviewed.version)) {
      return fail(422, "Nothing to send back: comment, request changes on a section, or write a note.");
    }
    // D4: any other send-back says something: a staged action or a note.
    // C7: a feature set's edits and adds are its rows (counted as edits), never staged actions.
    const sent = staged.filter((a) => cp.kind !== "feature_set" || (a.kind !== "edit" && a.kind !== "add"));
    const scopeEdited = cp.kind === "feature_set" ? scopeEdits(ctx.db, r.id) : 0;
    if (decision === "changes_requested" && !text && !reviewed && !sent.length && !scopeEdited) return fail(422, "Stage a change, ask a question, or write a note to send back.");
    const status = confirming ? "approved" : (decision as "approved" | "changes_requested");
    Object.assign(cp, { status, note: text, decided_by: ctx.userId, decided_at: ctx.now(), console: null });
    if (decision === "changes_requested") cp.review = reviewed ? documentReview(ctx, r, cp, reviewed, text) : buildReview(ctx, r, cp, staged, text);
    if (edited) {
      // D7: the edited file replaces the agents' (kept for ?agents=1), and its check is re-run.
      const role = ctx.userRole ?? "approver";
      const attempt = (cp.payload?.attempt as number | undefined) ?? 1;
      const header = [
        `# roadmap_items.yaml, edited at the Roadmap items checkpoint on ${ctx.now().slice(0, 10)} by ${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`,
        `# (${displayName(ctx.userName ?? "admin@example.com")}): ${edits.length} edit${edits.length === 1 ? "" : "s"} applied by Oracle; no agent ran. The agents' attempt ${attempt} is kept.`,
      ].join("\n");
      ctx.db.artifacts[`${fileKey}|agents`] = ctx.db.artifacts[fileKey];
      ctx.db.artifacts[fileKey] = `${header}\n${edited.text}`;
      cp.review = { kind: "edits", file: "roadmap_items.yaml", applied: edited.applied, revision: 1, edits: edits.length };
      const seg = r.segments.find((x) => x.seq === cp.segment_seq);
      if (seg?.items_check) {
        seg.items_check = recheck(seg.items_check, edited.text, edits);
        cp.payload = { ...cp.payload, items_check: seg.items_check };
      }
    }
    if (cp.kind === "feature_set") {
      // C7: Approve with edits writes the requirements a person added to the baseline as theirs.
      const scope = latestScope(ctx.db, r.id);
      if (status === "approved" && scope?.status === "proposed") ctx.scopeApproved?.(scope, ctx.member?.id ?? ctx.userId);
      decideScope(ctx, r, status, ctx.userId);
    }
    if (cp.kind === "priority_order" && (decision === "approved" || decision === "changes_requested")) decideOrder(ctx, r, cp, decision, ctx.userId);
    if (cp.kind === "eng_review" && decision === "approved") approveEngCheck(ctx, r, cp, staged);
    if (cp.kind === "eng_dates" && decision === "approved") approveEngDates(cp, staged);
    cp.payload = { ...cp.payload, decided: { role: ctx.userRole ?? null, via: confirming ? "swarmcloud_console" : "oracle" } };
    if (ctx.undelivered) {
      // Recorded, and final; SwarmCloud did not take it: the tick delivers it.
      const at = ctx.now();
      const error = "SwarmCloud HTTP 503 unavailable";
      cp.payload = { ...cp.payload, wait: { ...((cp.payload.wait as object | undefined) ?? {}), posting: { redo: false, at, tries: 1, error, tried_at: at } } };
      cp.delivery = { decided_by_name: ctx.userName ?? null, since: at, tries: 1, last_error: error, last_tried_at: at };
      refresh(r);
      return fail(
        503,
        "SwarmCloud did not confirm the decision (SwarmCloud refused POST /v1/workflows/mock-wf/steps/review/answer: HTTP 503 unavailable); " +
          "the decision is recorded and Oracle posts it again on its next tick, there is no need to decide again",
      );
    }
    const s = r.segments.find((x) => x.seq === cp.segment_seq)!;
    if (status === "approved") next(ctx, r, s);
    else submit(ctx, r, s, text ?? (reviewed ? "Sent back with the document's feedback." : null));
    return done();
  }
  if (action === "segments" && p[5] === "retry-draft-import" && m === "POST") {
    const s = r.segments.find((x) => x.seq === Number(p[4]));
    if (!s) return fail(404, `run ${r.id} has no segment ${p[4]}`);
    refresh(r);
    const review = reviewOf(r, s) ?? finishedReview(r, s);
    if (!s.can_retry_draft_import || !review || !r.document_slug) {
      const version = r.status === "succeeded" ? runVersion(r) : null;
      return fail(409, `nothing to retry: ${version ? oneVersion(version) : `no refused draft of ${s.name} waits at its review`}`);
    }
    // Imported as at segment end; the review stays open for a person. The version stays the
    // run creator's; its history says who imported it again, and when (owner, 2026-10-25).
    const again = `imported again by ${displayName(ctx.userName ?? "admin@example.com")} on ${companyStamp(ctx.now())}`;
    const imp = ctx.importDraft(r.document_slug, r, again);
    s.draft_import = { ...imp, created: true, warnings: [], error: null, problems: [], summary: null };
    r.document_id = imp.document_id ?? null;
    review.payload = { ...review.payload, import: s.draft_import };
    return done();
  }
  if (action === "decisions" && m === "GET") return json(200, decisionsOf(r));
  if (action === "segments" && p[5] === "artifacts" && m === "GET") {
    const s = r.segments.find((x) => x.seq === Number(p[4]));
    const raw = new URL(req.url).searchParams.get("attempt");
    const current = s?.attempts[s.attempts.length - 1]?.attempt;
    let key = `${r.id}|${p[4]}|${p[6]}`;
    // D7: the agents' original of a file an approver's edits replaced.
    const agents = ["1", "true"].includes(new URL(req.url).searchParams.get("agents") ?? "");
    if (agents) {
      const original = ctx.db.artifacts[`${key}|agents`];
      if (original == null) return fail(404, `no edits were applied to '${p[6]}': the file served is the agents'`);
      return new Response(original, { headers: { "content-type": "text/plain" } });
    }
    if (raw != null && Number(raw) !== current) {
      if (Number(raw) !== s?.previous_attempt?.attempt) {
        return fail(404, `attempt ${raw} of segment ${p[4]} is not kept: only the current and the previous attempt are kept`);
      }
      key = `${key}|${raw}`;
    }
    const content = ctx.db.artifacts[key];
    if (content == null) return fail(404, `artifact '${p[6]}' not found`);
    return new Response(content, { headers: { "content-type": "text/plain" } });
  }
  return fail(404, "Route not found");
}

/**
 * Seeded runs take fixed times, as they take stable ids: each step a minute after the
 * last, from the run's own creation, so "Started" reads the same on every page load.
 */
function seedClock() {
  let clock = 0;
  return {
    from: (iso: string) => void (clock = Date.parse(iso)),
    now: () => new Date((clock += 60_000)).toISOString(),
  };
}

/** A seeded draft run, estimated, added to `db`. */
function seedRun(ctx: Omit<RunsContext, "db">, db: RunsDb, flow: RunOut["flow"], document: string, knobs: KnobsIn, created_at: string): RunOut {
  const doc = ctx.documents.find((d) => d.slug === document);
  // Seeded runs stand for runs started before F4: no Engineering check or dates unless they name them.
  const k = resolveKnobs(flow, { ...knobs, checkpoints: { eng_review: false, eng_dates: false, ...knobs.checkpoints } }) as RunOut["knobs"];
  const segments = segmentsFor(flow, k, ctx.uuid)
    .filter((s) => !skippedOff(s))
    .map((s, i) => ({ ...s, seq: i + 1 }));
  for (const s of segments) s.estimate_usd = segEstimate(s.roles, k.depth);
  const estimate = round2(segments.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0));
  const run: RunOut = {
    id: ctx.uuid(),
    flow,
    flow_title: flowOf(flow).title,
    status: "draft",
    document_id: doc?.id ?? null,
    document_slug: doc?.slug ?? document,
    document_kind: doc?.kind ?? "prd",
    source: null,
    template: null,
    theme: null,
    estimate_usd: estimate,
    spent_usd: 0,
    created_by: ctx.userId,
    created_at,
    started_at: null,
    finished_at: null,
    waiting_on: null,
    error: null,
    can_retry: false,
    can_stop_cancelling: false,
    can_retry_lookup: false,
    cancel_again: [],
    can_dismiss_overrun: false,
    can_decide: false,
    can_retry_import: false,
    knobs: k,
    snapshot_id: ctx.uuid(),
    snapshot_as_of: created_at,
    approved_by: null,
    approved_at: null,
    needs_approval: estimate > THRESHOLD,
    overrun_ceiling_usd: null,
    runtime: "fake",
    notes: FLOW_CATALOG.runtime_notes,
    note_refs: [],
    segments,
    checkpoints: [],
    token_read_only: false,
    open_proposals: 0,
  };
  db.runs.push(run);
  return run;
}

/** D11: how a decision reads for the run's agents (as api/oracle/runs/service.py). */
const CHECKPOINT_TITLES: Record<CheckpointOut["kind"], string> = {
  baseline_confirm: "Baseline",
  feature_set: "Feature set",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering review",
  eng_dates: "Engineering dates",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
  strategy_review: "Vision or strategy review",
  request_triage: "Request triage",
  launch_review: "Launch kit review",
  update_review: "Update review",
  pricing_review: "Pricing memo review",
};

function decisionSummary(d: Omit<RunDecision, "summary">): string {
  let what = d.status.replace("_", " ");
  if (d.decided_by_role) what += ` by ${/^[aeiou]/.test(d.decided_by_role) ? "an" : "a"} ${d.decided_by_role}`;
  if (d.via === "swarmcloud_console") what += " in SwarmCloud's console";
  const parts = [CHECKPOINT_TITLES[d.kind] ?? d.kind, what];
  if (d.note) parts.push(`note: ${d.note}`);
  if (d.delivered === false) parts.push("not delivered to the run yet");
  return parts.join(" · ");
}

/** The run's decided checkpoints, by segment then decided time; pending ones are not listed. */
function decisionsOf(r: RunOut): RunDecision[] {
  const flow = FLOW_CATALOG.flows.find((f) => f.key === r.flow);
  const out = r.checkpoints
    .filter((c) => c.status !== "pending")
    .map((c) => {
      const decided = c.payload.decided as { role?: RunDecision["decided_by_role"]; via?: RunDecision["via"] } | undefined;
      const extra = (c.payload.review ?? {}) as { edits?: RunDecision["edits"]; review?: RunDecision["review"] };
      const d: Omit<RunDecision, "summary"> = {
        checkpoint_id: c.id,
        kind: c.kind,
        segment_seq: c.segment_seq ?? null,
        segment_title: flow?.segments.find((s) => s.name === c.payload.segment)?.title ?? null,
        attempt: (c.payload.attempt as number | undefined) ?? null,
        status: c.status as RunDecision["status"],
        decided_at: c.decided_at ?? null,
        decided_by_role: decided?.role ?? null,
        via: decided?.via ?? "oracle",
        note: c.note ?? null,
        edits: extra.edits ?? null,
        review: extra.review ?? null,
        delivered: !c.delivery,
      };
      return { ...d, summary: decisionSummary(d) };
    });
  return out.sort((a, b) => (a.segment_seq ?? 0) - (b.segment_seq ?? 0) || (a.decided_at ?? "~").localeCompare(b.decided_at ?? "~"));
}

/** Seeded runs: one waiting at a checkpoint, one over the approval threshold, one paused on overrun, one done. */
export function seedRuns(ctx: Omit<RunsContext, "db">): RunsDb {
  const db: RunsDb = { runs: [], artifacts: {}, scopes: {}, baseline_built_at: "2026-10-20T16:00:00Z" };
  const { from, now } = seedClock();
  const full = { ...ctx, db, now };
  const make = (flow: RunOut["flow"], document: string, knobs: KnobsIn, created_at: string) => seedRun(ctx, db, flow, document, knobs, created_at);

  // Waiting for the baseline to be confirmed.
  const waiting = make("baseline_to_prd", "team-onboarding", {}, "2026-10-17T08:00:00Z");
  from(waiting.created_at);
  launch(full, waiting);
  tick(full);

  // Over $50: waits for an owner.
  const big = make("baseline_to_prd", "usage-alerts-v2", { depth: "deep" }, "2026-10-17T08:30:00Z");
  big.status = "awaiting_approval";

  // Spent past 1.5x its estimate.
  const over = make("feedback_loop", "team-workspaces", {}, "2026-10-16T17:00:00Z");
  from(over.created_at);
  launch(full, over);
  over.overrun_ceiling_usd = 13.5;
  over.segments[0].attempts[0].cost_usd = 14.2;
  over.segments[0].cost_usd = 14.2;
  over.segments[0].status = "succeeded";
  over.status = "paused_overrun";

  // A finished feedback loop.
  const done = make("feedback_loop", "checkout-redesign", { checkpoints: { prd_review: false } }, "2026-10-16T09:00:00Z");
  done.segments[0].attempts.push({ attempt: 1, workflow_id: "mock-wf-done", submitted_at: "2026-10-16T09:00:00Z", cost_usd: 8.1, note: null, state: "succeeded" });
  Object.assign(done.segments[0], {
    status: "succeeded",
    cost_usd: 8.1,
    artifacts: ["prd.md"],
    draft_import: { document_id: done.document_id, slug: "checkout-redesign", version: 2, created: true, warnings: [], error: null, problems: [], summary: null },
  });
  db.artifacts[`${done.id}|1|prd.md`] = fileContent("prd.md", "next_draft", 1);
  done.checkpoints.push({
    id: ctx.uuid(), run_id: done.id, kind: "prd_review", status: "skipped", approver_role: "approver", segment_seq: 1,
    decided_by: null, decided_at: "2026-10-16T09:20:00Z", note: "Turned off when the run started.", payload: {}, created_at: "2026-10-16T09:20:00Z", can_decide: false, lead_stop: false, cannot_approve: null,
    approve_label: "Approve", needs_agents: [],
  });
  Object.assign(done, { status: "succeeded", started_at: "2026-10-16T09:00:00Z", finished_at: "2026-10-16T09:20:00Z", overrun_ceiling_usd: 13.5 });

  // A finished Baseline to PRD run whose agents proposed baseline changes (./baseline.ts).
  const off = { baseline_confirm: false, feature_set: false, priority_order: false, prd_review: false };
  const proposer = make("baseline_to_prd", "saved-carts", { checkpoints: off }, "2026-10-16T08:00:00Z");
  proposer.id = AGENT_RUN;
  from(proposer.created_at);
  for (const seg of proposer.segments) {
    const at = now();
    seg.attempts.push({ attempt: 1, workflow_id: `mock-wf-b3-${seg.seq}`, submitted_at: at, cost_usd: seg.estimate_usd ?? 0, note: null, state: "succeeded" });
    Object.assign(seg, { status: "succeeded", cost_usd: seg.estimate_usd ?? 0, started_at: at, finished_at: now() });
  }
  Object.assign(proposer, { status: "succeeded", started_at: proposer.created_at, finished_at: now() });

  for (const r of db.runs) refresh(r);
  return db;
}

/**
 * #561 review, the "stored-refusals" scenario: a feedback loop on checkout-redesign that failed
 * on Oct 18, its segment and the run on a refusal stored before #403's wording.
 */
export function seedStoredRefusalRun(db: RunsDb, ctx: Omit<RunsContext, "db">, error: string): RunOut {
  const run = seedRun(ctx, db, "feedback_loop", "checkout-redesign", { checkpoints: { prd_review: false } }, "2026-10-18T23:00:00Z");
  const at = "2026-10-18T23:12:00Z";
  run.segments[0].attempts.push({ attempt: 1, workflow_id: null, submitted_at: "2026-10-18T23:00:00Z", cost_usd: 0, note: null, state: "failed" });
  Object.assign(run.segments[0], { status: "failed", started_at: "2026-10-18T23:00:00Z", finished_at: at, error });
  Object.assign(run, { status: "failed", started_at: "2026-10-18T23:00:00Z", finished_at: at, error });
  refresh(run);
  return run;
}

/** The note the API records when it renews a run's key for a step parked mcp_credential_expired (SwarmCloud #2498). */
export const KEY_RENEWED_NOTE =
  "Key renewed at 2026-10-21 03:10 PDT: the step started after its key expired while it waited in SwarmCloud's queue";

/**
 * The "key-renewed" scenario: a SwarmCloud feedback loop on checkout-redesign whose first step waited in
 * SwarmCloud's queue past its key, was parked, and went on once Oracle renewed the key.
 */
export function seedKeyRenewedRun(db: RunsDb, ctx: Omit<RunsContext, "db">): RunOut {
  const run = seedRun(ctx, db, "feedback_loop", "checkout-redesign", { checkpoints: { prd_review: false } }, "2026-10-20T03:00:00Z");
  run.segments[0].attempts.push({ attempt: 1, workflow_id: "mock-wf-key-renewed", submitted_at: "2026-10-20T03:00:00Z", cost_usd: 0, note: null, state: "running" });
  Object.assign(run.segments[0], { status: "running", started_at: "2026-10-20T03:00:00Z" });
  Object.assign(run, { status: "running", started_at: "2026-10-20T03:00:00Z", runtime: "swarmcloud", notes: [KEY_RENEWED_NOTE] });
  refresh(run);
  return run;
}

/** The run the "feature-set" scenario seeds (C6). */
export const FEATURE_SET_RUN = "7a11c0de-0000-4000-8000-0000000000f5";

/** Saved addresses at checkout: 6 features, 14 requirements, 2 left out; bulk edit depends on one left out. */
const SAVED_ADDRESSES: FeatureSetSpec = {
  features: [
    {
      key: "saved-addresses",
      title: "Saved addresses",
      summary: "Returning buyers pick a saved address at checkout",
      goals: [{ key: "repeat-checkout", contribution: 3 }],
      depends_on: ["address-lookup"],
      confidence: 0.8,
      requirements: [
        { key: "saved-addresses-pick", text: "The buyer picks one of up to five saved addresses", acceptance: ["Five addresses at most", "The last used one is preselected"] },
        { key: "saved-addresses-save", text: "A new address can be saved while paying", acceptance: ["Saving is opt-in"] },
        { key: "saved-addresses-remove", text: "The buyer removes a saved address from their account", acceptance: ["Removed addresses are gone at the next checkout"] },
      ],
    },
    {
      key: "address-lookup",
      title: "Address lookup",
      summary: "The buyer finds their address from a postcode",
      goals: [{ key: "repeat-checkout", contribution: 1 }, { key: "fewer-failed-deliveries", contribution: 2 }],
      depends_on: [],
      confidence: 0.75,
      requirements: [
        { key: "address-lookup-postcode", text: "A postcode lists the matching addresses", acceptance: ["Results show within a second"] },
        { key: "address-lookup-manual", text: "The buyer can type the address by hand", acceptance: ["Manual entry is one tap away"] },
        { key: "address-lookup-validate", text: "An address that cannot be delivered to is flagged before paying", acceptance: ["The flag says why"] },
      ],
    },
    {
      key: "checkout-address-step",
      title: "One-step address at checkout",
      summary: "Address and delivery choice on one screen",
      goals: [{ key: "repeat-checkout", contribution: 2 }],
      depends_on: ["saved-addresses"],
      confidence: 0.6,
      requirements: [
        { key: "checkout-address-one-screen", text: "Address and delivery option are chosen on one screen", acceptance: ["No extra page load"] },
        { key: "checkout-address-summary", text: "The chosen address shows in the order summary", acceptance: ["It can be changed from the summary"] },
      ],
    },
    {
      key: "address-edit",
      title: "Edit a saved address",
      summary: "Buyers correct a saved address without retyping it",
      goals: [{ key: "fewer-failed-deliveries", contribution: 2 }],
      depends_on: ["saved-addresses"],
      confidence: 0.7,
      requirements: [
        { key: "address-edit-inline", text: "A saved address is edited in place at checkout", acceptance: ["Changes apply to this order"] },
        { key: "address-edit-history", text: "Orders already placed keep the address they were sent to", acceptance: ["Past orders do not change"] },
      ],
    },
    {
      key: "bulk-address-edit",
      title: "Bulk address edit",
      summary: "Business buyers update many saved addresses at once",
      goals: [],
      depends_on: ["saved-addresses", "shared-address-book-export"],
      confidence: 0.3,
      requirements: [
        { key: "bulk-address-edit-import", text: "A buyer uploads a file of address changes", acceptance: ["Up to 200 rows"] },
        { key: "bulk-address-edit-review", text: "The buyer reviews each change before it is saved", acceptance: ["Rejected rows are listed"] },
      ],
    },
    {
      key: "address-labels",
      title: "Address labels",
      summary: "Buyers name saved addresses (Home, Work)",
      goals: [{ key: "repeat-checkout", contribution: 1 }],
      depends_on: ["saved-addresses"],
      confidence: 0.65,
      requirements: [
        { key: "address-labels-name", text: "A saved address takes a short label", acceptance: ["Labels are 20 characters at most"] },
        { key: "address-labels-show", text: "Labels show first in the address picker", acceptance: ["Unlabelled addresses show the street"] },
      ],
    },
  ],
  excluded: [
    { key: "shared-address-book-export", reason: "Serves no confirmed goal; business accounts come later" },
    { key: "address-sharing", reason: "Sharing addresses between buyers needs a privacy review first" },
  ],
};

const SAVED_ADDRESSES_DESIGN = `# Saved addresses: design

Returning buyers pick a saved address at checkout instead of typing it again.

## Dependencies

- Saved addresses read the postcode lookup for new entries.
- The one-step address screen, editing and labels build on saved addresses.
- Bulk address edit reads the shared address book export, which this set leaves out.

## Open questions

- How many saved addresses a buyer keeps (five proposed).
`;

/**
 * The "feature-set" scenario (C6): a Baseline to PRD run for a new PRD (saved-addresses)
 * waiting at its feature set, whose check found one blocking problem (bulk-address-edit
 * depends on a feature left out) and two flags, so Approve is refused until it is sent back.
 */
export function seedFeatureSetRun(db: RunsDb, ctx: Omit<RunsContext, "db">): RunOut {
  const { from, now } = seedClock();
  // Its own runs list, so the ticks below move this run only.
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}) };
  const full = { ...ctx, db: own, now };
  const r = seedRun(ctx, own, "baseline_to_prd", "saved-addresses", {}, "2026-10-17T09:00:00Z");
  r.id = FEATURE_SET_RUN;
  from(r.created_at);
  launch(full, r);
  tick(full);
  // The baseline was confirmed; the feature set ran once.
  const [baseline, featureSet] = r.segments;
  Object.assign(r.checkpoints[0], { status: "approved", decided_by: ctx.userId, decided_at: now() });
  next(full, r, baseline);
  tick(full);
  const check = checkOf(
    SAVED_ADDRESSES,
    [
      {
        code: "depends_on_excluded",
        blocking: true,
        feature: "bulk-address-edit",
        requirement: null,
        message: "bulk-address-edit depends on shared-address-book-export, which is excluded",
      },
    ],
    { "bulk-address-edit": ["serves_no_goal", "low_confidence"], "saved-addresses": ["new_feature"] },
  );
  featureSet.feature_set_check = check;
  featureSet.artifacts = ["design.md", "feature_set.yaml"];
  db.artifacts[`${r.id}|${featureSet.seq}|feature_set.yaml`] = featureSetYaml(SAVED_ADDRESSES, r.document_slug, featureSet.name, 1);
  db.artifacts[`${r.id}|${featureSet.seq}|design.md`] = SAVED_ADDRESSES_DESIGN;
  own.scopes![r.id] = [];
  proposeScope(full, r, featureSet.seq, 1, SAVED_ADDRESSES, check);
  const cp = r.checkpoints.find((c) => c.kind === "feature_set")!;
  cp.payload = { ...cp.payload, feature_set_check: check };
  refresh(r);
  db.runs.push(r);
  return r;
}

/** The run the "eng-review" scenario seeds (A3). */
export const ENG_REVIEW_RUN = "7a11c0de-0000-4000-8000-0000000000e3";

/**
 * The "eng-review" scenario (A3): a Baseline to PRD run for a new PRD (offline-sync) waiting
 * at an Engineering review stop. No flow creates one yet (F4 Engineering review stop adds the
 * check and the dates to Baseline to PRD): its first stop is made one, as the API tests do.
 */
export function seedEngReviewRun(db: RunsDb, ctx: Omit<RunsContext, "db">): RunOut {
  const { from, now } = seedClock();
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}) };
  const full = { ...ctx, db: own, now };
  const r = seedRun(ctx, own, "baseline_to_prd", "offline-sync", {}, "2026-10-17T10:00:00Z");
  r.id = ENG_REVIEW_RUN;
  from(r.created_at);
  launch(full, r);
  tick(full);
  const cp = r.checkpoints.find((c) => c.status === "pending")!;
  Object.assign(cp, { kind: "eng_review", approver_role: "approver" });
  refresh(r);
  db.runs.push(r);
  return r;
}

/** The run the "eng-check" scenario seeds (F4). */
export const ENG_CHECK_RUN = "7a11c0de-0000-4000-8000-0000000000f4";

/**
 * The "eng-check" scenario (F4): a Baseline to PRD run for a new PRD (guided-onboarding),
 * its baseline and feature set approved, waiting at its Engineering check with three briefs
 * on the baseline's features, one with a blocking question.
 */
export function seedEngCheckRun(db: RunsDb, ctx: Omit<RunsContext, "db">): RunOut {
  const { from, now } = seedClock();
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}), drafts: (db.drafts ??= {}) };
  const full = { ...ctx, db: own, now };
  const r = seedRun(ctx, own, "baseline_to_prd", "guided-onboarding", { checkpoints: { eng_review: true } }, "2026-10-17T11:00:00Z");
  r.id = ENG_CHECK_RUN;
  from(r.created_at);
  launch(full, r);
  for (const kind of ["baseline_confirm", "feature_set"]) {
    tick(full);
    const cp = r.checkpoints.find((c) => c.status === "pending" && c.kind === kind)!;
    Object.assign(cp, { status: "approved", decided_by: ctx.userId, decided_at: now() });
    if (kind === "feature_set") decideScope(full, r, "approved", ctx.userId);
    next(full, r, r.segments.find((x) => x.seq === cp.segment_seq)!);
  }
  tick(full);
  refresh(r);
  db.runs.push(r);
  return r;
}

/** The runs the "eng-dates" scenario seeds (F4 lane B). */
export const ENG_DATES_RUN = "7a11c0de-0000-4000-8000-0000000000d4";
export const ENG_DATES_WAITING_RUN = "7a11c0de-0000-4000-8000-0000000000d5";

/** A Baseline to PRD run with only the Engineering dates on, its PRD draft imported (v2 of `document`). */
function seedDatesRun(db: RunsDb, ctx: Omit<RunsContext, "db">, id: string, document: string, created_at: string) {
  const { from, now } = seedClock();
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}), drafts: (db.drafts ??= {}), priority_snapshots: (db.priority_snapshots ??= []) };
  const full = { ...ctx, db: own, now };
  const off = { baseline_confirm: false, feature_set: false, priority_order: false, prd_review: false, eng_review: false, eng_dates: true };
  const r = seedRun(ctx, own, "baseline_to_prd", document, { checkpoints: off }, created_at);
  r.id = id;
  from(r.created_at);
  launch(full, r);
  return { r, full };
}

/**
 * The "eng-dates" scenario (F4 lane B): a Baseline to PRD run for the Usage alerts PRD waiting
 * at its Engineering dates with four Now items (three with a proposed date), two Next and one
 * Later; and one for Visit reminders whose PRD review is done, waiting for v2's roadmap items.
 */
export function seedEngDatesRuns(db: RunsDb, ctx: Omit<RunsContext, "db">): RunOut[] {
  const waiting = seedDatesRun(db, ctx, ENG_DATES_RUN, "usage-alerts", "2026-10-22T08:00:00Z");
  for (let i = 0; i < 10 && waiting.r.status !== "awaiting_checkpoint"; i++) tick(waiting.full);
  refresh(waiting.r);
  const later = seedDatesRun(db, ctx, ENG_DATES_WAITING_RUN, "visit-reminders", "2026-10-22T09:00:00Z");
  const dates = () => later.r.segments.find((x) => x.name === "eng_dates")!;
  for (let i = 0; i < 10 && dates().status !== "running"; i++) tick(later.full);
  // As the API: the dates step waits for the draft's roadmap items before it runs.
  Object.assign(dates(), { status: "pending", attempts: [], workflow_id: null, started_at: null, agents: [], checked_at: null });
  const imp = later.r.segments.find((x) => x.name === "prd_draft")?.draft_import;
  later.r.waiting_for = { kind: "draft_items", version: imp?.version ?? 1 };
  refresh(later.r);
  db.runs.push(waiting.r, later.r);
  return [waiting.r, later.r];
}

/** The run the "baseline-review" scenarios seed (B2). */
export const BASELINE_REVIEW_RUN = "7a11c0de-0000-4000-8000-0000000000b2";

/**
 * The "baseline-review" scenarios (B2): a Build the baseline run of Oct 20 waiting at Confirm
 * the baseline (./from-run.ts seeds what it wrote to the baseline). `consoleHeld`: approved in
 * SwarmCloud's console while its goals are undecided, so Oracle holds it (D3 "Console gate").
 */
export function seedBaselineReviewRun(db: RunsDb, ctx: Omit<RunsContext, "db">, consoleHeld = false): RunOut {
  const { from, now } = seedClock();
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}) };
  const full = { ...ctx, db: own, now };
  const r = seedRun(ctx, own, "baseline", "", {}, "2026-10-20T16:14:00Z");
  r.id = BASELINE_REVIEW_RUN;
  Object.assign(r, { document_id: null, document_slug: null });
  from(r.created_at);
  launch(full, r);
  tick(full);
  const cp = r.checkpoints.find((c) => c.status === "pending")!;
  cp.run_id = r.id;
  if (consoleHeld) {
    cp.console = {
      answered_by: "lead@example.com",
      answered_at: "2026-10-20T17:00:00Z",
      via: null,
      verdict: "MERGE",
      findings: [],
      counted: true,
      reason: CONSOLE_HELD,
      needs: "confirm",
      revise: false,
      can_redo: false,
    };
    r.token_read_only = true;
  }
  refresh(r);
  db.runs.push(r);
  return r;
}

/** D10 "run-review" scenario: a Baseline to PRD run waiting at its PRD review of the Usage alerts PRD's v2. */
export const RUN_REVIEW_RUN = "7a11c0de-0000-4000-8000-0000000000da";

export function seedRunReviewRun(db: RunsDb, ctx: Omit<RunsContext, "db">): RunOut {
  const { from, now } = seedClock();
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}), priority_snapshots: (db.priority_snapshots ??= []) };
  const full = { ...ctx, db: own, now };
  const off = { baseline_confirm: false, feature_set: false, priority_order: false, eng_review: false };
  const r = seedRun(ctx, own, "baseline_to_prd", "usage-alerts", { checkpoints: off }, "2026-10-21T08:00:00Z");
  r.id = RUN_REVIEW_RUN;
  from(r.created_at);
  launch(full, r);
  for (let i = 0; i < 8 && r.status !== "awaiting_checkpoint"; i++) tick(full);
  refresh(r);
  db.runs.push(r);
  return r;
}

/** The runs the "no-document" scenario seeds (#583 review): a new one and one from before the row shipped. */
export const NO_DOCUMENT_RUN = "7a11c0de-0000-4000-8000-0000000000e1";
export const OLD_NO_DOCUMENT_RUN = "7a11c0de-0000-4000-8000-0000000000e2";

/**
 * The "no-document" scenario (#583 review): two Baseline to PRD runs approved past a refused PRD
 * draft, so they finished with no document: guest-checkout's just now, and old-checkout's on
 * Oct 1, before the No document row shipped (NO_DOCUMENT_SINCE), which gets no Inbox row.
 */
export function seedNoDocumentRuns(db: RunsDb, ctx: Omit<RunsContext, "db">) {
  const off = { baseline_confirm: false, feature_set: false, priority_order: false, eng_review: false };
  const error = "prd.md was rejected: [invalid_citation] citation #1 (o-g1) is invalid: source";
  const summary = "Oracle refused prd.md: 1 citation uses source 'o', which isn't accepted.";
  const make = (id: string, document: string, at: string) => {
    const r = seedRun(ctx, db, "baseline_to_prd", document, { checkpoints: off }, at);
    r.id = id;
    for (const s of r.segments) {
      s.attempts.push({ attempt: 1, workflow_id: `mock-wf-nodoc-${s.seq}`, submitted_at: at, cost_usd: 1, note: null, state: "succeeded" });
      Object.assign(s, { status: "succeeded", cost_usd: 1, started_at: at, finished_at: at });
      if (s.name !== "prd_draft") continue;
      s.artifacts = ["prd.md"];
      s.draft_import = { document_id: null, slug: null, kind: null, version: null, created: null, warnings: [], error, problems: [], summary, source: null, prd_links: null };
      db.artifacts[`${id}|${s.seq}|prd.md`] = fileContent("prd.md", s.name, 1, document);
      r.checkpoints.push({
        id: ctx.uuid(), run_id: id, kind: "prd_review", status: "approved", approver_role: "approver", segment_seq: s.seq,
        decided_by: null, decided_at: at, note: null, created_at: at, can_decide: false, lead_stop: false, cannot_approve: null,
        payload: { segment_seq: s.seq, segment: s.name, attempt: 1, artifacts: ["prd.md"], import: { error, problems: [], summary } },
        approve_label: "Approve", needs_agents: [],
      });
    }
    Object.assign(r, { status: "succeeded", document_id: null, started_at: at, finished_at: at, waiting_on: null });
    refresh(r);
  };
  make(OLD_NO_DOCUMENT_RUN, "old-checkout", "2026-10-01T09:00:00Z");
  make(NO_DOCUMENT_RUN, "guest-checkout", new Date().toISOString());
}

/** B2: the run's Confirm the baseline stop as GET /v1/baseline/from-run reads it, or null. */
export function fromRunCheckpoint(ctx: RunsContext, runId: string): { run: Schemas["ProposalRun"]; checkpoint: Schemas["FromRunCheckpoint"] | null; actions: Schemas["ReviewAction"][] } | null {
  const r = ctx.db.runs.find((x) => x.id === runId);
  if (!r) return null;
  const run = { id: r.id, flow: r.flow, flow_title: r.flow_title, status: r.status, created_at: r.created_at };
  const cp = r.checkpoints.filter((c) => c.kind === "baseline_confirm").pop();
  if (!cp) return { run, checkpoint: null, actions: [] };
  const role = ctx.member?.role ?? ctx.userRole ?? null;
  const draft = draftOf(ctx, cp.id);
  const review = reviewOut(ctx, r, cp, draft, role);
  const people = new Map((ctx.members ?? []).map((x) => [x.id, x]));
  const decider = cp.decided_by ? people.get(cp.decided_by) : undefined;
  const pending = cp.status === "pending";
  return {
    run,
    checkpoint: {
      id: cp.id,
      kind: cp.kind,
      status: cp.status,
      approver_role: cp.approver_role,
      revision: draft.revision,
      can_suggest: review.can_suggest,
      can_stage: review.can_stage,
      can_decide: review.can_decide && (!ctx.mayDecide || ctx.mayDecide(cp, r.flow)),
      gate: review.gate,
      note: draft.note,
      wait: review.wait,
      decided_by_name: cp.decided_by ? displayName(decider?.email ?? ctx.userName ?? "admin@example.com") : null,
      decided_at: cp.decided_at ?? null,
      review_note: !pending && cp.status === "changes_requested" ? (cp.note ?? null) : null,
    },
    actions: pending ? review.items.flatMap((i) => i.actions) : [],
  };
}

/** The runs the "priority-order" scenario seeds (C8). */
export const PRIORITY_RUN = "7a11c0de-0000-4000-8000-0000000000c8";
export const PRIORITY_BLOCKED_RUN = "7a11c0de-0000-4000-8000-0000000000c9";

/** Saved addresses: one feature ranked well above the live ranking (differs_from_live, advisory). */
const SAVED_ADDRESSES_ORDER: OrderSpec = {
  method: "goal_weighted",
  order: [
    { key: "F-5", score: 1.8, explanation: "Saved addresses read the lookup first; G1 weight 3 x contribution 1 x 0.6 / 3" },
    { key: "F-4", score: 0.6, explanation: "Alerts keep teams active; ranked early on purpose: G2 weight 2 x contribution 1 x 0.3 / 1" },
    { key: "F-2", score: 8.1, explanation: "Needs F-5 first; G1 weight 3 x contribution 3 x 0.9 / 1" },
    { key: "F-1", score: 2.25, explanation: "G1 weight 3 x contribution 2 x 0.75 / 2" },
    { key: "F-7", score: 1, explanation: "G2 weight 2 x contribution 2 x 0.5 / 2" },
  ],
};

/** Usage alerts: F-2 ranked above F-5, which it depends on (before_prerequisite, blocking). */
const USAGE_ALERTS_ORDER: OrderSpec = {
  method: "goal_weighted",
  order: [
    { key: "F-2", score: 8.1, explanation: "G1 weight 3 x contribution 3 x 0.9 / 1" },
    { key: "F-5", score: 1.8, explanation: "G1 weight 3 x contribution 1 x 0.6 / 3" },
    { key: "F-1", score: 2.25, explanation: "G1 weight 3 x contribution 2 x 0.75 / 2" },
  ],
};

/** A Baseline to PRD run for `document`, its baseline and feature set approved, waiting at the priority stop with `spec`. */
function seedAtPriority(db: RunsDb, ctx: Omit<RunsContext, "db">, id: string, document: string, created_at: string, spec: OrderSpec): RunOut {
  const { from, now } = seedClock();
  // Its own runs list, so the ticks below move this run only.
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}), priority_snapshots: (db.priority_snapshots ??= []) };
  const full = { ...ctx, db: own, now };
  const r = seedRun(ctx, own, "baseline_to_prd", document, {}, created_at);
  r.id = id;
  from(r.created_at);
  launch(full, r);
  for (const seq of [1, 2]) {
    tick(full);
    const cp = r.checkpoints.find((c) => c.segment_seq === seq)!;
    Object.assign(cp, { status: "approved", decided_by: ctx.userId, decided_at: now() });
    next(full, r, r.segments[seq - 1]);
  }
  // Its feature set came from an earlier scope: the order is not checked against one here.
  own.scopes![r.id] = [];
  tick(full);
  const priority = r.segments.find((s) => s.name === "priority")!;
  const check = checkOrder(spec, null);
  priority.priority_check = check;
  db.artifacts[`${r.id}|${priority.seq}|priority.yaml`] = priorityYaml(spec, priority.name, 1);
  const snap = proposeOrder(full, r, priority.seq, 1, spec, check);
  const cp = r.checkpoints.find((c) => c.kind === "priority_order")!;
  cp.payload = { ...cp.payload, priority_check: check, priority_snapshot_id: snap.id };
  snap.checkpoint_id = cp.id;
  refresh(r);
  db.runs.push(r);
  return r;
}

/**
 * The "priority-order" scenario (C8): two Baseline to PRD runs waiting at the priority stop,
 * one whose order has an advisory differs_from_live row (Saved addresses PRD) and one with a
 * blocking before_prerequisite (Usage alerts), and a run order saved earlier for the
 * Checkout redesign PRD.
 */
export function seedPriorityRuns(db: RunsDb, ctx: Omit<RunsContext, "db">) {
  seedAtPriority(db, ctx, PRIORITY_RUN, "saved-addresses", "2026-10-18T09:00:00Z", SAVED_ADDRESSES_ORDER);
  seedAtPriority(db, ctx, PRIORITY_BLOCKED_RUN, "usage-alerts", "2026-10-18T10:00:00Z", USAGE_ALERTS_ORDER);
  const checkout = ctx.documents.find((d) => d.slug === "checkout-redesign");
  const earlier = db.runs.find((r) => r.document_slug === "checkout-redesign") ?? db.runs[0];
  const spec: OrderSpec = { method: "goal_weighted", order: ranking("goal_weighted").features.slice(0, 4).map((f) => ({ key: f.key, score: f.score ?? 0, explanation: "As the live ranking" })) };
  const check = checkOrder(spec, null);
  const snap = proposeOrder({ ...ctx, db }, earlier, 0, 1, spec, check);
  Object.assign(snap, {
    status: "saved",
    created_at: "2026-10-12T09:00:00Z",
    decided_by: ctx.userId,
    decided_at: "2026-10-12T10:00:00Z",
    document: checkout ? { id: checkout.id, slug: checkout.slug, title: checkout.title } : null,
  });
}

/**
 * The large-company scenario (po-mock-scenario=large): `count` more active runs, cloned from
 * the seeded run that waits on a checkpoint; every fifth still waits on one (an Inbox
 * line), the others are running their second segment.
 */
export function enlargeRuns(db: RunsDb, uuid: () => string, count: number) {
  const model = db.runs.find((r) => r.status === "awaiting_checkpoint")!;
  for (let i = 0; i < count; i++) {
    const r: RunOut = JSON.parse(JSON.stringify(model));
    r.id = uuid();
    r.document_slug = `${model.document_slug}-${i + 1}`;
    r.created_at = new Date(Date.parse(model.created_at) - (i + 1) * 3600_000).toISOString();
    for (const s of r.segments) s.id = uuid();
    if (i % 5 === 0) {
      for (const c of r.checkpoints) Object.assign(c, { id: uuid(), run_id: r.id });
    } else {
      r.checkpoints = [];
      r.status = "running";
      r.segments[1].status = "running";
    }
    refresh(r);
    db.runs.push(r);
  }
}

// --------------------------------------------------------------------------- roadmap review

type ItemsCheck = NonNullable<SegmentOut["items_check"]>;
type ItemReason = ItemsCheck["reasons"][number];
type ReasonFix = ItemReason["fixes"][number];

const fix = (label: string, kind: ReasonFix["action"]["kind"], item: string, field: string | null = null, value: unknown = null): ReasonFix => ({
  label,
  action: { kind, item, field, value },
});
const accept = (item: string, label = "Accept") => fix(label, "accept", item);
const drop = (item: string) => fix("Drop", "drop", item);
const moveTo = (item: string, horizon: string, label = `Move to ${horizon[0].toUpperCase()}${horizon.slice(1)}`) => fix(label, "edit", item, "horizon", horizon);

/** As oracle.runs.reasons.summarize: the check with its reasons and their counts. */
function withReasons(check: Pick<ItemsCheck, "items" | "by_horizon" | "problems">, reasons: ItemReason[], base: ItemsCheck["base"] = null): ItemsCheck {
  return {
    ...check,
    reasons,
    blocking: reasons.filter((r) => r.severity === "blocking").length,
    to_confirm: reasons.filter((r) => r.severity === "confirm").length,
    file_problems: check.problems.filter((p) => !p.item).length,
    base,
    reasons_partial: false,
  };
}

/** The local runtime's one item, as the API checks it: its unknown PRD section is its one blocking reason. */
function localItemsCheck(known: boolean, source: VersionSource | null): ItemsCheck {
  if (known) return withReasons({ items: 1, by_horizon: { now: 1, next: 0, later: 0 }, problems: [] }, []);
  const item = "price-early";
  return withReasons(
    {
      items: 1,
      by_horizon: { now: 1, next: 0, later: 0 },
      problems: [{ code: "unknown_prd_section", message: `item ${item}: PRD section 'features' is not in the PRD version`, item }],
    },
    [
      {
        item,
        item_title: "Show the price early",
        code: "unknown_prd_section",
        severity: "blocking",
        label: "No PRD section",
        text: `Section features is not in ${source ? `${source.title} v${source.version}` : "the PRD version"}.`,
        data: { section: "features" },
        fixes: [fix("Link section", "edit", item, "prd_section")],
      },
    ],
  );
}

/** The seeded roadmap review run (seedRoadmapReview in e2e/helpers.ts). */
export const ROADMAP_REVIEW_RUN_ID = "7a11c0de-0000-4000-8000-0000000000d2";

const REVIEW_ITEMS = `version: 1
prd: {document: usage-alerts, version: 1}
items:
  - {id: slack-alerts, title: Slack alerts, outcome: Teams hear about spend spikes where they work, horizon: now, prd_section: alerts-slack, confidence: high, milestone: {name: Beta, date: 2026-11-30, date_source: a guess}}
  - {id: anomaly-detection, title: Anomaly detection, outcome: Unusual spend is caught the same day, horizon: later, prd_section: alerts-anomaly, confidence: low}
  - {id: budget-caps, title: Budget caps, outcome: No team overspends its budget, horizon: now, prd_section: alerts-caps, depends_on: [anomaly-detection], confidence: high}
  - {id: usage-export, title: Usage export, outcome: Finance gets usage as a file, horizon: now, prd_section: export, confidence: medium}
  - {id: cost-forecast, title: Cost forecast, outcome: Owners see next month's spend, horizon: next, prd_section: alerts-forecast, confidence: medium}
  - {id: mobile-push, title: Mobile push, outcome: Owners hear about spikes on their phone, horizon: later, prd_section: alerts-mobile, confidence: medium}
  - {id: sso-login, title: Single sign-on, outcome: Members sign in with the company account, horizon: next, prd_section: sso, confidence: high}
  - {id: invoice-pdf, title: Invoice PDF, outcome: Finance downloads each invoice, horizon: later, prd_section: billing-invoices, priority: {rank: 2, score: 4.1, explanation: "revenue weight 3 x contribution 1.4"}, confidence: high}
  - {id: webhooks, title: Webhooks, outcome: Teams wire alerts into their own tools, horizon: now, prd_section: alerts-webhooks, confidence: high}
`;

function reviewReasons(): ItemReason[] {
  const r = (item: string, item_title: string, code: string, severity: ItemReason["severity"], label: string, text: string, fixes: ReasonFix[], data: Record<string, unknown> = {}): ItemReason => ({
    item,
    item_title,
    code,
    severity,
    label,
    text,
    data,
    fixes,
  });
  const base = "roadmap v1";
  return [
    r("slack-alerts", "Slack alerts", "unverified_date", "blocking", "Date unverified", "No verified estimate, capacity or commitment supports 2026-11-30.", [fix("Remove date", "edit", "slack-alerts", "milestone_date")], { date: "2026-11-30" }),
    r("anomaly-detection", "Anomaly detection", "low_confidence", "confirm", "Low confidence", "Confidence low, under the company's low threshold (0.4).", [accept("anomaly-detection"), drop("anomaly-detection")], { confidence: "low", low: 0.4 }),
    r(
      "budget-caps",
      "Budget caps",
      "horizon_breaks_dependency",
      "blocking",
      "Depends on a later item",
      "Needs Anomaly detection, which is in Later. An item cannot ship before what it depends on.",
      [moveTo("budget-caps", "later"), moveTo("anomaly-detection", "now", "Pull dependency to Now"), fix("Remove dependency", "edit", "budget-caps", "depends_on", { remove: ["anomaly-detection"] })],
      { dependency: "anomaly-detection", dependency_horizon: "later" },
    ),
    r("usage-export", "Usage export", "unknown_prd_section", "blocking", "No PRD section", "Section export is not in Usage alerts PRD v1.", [fix("Link section", "edit", "usage-export", "prd_section")], { section: "export" }),
    r("cost-forecast", "Cost forecast", "horizon_changed", "confirm", `Moved from Now (${base})`, `It was in Now in ${base}.`, [accept("cost-forecast"), moveTo("cost-forecast", "now", "Keep in Now")], { from: "now", to: "next" }),
    r("weekly-digest", "Weekly digest", "dropped_item", "confirm", `Dropped since ${base}`, `It was in ${base} and is not in this file.`, [accept("weekly-digest", "Accept drop"), fix("Keep", "restore", "weekly-digest")]),
    r("mobile-push", "Mobile push", "serves_no_goal", "confirm", "Serves no goal", "Mobile push supports no confirmed goal.", [accept("mobile-push"), drop("mobile-push")], { feature: "mobile-push" }),
    r("sso-login", "Single sign-on", "new_item", "confirm", `New since ${base}`, `Not in ${base}.`, [accept("sso-login"), drop("sso-login")]),
    r("invoice-pdf", "Invoice PDF", "rank_vs_horizon", "confirm", "Top priority in Later", "Ranked 2 but placed in Later.", [accept("invoice-pdf"), moveTo("invoice-pdf", "next")], { rank: 2 }),
    r("webhooks", "Webhooks", "linked_blocker", "confirm", "Open blocker", "Vendor rate limit is open.", [accept("webhooks"), moveTo("webhooks", "later")], { blocker: "vendor-rate-limit", status: "open" }),
    r(
      "webhooks",
      "Webhooks",
      "stale_section",
      "confirm",
      "PRD section changed",
      "4.6 Webhooks changed in Usage alerts PRD v2 after this item was derived from v1.",
      [accept("webhooks")],
      { section: "alerts-webhooks", version: 2, gone: false, send_back: true },
    ),
  ];
}

/** A prd_to_roadmap run waiting at its Roadmap items checkpoint, with a reason of every code on its nine items. */
function roadmapReviewRun(): RunOut {
  const id = ROADMAP_REVIEW_RUN_ID;
  const at = "2026-10-20T09:00:00Z";
  const flow = flowOf("prd_to_roadmap");
  const knobs = resolveKnobs("prd_to_roadmap", {}) as RunOut["knobs"];
  let n = 0;
  const ids = () => `7a11c0de-0000-4000-8000-0000000d2${String(++n).padStart(3, "0")}`;
  const segments = segmentsFor("prd_to_roadmap", knobs, ids);
  for (const s of segments) s.estimate_usd = segEstimate(s.roles, knobs.depth);
  const [items] = segments;
  const problems: ItemsCheck["problems"] = [
    { code: "unverified_date", message: "item slack-alerts: no verified estimate, capacity or commitment of this PRD (for this item) named in date_source ('a guess') supports 2026-11-30; drop the date or record the basis", item: "slack-alerts" },
    { code: "unknown_prd_section", message: "item usage-export: PRD section 'export' is not in the PRD version", item: "usage-export" },
    { code: "horizon_breaks_dependency", message: "item budget-caps is in now but depends on anomaly-detection in later", item: "budget-caps" },
  ];
  Object.assign(items, {
    status: "succeeded",
    cost_usd: 4.9,
    workflow_id: "mock-wf-roadmap-items",
    artifacts: ["roadmap_items.yaml"],
    started_at: at,
    finished_at: "2026-10-20T09:04:00Z",
    attempts: [{ attempt: 1, workflow_id: "mock-wf-roadmap-items", submitted_at: at, cost_usd: 4.9, note: null, note_by: null, state: "succeeded" }],
    items_check: withReasons({ items: 9, by_horizon: { now: 4, next: 2, later: 3 }, problems }, reviewReasons(), {
      kind: "roadmap_version",
      label: "roadmap v1",
      version: 1,
      attempt: null,
    }),
  });
  const estimate = round2(segments.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0));
  const run: RunOut = {
    id,
    flow: "prd_to_roadmap",
    flow_title: flow.title,
    status: "awaiting_checkpoint",
    document_id: null,
    document_slug: "usage-alerts-roadmap",
    document_kind: "roadmap",
    source: { document_id: "7a11c0de-0000-4000-8000-0000000d2a01", slug: "usage-alerts", title: "Usage alerts PRD", kind: "prd", version: 1, version_id: "7a11c0de-0000-4000-8000-0000000d2a02", approved_at: "2026-10-19T12:00:00Z" },
    template: ROADMAP_DEFAULTS.template,
    theme: ROADMAP_DEFAULTS.theme,
    estimate_usd: estimate,
    spent_usd: 4.9,
    created_by: "mock-user",
    created_at: at,
    started_at: at,
    finished_at: null,
    waiting_on: "roadmap_items",
    error: null,
    can_retry: false,
    can_stop_cancelling: false,
    can_retry_lookup: false,
    cancel_again: [],
    can_dismiss_overrun: false,
    can_decide: false,
    can_retry_import: false,
    knobs,
    snapshot_id: ids(),
    snapshot_as_of: at,
    approved_by: null,
    approved_at: null,
    needs_approval: false,
    overrun_ceiling_usd: round2(estimate * FACTOR),
    runtime: "fake",
    notes: FLOW_CATALOG.runtime_notes,
    note_refs: [],
    segments,
    checkpoints: [
      {
        id: ids(),
        run_id: id,
        kind: "roadmap_items",
        status: "pending",
        approver_role: "approver",
        segment_seq: 1,
        decided_by: null,
        decided_at: null,
        note: null,
        payload: {
          segment_seq: 1,
          segment: "roadmap_items",
          attempt: 1,
          artifacts: ["roadmap_items.yaml"],
          items_check: items.items_check,
          // D8: the step waits in SwarmCloud, 19 h 30 min left when seeded (the header's time chip).
          wait: { workflow_id: "mock-wf-roadmap-items", expires_at: new Date(mockNowMs() + (19 * 60 + 30) * 60_000).toISOString() },
        },
        created_at: "2026-10-20T09:04:00Z",
        can_decide: true,
        lead_stop: false,
        cannot_approve: null,
        approve_label: "Approve",
        needs_agents: [],
      },
    ],
    token_read_only: false,
    open_proposals: 0,
  };
  refresh(run);
  return run;
}

/** The seeded roadmap-items-console-held run (seedConsoleHeld in e2e/helpers.ts). */
export const CONSOLE_HELD_RUN_ID = "7a11c0de-0000-4000-8000-0000000000d4";

/**
 * D3 "Console gate": the roadmap review run's twin, approved in SwarmCloud's console by a
 * member whose answer counts while one waivable blocking reason (usage-export's section) is
 * open, so Oracle holds it: pending, console.needs "confirm", nothing delivered.
 */
function consoleHeldRun(): RunOut {
  const run = JSON.parse(JSON.stringify(roadmapReviewRun()).replaceAll("0000000d2", "0000000d4")) as RunOut;
  run.id = CONSOLE_HELD_RUN_ID;
  run.document_slug = "usage-alerts-roadmap-2";
  const [items] = run.segments;
  const check = items.items_check!;
  const keep = (code: string) => !["unverified_date", "horizon_breaks_dependency"].includes(code);
  items.items_check = withReasons(
    { items: check.items, by_horizon: check.by_horizon, problems: check.problems.filter((x) => keep(x.code)) },
    check.reasons.filter((x) => keep(x.code)),
    check.base,
  );
  const [cp] = run.checkpoints;
  cp.run_id = run.id;
  cp.payload = { ...cp.payload, items_check: items.items_check };
  cp.console = {
    answered_by: "lead@example.com",
    answered_at: "2026-10-20T10:00:00Z",
    via: null,
    verdict: "MERGE",
    findings: [],
    counted: true,
    reason: CONSOLE_HELD,
    needs: "confirm",
    revise: false,
    can_redo: false,
  };
  run.token_read_only = true;
  refresh(run);
  return run;
}

/** The console-held run and its file, as e2e/helpers.ts seedConsoleHeld adds them. */
export const CONSOLE_HELD_RUN: { run: RunOut; artifacts: Record<string, string> } = {
  run: consoleHeldRun(),
  artifacts: { [`${CONSOLE_HELD_RUN_ID}|1|roadmap_items.yaml`]: REVIEW_ITEMS },
};

/** The seeded roadmap review run's attempt 2 (seedRoadmapAttempt2 in e2e/helpers.ts, D6). */
export const ROADMAP_ATTEMPT2_RUN_ID = "7a11c0de-0000-4000-8000-0000000000d6";

// Attempt 2: the date removed, the dependency removed, the section linked (done); mobile-push
// kept in Later (declined); sso-login kept although the agents said they dropped it; invoice-pdf's
// outcome changed without being asked.
const ATTEMPT2_NOTE = "Push waits for the mobile app release next quarter, so it stays in Later until the app ships to every owner";
const REVIEW_ITEMS_2 = REVIEW_ITEMS.replace(
  "items:\n",
  `resolutions:
  - {id: slack-alerts, action: change, status: done}
  - {id: budget-caps, action: change, status: done}
  - {id: usage-export, action: change, status: done}
  - {id: mobile-push, action: change, status: declined, note: "${ATTEMPT2_NOTE}"}
  - {id: sso-login, action: drop, status: done}
items:\n`,
)
  .replace(", milestone: {name: Beta, date: 2026-11-30, date_source: a guess}", ", milestone: {name: Beta}")
  .replace(", depends_on: [anomaly-detection]", "")
  .replace("prd_section: export,", "prd_section: alerts-export,")
  .replace("outcome: Finance downloads each invoice,", "outcome: Finance downloads every invoice as a PDF,");

/**
 * D6 "Per-item resolutions": the roadmap review run sent back with a five-entry review; attempt 2
 * answered it with three changes done, one declined with its note, one claimed and not applied
 * (blocking, so Approve stays disabled) and one unrequested change.
 */
function roadmapAttempt2Run(): RunOut {
  const run = JSON.parse(JSON.stringify(roadmapReviewRun()).replaceAll("0000000d2", "0000000d6")) as RunOut;
  run.id = ROADMAP_ATTEMPT2_RUN_ID;
  run.document_slug = "usage-alerts-roadmap-3";
  const [items] = run.segments;
  const first = items.attempts[0];
  items.attempts = [
    { ...first, note: null },
    { ...first, attempt: 2, workflow_id: "mock-wf-roadmap-items-2", submitted_at: "2026-10-20T10:00:00Z", cost_usd: 3.1 },
  ];
  items.cost_usd = 8;
  items.previous_attempt = { attempt: 1, artifacts: ["roadmap_items.yaml"] };
  const before = items.items_check!;
  const fixed = ["unverified_date", "horizon_breaks_dependency", "unknown_prd_section"];
  const declined: ItemReason = {
    item: "mobile-push",
    item_title: "Mobile push",
    code: "declined_change",
    severity: "confirm",
    label: "Change declined",
    text: `Declined: ${ATTEMPT2_NOTE}`,
    data: { action: "change", said: "declined", note: ATTEMPT2_NOTE },
    fixes: [accept("mobile-push", "Accept decline"), fix("Apply it myself", "edit", "mobile-push", "horizon", "next")],
  };
  const notApplied: ItemReason = {
    item: "sso-login",
    item_title: "Single sign-on",
    code: "change_not_applied",
    severity: "blocking",
    label: "Change not applied",
    text: "The agents said done, but sso-login is still in the file.",
    data: { action: "drop", said: "done", note: null },
    fixes: [fix("Apply it myself", "drop", "sso-login"), fix("Waive…", "waive", "sso-login")],
  };
  const unrequested: ItemReason = {
    item: "invoice-pdf",
    item_title: "Invoice PDF",
    code: "unrequested_change",
    severity: "confirm",
    label: "Unrequested change",
    text: "Changed without being asked: outcome Finance downloads each invoice → Finance downloads every invoice as a PDF",
    data: { field: "outcome", from: "Finance downloads each invoice", to: "Finance downloads every invoice as a PDF" },
    fixes: [accept("invoice-pdf"), fix("Revert", "edit", "invoice-pdf", "outcome", "Finance downloads each invoice")],
  };
  const kept = before.reasons.filter((r) => !fixed.includes(r.code));
  const at = (item: string) => kept.findIndex((r) => r.item === item);
  kept.splice(at("mobile-push") + 1, 0, declined);
  kept.splice(at("sso-login"), 0, notApplied);
  kept.splice(at("invoice-pdf") + 1, 0, unrequested);
  const done = (id: string, field: string, requested: unknown, current: unknown) => ({
    id,
    action: "change",
    outcome: "done" as const,
    said: "done" as const,
    note: null,
    fields: [{ field, requested, applied: true, current }],
  });
  items.items_check = {
    ...withReasons({ items: 9, by_horizon: before.by_horizon, problems: [] }, kept, before.base),
    resolution: {
      review_attempt: 1,
      attempt: 2,
      entries: [
        done("slack-alerts", "milestone.date", null, null),
        done("budget-caps", "depends_on", { remove: ["anomaly-detection"] }, []),
        done("usage-export", "prd_section", "alerts-export", "alerts-export"),
        { id: "mobile-push", action: "change", outcome: "declined", said: "declined", note: ATTEMPT2_NOTE, fields: [{ field: "horizon", requested: "next", applied: false, current: "later" }] },
        { id: "sso-login", action: "drop", outcome: "not_applied", said: "done", note: null, fields: [] },
      ],
      counts: { done: 3, declined: 1, not_applied: 1, unrequested: 1 },
      unrequested: [{ id: "invoice-pdf", field: "outcome", from: "Finance downloads each invoice", to: "Finance downloads every invoice as a PDF" }],
    },
    diff: {
      against_attempt: 1,
      items: [
        { id: "slack-alerts", changes: [{ field: "milestone.date", from: "2026-11-30", to: null }] },
        { id: "budget-caps", changes: [{ field: "depends_on", from: ["anomaly-detection"], to: [] }] },
        { id: "usage-export", changes: [{ field: "prd_section", from: "export", to: "alerts-export" }] },
        { id: "invoice-pdf", changes: [{ field: "outcome", from: "Finance downloads each invoice", to: "Finance downloads every invoice as a PDF" }] },
      ],
      added: [],
      removed: [],
    },
  };
  const [cp] = run.checkpoints;
  const sent: CheckpointOut = {
    ...cp,
    id: "7a11c0de-0000-4000-8000-0000000d6c01",
    status: "changes_requested",
    decided_by: "mock-user",
    decided_at: "2026-10-20T09:30:00Z",
    payload: { ...cp.payload, wait: undefined },
  };
  cp.run_id = run.id;
  cp.created_at = "2026-10-20T10:04:00Z";
  cp.payload = { ...cp.payload, attempt: 2, items_check: items.items_check };
  run.checkpoints = [sent, cp];
  refresh(run);
  return run;
}

/** The attempt-2 run and both attempts' files, as e2e/helpers.ts seedRoadmapAttempt2 adds them. */
export const ROADMAP_REVIEW_RUN_ATTEMPT2: { run: RunOut; artifacts: Record<string, string> } = {
  run: roadmapAttempt2Run(),
  artifacts: {
    [`${ROADMAP_ATTEMPT2_RUN_ID}|1|roadmap_items.yaml`]: REVIEW_ITEMS_2,
    [`${ROADMAP_ATTEMPT2_RUN_ID}|1|roadmap_items.yaml|1`]: REVIEW_ITEMS,
  },
};

/** The roadmap review run and its file, as e2e/helpers.ts seedRoadmapReview adds them to the mock's data. */
export const ROADMAP_REVIEW_RUN: { run: RunOut; artifacts: Record<string, string> } = {
  run: roadmapReviewRun(),
  artifacts: { [`${ROADMAP_REVIEW_RUN_ID}|1|roadmap_items.yaml`]: REVIEW_ITEMS },
};

/**
 * D3's roadmap-items-console-held scenario: the same run, approved in SwarmCloud's console
 * while blocking reasons are open, so the approval is held until an approver confirms (seeded
 * by po-mock-scenario=roadmap-items-console-held, ./server.ts).
 */
export const ROADMAP_REVIEW_HELD_RUN: typeof ROADMAP_REVIEW_RUN = {
  run: {
    ...ROADMAP_REVIEW_RUN.run,
    checkpoints: ROADMAP_REVIEW_RUN.run.checkpoints.map((c, i) =>
      i === 0 ? { ...c, console: { needs: "confirm", answered_by: "Sam Lee", verdict: "MERGE", counted: false, findings: [], revise: false, can_redo: false } } : c,
    ),
  },
  artifacts: ROADMAP_REVIEW_RUN.artifacts,
};


/** The roadmap review run measured against an approved product strategy (seedRoadmapDrift in e2e/helpers.ts, H4 §5). */
export const ROADMAP_DRIFT_RUN_ID = "7a11c0de-0000-4000-8000-0000000000d8";

/**
 * H4 §5: the roadmap review run's twin with drift reasons, as the API's reasons word them:
 * Single sign-on (Next) is on the strategy's stop list and its goal under no focus choice,
 * Mobile push serves a goal under no focus choice. Advisory: both are to confirm, acted on or waived with a reason.
 */
function roadmapDriftRun(): RunOut {
  const run = JSON.parse(JSON.stringify(roadmapReviewRun()).replaceAll("0000000d2", "0000000d8")) as RunOut;
  run.id = ROADMAP_DRIFT_RUN_ID;
  run.document_slug = "usage-alerts-roadmap-5";
  const [items] = run.segments;
  const reasons = [...(items.items_check?.reasons ?? [])];
  const waive = (item: string): ReasonFix => fix("Waive…", "waive", item);
  const drift = (item: string, item_title: string, code: string, label: string, text: string, fixes: ReasonFix[], data: Record<string, unknown>): ItemReason =>
    ({ item, item_title, code, severity: "confirm", label, text, data, fixes });
  const after = (key: string, extra: ItemReason) => {
    let at = reasons.findLastIndex((x) => x.item === key);
    if (at < 0) at = reasons.length - 1;
    reasons.splice(at + 1, 0, extra);
  };
  after(
    "mobile-push",
    drift("mobile-push", "Mobile push", "outside_strategy", "Outside the strategy", "Retention is under no focus choice of the product strategy.",
      [drop("mobile-push"), waive("mobile-push")], { severity: "warning", choices: [], goals: ["retention"] }),
  );
  after(
    "sso-login",
    drift("sso-login", "Single sign-on", "stopped_but_planned", "Stopped in the strategy", "The product strategy stops Enterprise SSO, and this item is in Next.",
      [moveTo("sso-login", "later"), drop("sso-login"), waive("sso-login")], { severity: "high", choices: ["enterprise-sso"], goals: [] }),
  );
  // Review #581: an item both stopped and outside the strategy (the API's payment step).
  after(
    "sso-login",
    drift("sso-login", "Single sign-on", "outside_strategy", "Outside the strategy", "Enterprise readiness is under no focus choice of the product strategy.",
      [drop("sso-login"), waive("sso-login")], { severity: "warning", choices: [], goals: ["enterprise-readiness"] }),
  );
  items.items_check = withReasons(
    { items: items.items_check!.items, by_horizon: items.items_check!.by_horizon, problems: items.items_check!.problems },
    reasons,
    items.items_check!.base,
  );
  const [cp] = run.checkpoints;
  cp.run_id = run.id;
  cp.payload = { ...cp.payload, items_check: items.items_check };
  refresh(run);
  return run;
}

export const ROADMAP_DRIFT_RUN: { run: RunOut; artifacts: Record<string, string> } = {
  run: roadmapDriftRun(),
  artifacts: { [`${ROADMAP_DRIFT_RUN_ID}|1|roadmap_items.yaml`]: REVIEW_ITEMS },
};

/** The roadmap review run whose file cannot be read as items (seedRoadmapFileProblem in e2e/helpers.ts, D1). */
export const ROADMAP_FILE_PROBLEM_RUN_ID = "7a11c0de-0000-4000-8000-0000000000d7";

/** D1: the roadmap review run's twin whose roadmap_items.yaml is not valid YAML: one file-level problem, no items. */
function roadmapFileProblemRun(): RunOut {
  const run = JSON.parse(JSON.stringify(roadmapReviewRun()).replaceAll("0000000d2", "0000000d7")) as RunOut;
  run.id = ROADMAP_FILE_PROBLEM_RUN_ID;
  run.document_slug = "usage-alerts-roadmap-4";
  const [items] = run.segments;
  items.items_check = withReasons(
    { items: 0, by_horizon: { now: 0, next: 0, later: 0 }, problems: [{ code: "unreadable_yaml", message: "roadmap_items.yaml is not valid YAML: line 3 has a tab where spaces belong", item: null }] },
    [],
    null,
  );
  const [cp] = run.checkpoints;
  cp.run_id = run.id;
  cp.payload = { ...cp.payload, items_check: items.items_check };
  refresh(run);
  return run;
}

export const ROADMAP_FILE_PROBLEM_RUN: { run: RunOut; artifacts: Record<string, string> } = {
  run: roadmapFileProblemRun(),
  artifacts: { [`${ROADMAP_FILE_PROBLEM_RUN_ID}|1|roadmap_items.yaml`]: "version: 1\nitems:\n\t- {id: slack-alerts\n" },
};

// ---------------------------------------------------------------- F4 Engineering check

type Brief = { key: string; title: string; approach: string; size: string; depends_on: string[]; questions: { id: string; question: string; blocking: boolean }[] };
type BriefsCheck = { features: Brief[]; problems: { code: string; message: string; feature?: string | null }[]; code_map_used: boolean };
const SIZES = ["xs", "s", "m", "l", "xl"];
const VERDICTS = ["feasible", "feasible_with_changes", "not_feasible"];
const VERDICT_WORDS: Record<string, string> = { feasible: "Feasible", feasible_with_changes: "Feasible with changes", not_feasible: "Not feasible as scoped" };

/** The local runtime's briefs: one per feature of its feature set (LOCAL_FEATURE_SET). */
const LOCAL_BRIEFS: Brief[] = [
  { key: "price-early", title: "Show the price early", approach: "Compute the total on the cart page from the existing pricing call.", size: "m", depends_on: [], questions: [{ id: "q1", question: "Can the pricing call answer within 200 ms?", blocking: true }] },
  { key: "guest-checkout", title: "Guest checkout", approach: "A guest session that carries the cart to payment.", size: "l", depends_on: ["price-early"], questions: [] },
  { key: "saved-cards", title: "Saved cards", approach: "Store the payment provider's card token on the account.", size: "s", depends_on: [], questions: [] },
];

/** The "eng-check" scenario's briefs, on the baseline's own features (their efforts M, S, L). */
const SEEDED_BRIEFS: Brief[] = [
  { key: "f.guided-setup", title: "Guided setup", approach: "Reuse the onboarding checklist and add the test-order step.", size: "m", depends_on: [], questions: [{ id: "q1", question: "Does the payment sandbox take test orders without a live account?", blocking: true }, { id: "q2", question: "Show the checklist on phones too?", blocking: false }] },
  { key: "f.sample-data", title: "Sample data", approach: "A fixed catalogue copied into the new store on first sign-in.", size: "s", depends_on: [], questions: [] },
  { key: "f.saved-carts", title: "Saved carts", approach: "Keep the cart server-side and sync it on sign-in.", size: "l", depends_on: ["f.guided-setup"], questions: [] },
];

function briefsCheckOf(briefs: Brief[]): BriefsCheck {
  return { features: briefs, problems: [], code_map_used: false };
}

function briefsYaml(briefs: Brief[], attempt: number): string {
  const lines = [`# eng_review (sample, attempt ${attempt})`, "version: 1", "code_map: {used: false, repos: []}", "features:"];
  for (const b of briefs) {
    lines.push(`  - feature: ${b.key}`, `    title: ${b.title}`, `    approach: ${b.approach}`, `    size: ${b.size}`, `    depends_on: [${b.depends_on.join(", ")}]`, "    questions:");
    for (const q of b.questions) lines.push(`      - {id: ${q.id}, question: "${q.question}", blocking: ${q.blocking}}`);
    if (!b.questions.length) lines[lines.length - 1] = "    questions: []";
  }
  return lines.join("\n") + "\n";
}

const briefsOf = (cp: CheckpointOut) => ((cp.payload as { briefs_check?: BriefsCheck } | undefined)?.briefs_check ?? null);
const stagedEdit = (actions: DraftActionRow[], key: string, field: string) => actions.find((a) => a.state === "staged" && a.kind === "edit" && a.item_key === key && a.field === field);

/** As oracle.engineering.check.reasons: a verdict per feature and an answer per blocking question, never waived. */
function engReasons(cp: CheckpointOut, actions: DraftActionRow[]): { reasons: GateReason[]; files: number } | null {
  const check = briefsOf(cp);
  if (!check) return null;
  const reasons: GateReason[] = [];
  for (const f of check.features) {
    if (!stagedEdit(actions, f.key, "verdict")) reasons.push({ item: f.key, item_title: f.title, code: "no_verdict", severity: "blocking", label: "No verdict yet" });
    for (const q of f.questions) {
      if (q.blocking && !stagedEdit(actions, f.key, `answer:${q.id}`)) reasons.push({ item: f.key, item_title: f.title, code: "blocking_question", severity: "blocking", label: "Blocking question unanswered" });
    }
  }
  return { reasons, files: check.problems.length };
}

/** As oracle.engineering.check.validate: the Engineering check's vocabulary; the refusal, or null. */
function engInvalid(cp: CheckpointOut, a: Schemas["ActionIn"]): string | null {
  const f = briefsOf(cp)?.features.find((x) => x.key === a.item_key);
  if (!f) return `${a.item_key} is not a feature of the briefs`;
  if (a.kind === "question") return null;
  if (a.kind !== "edit") return "an engineering check takes edit (verdict, size, answer:<id>) or question";
  if (a.field === "verdict") {
    const v = (a.value ?? {}) as { verdict?: string; note?: string | null };
    if (!VERDICTS.includes(v.verdict ?? "")) return "verdict is feasible, feasible_with_changes or not_feasible";
    if (v.verdict !== "feasible" && !(v.note ?? "").trim()) return `${VERDICT_WORDS[v.verdict!]} needs a note saying why`;
    return null;
  }
  if (a.field === "size") return SIZES.includes(a.value as string) ? null : `size is one of ${SIZES.join(", ")}`;
  if (a.field?.startsWith("answer:")) {
    const id = a.field.slice("answer:".length);
    if (!f.questions.some((q) => q.id === id)) return `${a.item_key} has no question ${id}`;
    return typeof a.value === "string" && a.value.trim() ? null : "an answer is text of 1 to 2000 characters";
  }
  return "edit takes the field verdict, size or answer:<question id>";
}

/** As oracle.engineering.check.on_approved: the choices recorded, each changed size a person's locked effort. */
function approveEngCheck(ctx: RunsContext, r: RunOut, cp: CheckpointOut, staged: DraftActionRow[]) {
  const check = briefsOf(cp);
  if (!check) return;
  const verdicts: Record<string, unknown> = {};
  const sizes: Record<string, string> = {};
  for (const f of check.features) {
    const v = stagedEdit(staged, f.key, "verdict");
    if (v) verdicts[f.key] = { value: (v.value as { verdict: string }).verdict, note: (v.value as { note?: string | null }).note ?? null };
    sizes[f.key] = (stagedEdit(staged, f.key, "size")?.value as string | undefined) ?? f.size;
    ctx.setEffort?.(f.key, sizes[f.key], r.id);
  }
  cp.payload = { ...cp.payload, briefs: { verdicts, sizes } };
}

// ---------------------------------------------------------------- F4 lane B Engineering dates

type DateBasis = { kind: "estimate" | "capacity" | "commitment"; reference: string; supports_date: string };
type DateItem = {
  key: string;
  title: string;
  section: string | null;
  size: string | null;
  proposed: DateBasis | null;
  confidence: "low" | "medium" | "high" | null;
  assumptions: string[];
  no_date_reason: string | null;
};
type DatesSpec = { items: DateItem[]; others: { key: string; title: string; horizon: "next" | "later" }[] };
type DatesCheck = DatesSpec & { prd: { document: string; version: number } | null; problems: { code: string; message: string }[] };
const BASIS_KINDS = ["estimate", "capacity", "commitment"];

/** The local runtime's dates: the draft's Now items (LOCAL_FEATURE_SET's), one dated. */
const LOCAL_DATES: DatesSpec = {
  items: [
    { key: "price-early", title: "Show the price early", section: "features", size: "m", proposed: { kind: "estimate", reference: "est-price-early", supports_date: "2026-11-27" }, confidence: "medium", assumptions: ["The pricing call answers within 200 ms"], no_date_reason: null },
    { key: "guest-checkout", title: "Guest checkout", section: "features", size: "l", proposed: null, confidence: null, assumptions: [], no_date_reason: "Sized once the price step ships" },
  ],
  others: [{ key: "saved-cards", title: "Saved cards", horizon: "next" }],
};

/** The "eng-dates" scenario's dates: four Now items (three dated), two Next, one Later. */
const SEEDED_DATES: DatesSpec = {
  items: [
    { key: "shipping-step", title: "Shipping step", section: "shipping", size: "m", proposed: { kind: "estimate", reference: "est-shipping-step", supports_date: "2026-11-30" }, confidence: "medium", assumptions: ["The carrier rates API stays as it is"], no_date_reason: null },
    { key: "price-early", title: "Show the price early", section: "pricing", size: "s", proposed: { kind: "estimate", reference: "est-price-early", supports_date: "2026-11-20" }, confidence: "high", assumptions: [], no_date_reason: null },
    { key: "saved-addresses", title: "Saved addresses", section: "addresses", size: "l", proposed: { kind: "capacity", reference: "cap-q4-checkout", supports_date: "2026-12-11" }, confidence: "low", assumptions: ["Two engineers from Nov 16", "No change to the address lookup"], no_date_reason: null },
    { key: "cart-review", title: "Cart review step", section: null, size: "m", proposed: null, confidence: null, assumptions: [], no_date_reason: "Waits on the provider's sandbox" },
  ],
  others: [
    { key: "guest-checkout", title: "Guest checkout", horizon: "next" },
    { key: "saved-cards", title: "Saved cards", horizon: "next" },
    { key: "gift-wrap", title: "Gift wrap", horizon: "later" },
  ],
};

/** The PRD version the dates are for: the one the run's PRD draft imported. */
function datesCheckOf(r: RunOut, spec: DatesSpec): DatesCheck {
  const imp = r.segments.find((x) => x.name === "prd_draft")?.draft_import;
  const prd = r.document_slug && imp?.version ? { document: r.document_slug, version: imp.version } : null;
  return { prd, items: spec.items, others: spec.others, problems: [] };
}

function datesYaml(check: DatesCheck, attempt: number): string {
  const lines = [`# eng_dates (sample, attempt ${attempt})`, "version: 1", `prd: {document: ${check.prd?.document ?? "null"}, version: ${check.prd?.version ?? "null"}}`, "items:"];
  for (const i of check.items) {
    lines.push(`  - item: ${i.key}`);
    if (i.proposed) lines.push(`    estimate: {kind: ${i.proposed.kind}, reference: ${i.proposed.reference}, supports_date: ${i.proposed.supports_date}}`, `    confidence: ${i.confidence}`);
    else lines.push(`    no_date_reason: "${i.no_date_reason ?? ""}"`);
    lines.push(`    assumptions: [${i.assumptions.map((a) => `"${a}"`).join(", ")}]`);
  }
  return lines.join("\n") + "\n";
}

const datesOf = (cp: CheckpointOut) => ((cp.payload as { dates_check?: DatesCheck } | undefined)?.dates_check ?? null);
/** A date choice: Accept, a changed estimate, or No date. */
const isDateChoice = (a: Pick<DraftActionRow, "kind" | "field">) => a.kind === "accept" || (a.kind === "edit" && (a.field === "estimate" || a.field === "no_date"));
const validDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** As oracle.engineering.dates.reasons: each proposed date needs a staged choice, never waived. */
function datesReasons(cp: CheckpointOut, actions: DraftActionRow[]): { reasons: GateReason[]; files: number } | null {
  const check = datesOf(cp);
  if (!check) return null;
  const reasons: GateReason[] = check.items
    .filter((i) => i.proposed && !actions.some((a) => a.state === "staged" && a.item_key === i.key && isDateChoice(a)))
    .map((i) => ({ item: i.key, item_title: i.title, code: "date_undecided", severity: "blocking", label: "Date not decided yet" }));
  return { reasons, files: check.problems.length };
}

/** As oracle.engineering.dates.validate: the Engineering dates' vocabulary; the refusal, or null. */
function datesInvalid(cp: CheckpointOut, a: Schemas["ActionIn"]): string | null {
  const item = datesOf(cp)?.items.find((x) => x.key === a.item_key);
  if (!item) return `${a.item_key} is not a Now item of the draft`;
  if (a.kind === "question") return null;
  if (a.kind === "accept") return item.proposed ? null : `${a.item_key} has no proposed date to accept`;
  if (a.kind !== "edit") return "the Engineering dates take accept, edit (estimate, no_date) or question";
  if (a.field === "estimate") {
    const v = (a.value ?? {}) as Partial<DateBasis>;
    if (!BASIS_KINDS.includes(v.kind ?? "") || !(v.reference ?? "").trim() || !v.supports_date) return "an estimate needs a kind, a reference and a date";
    return validDay(v.supports_date) ? null : `not a date: ${v.supports_date}`;
  }
  if (a.field === "no_date") return ((a.value ?? {}) as { reason?: string }).reason?.trim() ? null : "No date needs a reason";
  return "edit takes the field estimate or no_date";
}

type DateDecision = { decision: "accepted" | "changed"; estimate: DateBasis } | { decision: "no_date"; reason: string };

/**
 * As oracle.engineering.dates.decisions, on Approve: each item's last staged choice (a
 * replaced one stays in the draft), else the architect's own no-date reason; the API makes
 * each accepted or changed date a verified schedule basis on the PRD.
 */
function approveEngDates(cp: CheckpointOut, staged: DraftActionRow[]) {
  const check = datesOf(cp);
  if (!check) return;
  const dates: Record<string, DateDecision> = {};
  for (const i of check.items) {
    const a = staged.filter((x) => x.item_key === i.key && isDateChoice(x)).pop();
    if (!a) {
      if (i.no_date_reason) dates[i.key] = { decision: "no_date", reason: i.no_date_reason };
    } else if (a.kind === "accept" && i.proposed) dates[i.key] = { decision: "accepted", estimate: i.proposed };
    else if (a.field === "estimate") dates[i.key] = { decision: "changed", estimate: a.value as DateBasis };
    else if (a.field === "no_date") dates[i.key] = { decision: "no_date", reason: (a.value as { reason: string }).reason };
  }
  cp.payload = { ...cp.payload, dates };
}

/** Who stages at the checkpoint (and so decides): A3's rule at an engineering stop, else its role floor. */
function mayStage(ctx: RunsContext, r: RunOut, cp: CheckpointOut, role: Schemas["Me"]["role"] | null): boolean {
  if (ENGINEERING_KINDS.includes(cp.kind) && ctx.mayDecide) return ctx.mayDecide(cp, r.flow);
  return atLeast(role, cp.approver_role);
}

// ---------------------------------------------------------------- D8 shared draft decision

const RANK: Record<Schemas["Me"]["role"], number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
/** `role` is `min` or above (lib/me hasRole); an unknown caller has every role (the seed owner). */
function atLeast(role: Schemas["Me"]["role"] | null | undefined, min: string): boolean {
  return role == null || RANK[role] >= (RANK[min as Schemas["Me"]["role"]] ?? 0);
}

/** As oracle.runs.actions.QUESTION_STOPS (discussions.changes): the stops Ask asks at. */
const QUESTION_STOPS = ["roadmap_items", "feature_set", "eng_review"];

/**
 * G4, as oracle.runs.actions.put_action with a source: a discussion change's D8 action at a
 * waiting stop, shown on the review screen as from the discussion. `mode`: "stage" needs the
 * stop's approver role, "suggest" only suggests, "auto" stages when the caller may (Ask).
 * A question asks through C2 (`ctx.ask`). Never applied at once (C7 applies only an
 * approver's own row edit).
 */
export function putDiscussionAction(
  ctx: RunsContext,
  at: { run_id: string; checkpoint_id: string },
  a: Schemas["ActionIn"],
  source: { discussion_id: string; change_id: string; from_private: boolean },
  mode: "stage" | "suggest" | "auto",
): { id: string; question_id: string | null } | Response {
  const r = ctx.db.runs.find((x) => x.id === at.run_id);
  const cp = r?.checkpoints.find((c) => c.id === at.checkpoint_id);
  if (!r || !cp) return fail(404, `checkpoint ${at.checkpoint_id} not found`);
  if (cp.status !== "pending") return fail(409, "this checkpoint is decided");
  const me = ctx.member ?? null;
  const role = me?.role ?? ctx.userRole ?? null;
  const may = mayStage(ctx, r, cp, role);
  if (mode === "stage" && !may) return fail(403, `Requires the ${cp.approver_role} role`);
  const stages = may && mode !== "suggest";
  const draft = draftOf(ctx, cp.id);
  const who = me?.id ?? ctx.userId;
  const existing = draft.actions.find((x) => x.item_key === a.item_key && x.kind === a.kind && (x.field ?? "") === (a.field ?? ""));
  const row: DraftActionRow = {
    id: existing?.id ?? ctx.uuid(),
    item_key: a.item_key,
    kind: a.kind,
    field: a.field ?? null,
    value: a.value ?? null,
    answers: a.answers ?? [],
    note: a.note ?? null,
    state: stages ? "staged" : "suggested",
    created_by: who,
    updated_by: who,
    updated_at: ctx.now(),
    origin: "discussion",
    discussion_id: source.discussion_id,
    discussion_change_id: source.change_id,
    from_private: source.from_private,
    question_id: null,
  };
  if (a.kind === "question" && ctx.ask) {
    if (existing?.question_id) ctx.withdraw?.(existing.question_id);
    const v = (a.value ?? {}) as { asked_to?: string; text?: string };
    row.question_id = ctx.ask({ asked_to: v.asked_to ?? "", prompt: v.text ?? "", checkpoint_id: cp.id, item_ref: a.item_key });
  }
  draft.actions = existing ? draft.actions.map((x) => (x === existing ? row : x)) : [...draft.actions, row];
  bump(draft, displayName(me?.email ?? ctx.userName ?? "admin@example.com"));
  return { id: row.id, question_id: row.question_id ?? null };
}

/** Whether Ask on this stop is its D8 question action (a waiting stop that takes questions). */
export function asksAtStop(ctx: Pick<RunsContext, "db">, at: { run_id: string; checkpoint_id: string }): boolean {
  const cp = ctx.db.runs.find((x) => x.id === at.run_id)?.checkpoints.find((c) => c.id === at.checkpoint_id);
  return !!cp && cp.status === "pending" && QUESTION_STOPS.includes(cp.kind);
}

/**
 * As oracle.staging.service._scope_action: the waiting feature-set stop whose proposed scope
 * holds `named` (a feature's or requirement's row id or baseline entity id), the
 * discussion's own run first, then the newest; with nothing named, the subject's item at
 * that stop. Its row key; null when no such stop waits. The mock's rows link no entity
 * (`entity_id` null), so `keysOf` stands in: the row keys a baseline entity's id reads as
 * (the API links a row to the entity of its key).
 */
export function scopeStop(
  ctx: Pick<RunsContext, "db">,
  named: string | null,
  own: { run_id: string | null; checkpoint_id?: string | null; item_key?: string | null },
  keysOf: (entityId: string) => string[] = () => [],
): { run_id: string; checkpoint_id: string; item_key: string } | null {
  const keys = named === null ? [] : keysOf(named);
  const names = (row: { id: string; key: string; entity_id?: string | null }) => row.id === named || row.entity_id === named || keys.includes(row.key);
  const runs = [...ctx.db.runs].sort((x, y) => Number(y.id === own.run_id) - Number(x.id === own.run_id));
  for (const r of runs) {
    const cp = r.checkpoints.find((c) => c.kind === "feature_set" && c.status === "pending");
    const scope = (ctx.db.scopes?.[r.id] ?? []).filter((x) => x.status === "proposed").pop();
    if (!cp || !scope) continue;
    if (named === null && cp.id !== own.checkpoint_id) continue;
    for (const f of scope.features) {
      if (named === null ? f.key === own.item_key : names(f)) return { run_id: r.id, checkpoint_id: cp.id, item_key: f.key };
      const req = named === null ? undefined : f.requirements.find(names);
      if (req) return { run_id: r.id, checkpoint_id: cp.id, item_key: req.key };
    }
  }
  return null;
}

function draftOf(ctx: RunsContext, cpId: string): DraftRow {
  ctx.db.drafts ??= {};
  return (ctx.db.drafts[cpId] ??= { revision: 0, note: null, actions: [], log: [] });
}

function bump(draft: DraftRow, by: string) {
  draft.revision += 1;
  draft.log.push({ revision: draft.revision, by });
}

function reviewChanged(draft: DraftRow, expected: number) {
  const since = draft.log.filter((l) => l.revision > expected);
  const by = [...new Set(since.map((l) => l.by))];
  const changes = Math.max(draft.revision - expected, 0) || since.length;
  const who = by.length < 2 ? by.join("") : `${by.slice(0, -1).join(", ")} and ${by[by.length - 1]}`;
  const message = `The review changed since you loaded it (${changes} change${changes === 1 ? "" : "s"}${who ? ` by ${who}` : ""}): look again, then decide.`;
  return { code: "review_changed", revision: draft.revision, changes, by, message };
}

/** As oracle.runs.actions.wait_info: the SwarmCloud wait the checkpoint's step is parked in. */
function waitOf(payload: CheckpointOut["payload"]): Schemas["WaitInfo"] {
  const wait = (payload?.wait ?? {}) as { workflow_id?: string; expires_at?: string; ended?: string };
  if (!wait.workflow_id && !wait.expires_at && !wait.ended) return { state: "none", ends_at: null, seconds_left: null };
  if (wait.ended) return { state: "ended", ends_at: null, seconds_left: null };
  if (!wait.expires_at) return { state: "open", ends_at: null, seconds_left: null };
  const left = Math.floor((Date.parse(wait.expires_at) - Date.now()) / 1000);
  if (left <= 0) return { state: "ended", ends_at: null, seconds_left: null };
  return { state: "open", ends_at: wait.expires_at, seconds_left: left };
}

const KINDS = ["accept", "edit", "drop", "restore", "split", "merge", "question", "waive", "look_again", "add"];

/** GET .../review and the four writes (oracle.runs.actions), over the stored items check. */
async function routeDraft(ctx: RunsContext, r: RunOut, cp: CheckpointOut, req: Request, rest: string[]): Promise<Response> {
  const m = req.method;
  const me = ctx.member ?? null;
  const role = me?.role ?? ctx.userRole ?? null;
  const draft = draftOf(ctx, cp.id);
  const out = () => json(200, reviewOut(ctx, r, cp, draft, role));
  if (rest[0] === "review" && rest.length === 1 && m === "GET") return out();
  const stage = (rest[0] === "actions" && rest[2] === "stage") || rest[0] === "note";
  const stages = mayStage(ctx, r, cp, role);
  if (stage && !stages) return fail(403, ENGINEERING_KINDS.includes(cp.kind) && ctx.mayDecide ? LEAD_ONLY : `Requires the ${cp.approver_role} role`);
  if (!atLeast(role, "commenter")) return fail(403, "Requires the commenter role");
  if (cp.status !== "pending") return fail(409, "this checkpoint is decided");
  const who = me?.id ?? ctx.userId;
  const name = displayName(me?.email ?? ctx.userName ?? "admin@example.com");
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;
  if (rest[0] === "note" && m === "PUT") {
    const { note } = await body<Schemas["DraftNoteIn"]>();
    if (note != null && note.length > 10_000) return fail(422, "note: at most 10,000 characters");
    const next = note?.trim() ? note : null;
    if (next !== draft.note) {
      draft.note = next;
      bump(draft, name);
    }
    return out();
  }
  if (rest[0] === "actions" && rest.length === 1 && m === "POST") {
    const a = await body<Schemas["ActionIn"]>();
    if (!KINDS.includes(a.kind)) return fail(422, `unknown action kind ${a.kind}: one of ${KINDS.join(", ")}`);
    if (cp.kind === "eng_review") {
      const invalid = engInvalid(cp, a);
      if (invalid) return fail(422, invalid);
    }
    if (cp.kind === "eng_dates") {
      const invalid = datesInvalid(cp, a);
      if (invalid) return fail(422, invalid);
    }
    // C7: the feature set's vocabulary: edit a field of a row, add a requirement, accept, waive, question.
    if (cp.kind === "feature_set") {
      if (!["edit", "add", "accept", "waive", "question"].includes(a.kind)) return fail(422, `a feature set takes edit, add, accept, waive or question, not ${a.kind}`);
      if (a.kind === "edit" && !SCOPE_EDIT_FIELDS.includes(a.field ?? "")) return fail(422, `field: one of ${SCOPE_EDIT_FIELDS.join(", ")}`);
    }
    if (a.kind === "waive") {
      // D3: never a date or the whole file; the approver's alone (a commenter cannot suggest one).
      if (a.item_key === "*") return fail(422, FILE_NOT_WAIVED);
      if (cp.kind === "priority_order") return fail(422, "a priority order checkpoint takes no item actions");
      if ((a.answers ?? []).some((code) => !waivable(cp.kind, code))) return fail(422, cp.kind === "feature_set" ? UNKNOWN_NOT_WAIVED : DATE_NOT_WAIVED);
      if (!stages) return fail(403, `Only the ${cp.approver_role} role or above waives a problem`);
      // H4 §5, as the API: only an owner waives a planned item the product strategy stops.
      if (cp.kind === "roadmap_items" && (a.answers ?? []).includes("stopped_but_planned") && !atLeast(role, "owner")) {
        return fail(403, "Only an owner waives an item the product strategy stops");
      }
      // B2: Leave proposed is for a goal from this run nobody decided, with a reason.
      if (cp.kind === "baseline_confirm") {
        if (!liveOf(ctx, cp, draft.actions)?.some((x) => x.item === a.item_key)) return fail(422, "only an undecided goal from this run is waived (Leave proposed)");
        if (!(a.value as { reason?: string } | null)?.reason?.trim()) return fail(422, "a waiver needs a reason");
      }
    }
    // As the API: an owner's waiver of Stopped in the strategy is its own action.
    const field = a.kind === "waive" && cp.kind === "roadmap_items" ? ((a.answers ?? []).some((c) => OWNER_WAIVES.includes(c)) ? "owner" : null) : (a.field ?? null);
    const existing = draft.actions.find((x) => x.item_key === a.item_key && x.kind === a.kind && (x.field ?? "") === (field ?? ""));
    if (existing && !stages && existing.created_by !== who) return fail(403, "Only its author or an approver can change this action");
    if (cp.kind === "feature_set" && stages && (a.kind === "edit" || a.kind === "add")) {
      // C7, as the API: an approver's own edit or add changes the row at once (nothing staged).
      const refused = applySuggestion(ctx, r.id, { ...a, field: a.field ?? null, value: a.value ?? null } as DraftActionRow, who);
      if (refused) return refused;
      draft.actions = draft.actions.filter((x) => x !== existing);
      bump(draft, name);
      return out();
    }
    const row: DraftActionRow = {
      id: existing?.id ?? ctx.uuid(),
      item_key: a.item_key,
      kind: a.kind,
      field,
      value: a.value ?? null,
      answers: mergedAnswers(a, existing),
      note: a.note ?? null,
      state: stages ? "staged" : "suggested",
      created_by: who,
      updated_by: who,
      updated_at: ctx.now(),
    };
    if (a.kind === "question" && ctx.ask) {
      // C2: asked through the questions store; a changed question withdraws the one before.
      if (existing?.question_id) ctx.withdraw?.(existing.question_id);
      const v = (a.value ?? {}) as { asked_to?: string; text?: string };
      row.question_id = ctx.ask({ asked_to: v.asked_to ?? "", prompt: v.text ?? "", checkpoint_id: cp.id, item_ref: a.item_key });
    }
    draft.actions = existing ? draft.actions.map((x) => (x === existing ? row : x)) : [...draft.actions, row];
    bump(draft, name);
    return out();
  }
  const action = draft.actions.find((x) => x.id === rest[1]);
  if (rest[0] === "actions" && !action) return fail(404, `action ${rest[1]} not found`);
  if (action && rest[2] === "stage" && m === "POST") {
    // C7: an approver's Accept of a suggested edit or add applies it to the scope row, and the action goes.
    if (cp.kind === "feature_set" && action.state === "suggested" && (action.kind === "edit" || action.kind === "add")) {
      const refused = applySuggestion(ctx, r.id, action, who);
      if (refused) return refused;
      draft.actions = draft.actions.filter((x) => x !== action);
      bump(draft, name);
      return out();
    }
    if (action.state !== "staged") {
      Object.assign(action, { state: "staged", updated_by: who, updated_at: ctx.now() });
      bump(draft, name);
    }
    return out();
  }
  if (action && rest.length === 2 && m === "DELETE") {
    if (action.created_by !== who && !stages) return fail(403, "Only its author or an approver can undo this action");
    if (action.question_id) ctx.withdraw?.(action.question_id);
    draft.actions = draft.actions.filter((x) => x !== action);
    bump(draft, name);
    return out();
  }
  return fail(404, "Route not found");
}

function reviewOut(ctx: RunsContext, r: RunOut, cp: CheckpointOut, draft: DraftRow, role: Schemas["Me"]["role"] | null): Schemas["CheckpointReview"] {
  const people = new Map((ctx.members ?? []).map((x) => [x.id, x]));
  const person = (id: string | null): Schemas["ReviewPerson"] | null => {
    if (!id) return null;
    const found = people.get(id);
    return { id, name: found ? displayName(found.email) : "Someone", role: found?.role ?? null };
  };
  const seg = r.segments.find((s) => s.seq === cp.segment_seq);
  const check = cp.kind === "roadmap_items" ? (seg?.items_check ?? null) : null;
  const reasons = check?.reasons ?? [];
  // D1: the file's items first, in order, with their fields (as oracle.runs.actions reads the
  // checked file); then the items only the reasons or the actions name (no position).
  const file = check ? fileItems(ctx.db.artifacts[`${r.id}|${cp.segment_seq}|roadmap_items.yaml`] ?? "") : [];
  const inFile = new Map(file.map((f) => [f.key, f]));
  const keys = [...new Set([...file.map((f) => f.key), ...reasons.map((x) => x.item), ...draft.actions.map((a) => a.item_key)])];
  const waiting = new Map<string, Schemas["WaitingOn"]>();
  // A question action's stakeholder question (C2): asked of a member, answered in value.answer.
  const questionOf = (a: DraftActionRow): Schemas["ReviewQuestion"] | null => {
    if (a.kind !== "question") return null;
    const v = (a.value ?? {}) as { asked_to?: string; text?: string; answer?: string | null; answered_by?: string | null };
    const to = person(v.asked_to ?? null);
    const stored = a.question_id ? ctx.asked?.(a.question_id) : null;
    if (stored) {
      return {
        id: a.question_id!,
        status: stored.status === "answered" ? "answered" : stored.status === "withdrawn" ? "withdrawn" : "open",
        text: v.text ?? "",
        asked_to: to ? { id: to.id, name: to.name } : null,
        answer: stored.answer ? { kind: "answer", body: stored.answer, answered_by: to ? { id: to.id, name: to.name } : null } : null,
      };
    }
    return {
      id: a.id,
      status: v.answer ? "answered" : "open",
      text: v.text ?? "",
      asked_to: to ? { id: to.id, name: to.name } : null,
      answer: v.answer ? { kind: "text", body: v.answer, answered_by: to ? { id: to.id, name: to.name } : null } : null,
    };
  };
  const tally: Schemas["ReviewTally"] = { need_you: 0, handled: 0, blocking_open: 0, to_confirm_open: 0, waiting_on: [], suggested: 0 };
  const items: Schemas["ReviewItem"][] = keys.map((key) => {
    const mine = draft.actions.filter((a) => a.item_key === key);
    const theirs = reasons.filter((x) => x.item === key);
    const answered = (x: (typeof reasons)[number]) =>
      mine.some((a) => a.state === "staged" && answersCode(a, x.code));
    const open = theirs.filter((x) => !answered(x));
    const asked = mine.map(questionOf).filter((q): q is Schemas["ReviewQuestion"] => q?.status === "open");
    for (const q of asked) {
      if (!q.asked_to?.id) continue;
      const row = waiting.get(q.asked_to.id) ?? { user_id: q.asked_to.id, name: q.asked_to.name, count: 0 };
      row.count += 1;
      waiting.set(q.asked_to.id, row);
    }
    const state = theirs.length === 0 ? "fine" : open.length === 0 ? "handled" : asked.length ? "waiting" : "needs_you";
    tally.need_you += state === "needs_you" ? 1 : 0;
    tally.handled += state === "handled" ? 1 : 0;
    tally.blocking_open += open.filter((x) => x.severity === "blocking").length;
    tally.to_confirm_open += open.filter((x) => x.severity === "confirm").length;
    tally.suggested += mine.filter((a) => a.state === "suggested").length;
    const item = inFile.get(key);
    return {
      key,
      position: item?.position ?? null,
      title: item?.title ?? theirs[0]?.item_title ?? key,
      horizon: item?.horizon ?? null,
      milestone: item?.milestone ?? null,
      confidence: item?.confidence ?? null,
      rank: item?.rank ?? null,
      outcome: item?.outcome ?? null,
      depends_on: item?.depends_on ?? [],
      prd_section: item?.prd_section ?? null,
      reasons: theirs,
      actions: mine.map((a) => ({
        id: a.id,
        item_key: a.item_key,
        kind: a.kind,
        field: a.field,
        value: a.value,
        answers: a.answers,
        state: a.state,
        note: a.note,
        created_by: person(a.created_by),
        updated_by: person(a.updated_by),
        updated_at: a.updated_at,
        question: questionOf(a),
      })),
      state,
      // D6: the item's answer to the review and its changes since the previous attempt.
      resolution: check?.resolution?.entries.find((e) => e.id === key) ?? null,
      diff: check?.diff?.items.find((d) => d.id === key)?.changes ?? [],
    };
  });
  tally.waiting_on = [...waiting.values()];
  const pending = cp.status === "pending";
  const stages = pending && mayStage(ctx, r, cp, role);
  return {
    checkpoint_id: cp.id,
    run_id: r.id,
    kind: cp.kind,
    status: cp.status,
    approver_role: cp.approver_role,
    attempt: (cp.payload?.attempt as number | undefined) ?? null,
    revision: draft.revision,
    wait: waitOf(cp.payload),
    file: check ? { name: "roadmap_items.yaml", seq: cp.segment_seq ?? 1 } : null,
    file_problems: (check?.problems ?? []).filter((x) => !x.item),
    items,
    tally,
    note: draft.note,
    sent_review: pending ? null : (cp.review ?? null),
    sent_review_yaml: !pending && cp.review && cp.review.kind !== "edits" ? renderReview(cp.review, cp.decided_at) : null,
    can_read: true,
    can_suggest: pending && atLeast(role, "commenter"),
    can_stage: stages,
    can_decide: stages,
    gate: gateNow(ctx, cp, draft.actions),
    diff: check?.diff ?? null,
  };
}

// --------------------------------------------------------------------------- review file (D4)

type Review = Record<string, unknown> & { items: Record<string, unknown>[] };
const REVIEW_KEYS = ["version", "checkpoint", "run", "segment", "attempt", "file", "items", "unchanged", "problems_open", "waived", "general_note"];
// Written after the fixed keys when a review has them: D10's locked sections.
const REVIEW_OPTIONAL_KEYS = ["locked_sections"];
const RENAMED: Record<string, [string, string]> = { milestone_date: ["milestone", "date"], milestone_name: ["milestone", "name"] };

/** As oracle.runs.review_file.build_review, for roadmap_items (other kinds: the note alone). */
function buildReview(ctx: RunsContext, r: RunOut, cp: CheckpointOut, staged: DraftActionRow[], note: string | null): Review {
  const seg = r.segments.find((s) => s.seq === cp.segment_seq);
  const items = cp.kind === "roadmap_items" ? [...(ctx.db.artifacts[`${r.id}|${cp.segment_seq}|roadmap_items.yaml`] ?? "").matchAll(/^\s*- \{?id: ([\w-]+)/gm)].map((x) => x[1]) : [];
  const reasons = cp.kind === "roadmap_items" ? (seg?.items_check?.reasons ?? []) : [];
  const entries: Record<string, unknown>[] = [];
  const waived: Record<string, unknown>[] = [];
  if (cp.kind === "roadmap_items") {
    const keys = [...new Set(staged.map((a) => a.item_key))].sort((x, y) => (items.indexOf(x) + 1 || 1e9) - (items.indexOf(y) + 1 || 1e9));
    for (const key of keys) {
      const mine = staged.filter((a) => a.item_key === key);
      const edits = mine.filter((a) => a.kind === "edit");
      for (const a of mine) {
        if (a.kind === "waive") {
          const codes = a.answers?.length ? a.answers : reasons.filter((x) => x.item === key && !OWNER_WAIVES.includes(x.code)).map((x) => x.code);
          for (const code of codes.length ? codes : [null]) waived.push({ id: key, code, reason: (a.value as { reason?: string } | null)?.reason ?? null });
          continue;
        }
        if (a.kind === "edit" && a !== edits[0]) continue;
        const group = a.kind === "edit" ? edits : [a];
        const entry: Record<string, unknown> = { id: key, action: a.kind === "edit" ? "change" : a.kind };
        if (a.kind === "edit") {
          const changes: Record<string, unknown> = {};
          for (const e of edits) {
            const f = e.field ?? "";
            if (f === "order") entry.reorder = true;
            else if (f.startsWith("clear:")) changes[f.slice(6)] = null;
            else if (RENAMED[f]) changes[RENAMED[f][0]] = { ...((changes[RENAMED[f][0]] as object | undefined) ?? {}), [RENAMED[f][1]]: e.value };
            else changes[f] = e.value;
          }
          if (Object.keys(changes).length) entry.changes = changes;
        }
        const answers = [...new Set(group.flatMap((g) => g.answers ?? []))];
        if (answers.length) entry.answers = answers;
        const notes = group.map((g) => g.note).filter(Boolean);
        if (notes.length) entry.note = notes.join(" ");
        entries.push(entry);
      }
    }
  }
  const open = reasons.filter((x) => !staged.some((a) => a.item_key === x.item && answersCode(a, x.code)));
  // qa-work-1: a feature set sends the rows a person changed (as the API's sent_review).
  const scoped = cp.kind === "feature_set" ? scopeSendBack(ctx.db, r.id, staged) : null;
  if (scoped) {
    entries.push(...scoped.entries);
    waived.push(...scoped.waived);
    items.push(...scoped.keys);
  }
  const entered = new Set([...entries, ...waived].map((e) => e.id));
  return {
    version: 1,
    checkpoint: cp.kind,
    run: r.id,
    segment: seg?.name ?? null,
    attempt: (cp.payload?.attempt as number | undefined) ?? null,
    file: cp.kind === "roadmap_items" ? "roadmap_items.yaml" : scoped ? "feature_set.yaml" : null,
    items: entries,
    unchanged: items.filter((k) => !entered.has(k) && !open.some((x) => x.item === k)),
    problems_open: open.filter((x) => x.severity === "blocking").map((x) => ({ id: x.item, code: x.code, text: x.text })),
    waived,
    general_note: note,
  };
}

/**
 * D10: a run review's send-back is D4's review of the document's own feedback (as the API's
 * review_file.document_review): one entry per open or staged feedback item, the version's
 * locked sections, the note as general_note.
 */
function documentReview(ctx: RunsContext, r: RunOut, cp: CheckpointOut, reviewed: { document_id: string; version: number }, note: string | null): Review {
  const mine = ctx.feedback.filter((f) => f.document_id === reviewed.document_id && f.raised_on_version <= reviewed.version);
  const entry = (f: FeedbackRow) => ({ id: f.id, section: f.section_key ?? "general", action: "change", summary: f.summary });
  const staged = mine.filter((f) => ctx.staged?.(f.id));
  const kind = ctx.documents.find((d) => d.id === reviewed.document_id)?.kind ?? "prd";
  return {
    ...buildReview(ctx, r, cp, [], note),
    file: `${kind}.md`,
    items: [
      ...mine.filter((f) => f.status === "open" && !ctx.staged?.(f.id)).map(entry),
      ...staged.map((f) => ({ ...entry(f), accepted_text: ctx.stagedText?.(f.id) ?? null })),
    ],
    locked_sections: ctx.lockedSections?.(reviewed.document_id, reviewed.version) ?? [],
  };
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return /^[\w][\w .,/-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|[\d.+-]+)$/i.test(v) ? v : JSON.stringify(v);
  return String(v);
}

function yamlLines(v: unknown, indent: string): string[] {
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      if (x && typeof x === "object") {
        const [first, ...rest] = yamlLines(x, indent + "  ");
        return [`${indent}- ${first.trimStart()}`, ...rest];
      }
      return [`${indent}- ${yamlScalar(x)}`];
    });
  }
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => {
    if (Array.isArray(x)) return x.length ? [`${indent}${k}:`, ...yamlLines(x, indent)] : [`${indent}${k}: []`];
    if (x && typeof x === "object") return Object.keys(x).length ? [`${indent}${k}:`, ...yamlLines(x, indent + "  ")] : [`${indent}${k}: {}`];
    return [`${indent}${k}: ${yamlScalar(x)}`];
  });
}

/** As oracle.runs.review_file.render_yaml: the two header comments, then the fixed keys. */
function renderReview(review: Record<string, unknown>, decidedAt: string | null | undefined): string {
  const words: Record<string, string> = { roadmap_items: "Roadmap items" };
  const kind = String(review.checkpoint);
  const what = (review.file as string | null) ?? `the ${review.segment ?? kind} output`;
  const attempt = review.attempt ? `, attempt ${review.attempt}` : "";
  const on = decidedAt ? ` on ${companyDayIso(decidedAt)}` : "";
  const label = words[kind] ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const ordered = Object.fromEntries([...REVIEW_KEYS.map((k) => [k, review[k] ?? null]), ...REVIEW_OPTIONAL_KEYS.filter((k) => k in review).map((k) => [k, review[k]])]);
  return [`# Review of ${what}${attempt}, at the ${label} checkpoint.`, `# Sent back by an approver${on}. Apply each entry; answer each in resolutions.`, ...yamlLines(ordered, ""), ""].join("\n");
}

// ---------------------------------------------------------------- D9 Inbox checkpoint counts

const SEVERITY = { blocking: 0, confirm: 1 } as const;

/** As oracle.runs.actions._determined: a fix that only stages, needs no text and one click undoes. */
function determined(kind: string, field: string | null | undefined, value: unknown): boolean {
  if (kind === "accept") return true;
  if (kind !== "edit") return false;
  const v = value as Record<string, unknown> | null;
  if (field === "horizon") return ["now", "next", "later"].includes(value as string);
  if (field === "milestone_date") return value == null;
  if (field === "depends_on") return !!v && Object.keys(v).join() === "remove" && Array.isArray(v.remove) && v.remove.length > 0;
  if (field === "order") return value == null || (!!v && Object.keys(v).join() === "after" && typeof v.after === "string" && !!v.after);
  return false;
}

/** As oracle.runs.actions.inbox_summary: the review's tally and up to three items still needing me, blocking first. */
function inboxSummary(ctx: RunsContext, r: RunOut, cp: CheckpointOut): Schemas["InboxSummary"] | null {
  if (cp.kind !== "roadmap_items" && cp.kind !== "baseline_confirm") return null;
  const role = ctx.member?.role ?? ctx.userRole ?? null;
  const draft = ctx.db.drafts?.[cp.id] ?? { revision: 0, note: null, actions: [], log: [] };
  const review = reviewOut(ctx, r, cp, draft, role);
  if (cp.kind === "baseline_confirm") {
    // B2: Confirm the baseline's counts, read from the run's rows.
    const t = ctx.baselineReview?.(r.id, draft.actions).summary;
    if (!t) return null;
    const none = { waiting_on: 0, children: [], more: 0, title: null, source: null, sections: null };
    return { ...t, ...none, wait: review.wait, console_held: cp.console?.needs === "confirm" && t.blocking > 0 };
  }
  const answers = (a: Schemas["ReviewAction"], x: ItemReason) =>
    a.state === "staged" && answersCode(a, x.code);
  const first = (xs: ItemReason[]) => [...xs].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])[0];
  const rows: { order: [number, number]; child: Schemas["InboxChild"] }[] = [];
  for (const it of review.items) {
    const reasons = it.reasons ?? [];
    const acts = it.actions ?? [];
    // An item fixed earlier (handled) never takes a slot.
    if (!reasons.length || it.state !== "needs_you") continue;
    const shown = first(reasons.filter((x) => !acts.some((a) => answers(a, x))));
    const fix = (shown.fixes ?? []).find((f) => f.action.item === it.key && determined(f.action.kind, f.action.field, f.action.value)) ?? null;
    rows.push({
      order: [SEVERITY[shown.severity], it.position ?? 1e6],
      child: {
        item: it.key,
        title: it.title ?? null,
        reason: { code: shown.code, severity: shown.severity, label: shown.label, text: shown.text },
        fix,
        staged: null,
        suggested: acts.find((a) => a.state === "suggested" && a.kind !== "question") ?? null,
      },
    });
  }
  rows.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  const shown = rows.slice(0, 3);
  const t = review.tally;
  const doc = ctx.documents.find((d) => d.slug === r.document_slug);
  return {
    need_you: t.need_you ?? 0,
    blocking: t.blocking_open ?? 0,
    to_confirm: t.to_confirm_open ?? 0,
    handled: t.handled ?? 0,
    waiting_on: review.items.filter((i) => i.state === "waiting").length,
    wait: review.wait,
    children: shown.map((x) => x.child),
    more: (t.need_you ?? 0) - shown.length,
    title: doc?.title ?? null,
    source: r.source ? { title: r.source.title, version: r.source.version } : null,
    sections: null,
    console_held: cp.console?.needs === "confirm" && (t.blocking_open ?? 0) > 0,
  };
}

// ---------------------------------------------------------------- E1 draft roadmap items

/**
 * E1: the run Oracle's ticker starts for a PRD draft's items (./draft-roadmap.ts): flow
 * prd_draft_items on that version at standard depth, its roadmap_items checkpoint off,
 * created by whoever imported the version (or clicked Derive), running at once.
 */
export function startDraftItemsRun(
  db: RunsDb,
  args: { uuid: () => string; now: string; createdBy: string; source: VersionSource; depth?: "quick" | "standard" | "deep" },
): RunOut {
  const flow = flowOf(DRAFT_ITEMS_FLOW);
  const knobs = resolveKnobs(DRAFT_ITEMS_FLOW, { depth: args.depth ?? "standard", checkpoints: { roadmap_items: false } }) as RunOut["knobs"];
  const segments = segmentsFor(DRAFT_ITEMS_FLOW, knobs, args.uuid);
  for (const s of segments) s.estimate_usd = segEstimate(s.roles, knobs.depth);
  const [items] = segments;
  Object.assign(items, {
    status: "running",
    started_at: args.now,
    workflow_id: `mock-wf-${args.uuid().slice(0, 8)}`,
    attempts: [{ attempt: 1, workflow_id: "mock-wf-draft-items", submitted_at: args.now, cost_usd: 0, note: null, note_by: null, state: "running" }],
  });
  const estimate = round2(segments.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0));
  const run: RunOut = {
    id: args.uuid(),
    flow: DRAFT_ITEMS_FLOW,
    flow_title: flow.title,
    status: "running",
    document_id: null,
    document_slug: null,
    document_kind: null,
    source: args.source,
    template: null,
    theme: null,
    estimate_usd: estimate,
    spent_usd: 0,
    created_by: args.createdBy,
    created_at: args.now,
    started_at: args.now,
    finished_at: null,
    waiting_on: null,
    error: null,
    can_retry: false,
    can_stop_cancelling: false,
    can_retry_lookup: false,
    cancel_again: [],
    can_dismiss_overrun: false,
    can_decide: false,
    can_retry_import: false,
    knobs,
    snapshot_id: args.uuid(),
    snapshot_as_of: args.now,
    approved_by: null,
    approved_at: null,
    needs_approval: false,
    overrun_ceiling_usd: round2(estimate * FACTOR),
    runtime: "fake",
    notes: FLOW_CATALOG.runtime_notes,
    note_refs: [],
    segments,
    checkpoints: [],
    token_read_only: false,
    open_proposals: 0,
  };
  refresh(run);
  db.runs.push(run);
  return run;
}

/** E1: the agents finish a draft's items run (90% of its estimate); its checkpoint is recorded skipped. */
export function finishDraftItemsRun(db: RunsDb, runId: string | null, args: { uuid: () => string; now: string }) {
  const run = db.runs.find((r) => r.id === runId);
  if (!run || run.status !== "running") return;
  const [s] = run.segments;
  const a = s.attempts[s.attempts.length - 1];
  if (a) Object.assign(a, { cost_usd: round2((s.estimate_usd ?? 0) * 0.9), state: "succeeded" });
  Object.assign(s, { status: "succeeded", cost_usd: round2((s.estimate_usd ?? 0) * 0.9), artifacts: ["roadmap_items.yaml"], finished_at: args.now });
  run.checkpoints.push({
    id: args.uuid(), run_id: run.id, kind: "roadmap_items", status: "skipped", approver_role: "approver",
    segment_seq: s.seq, decided_by: null, decided_at: args.now, note: "No checkpoint: draft items are reviewed on the Roadmap tab", payload: {},
    created_at: args.now, can_decide: false, lead_stop: false, cannot_approve: null, approve_label: "Approve", needs_agents: [],
  });
  Object.assign(run, { status: "succeeded", finished_at: args.now });
  refresh(run);
}

// --------------------------------------------------------------------------- C7 scope review

/** The runs the "scope-review" scenario seeds (C7): attempt 1, attempt 2, and a held console approval. */
export const SCOPE_REVIEW_RUN = "7a11c0de-0000-4000-8000-0000000000f6";
export const SCOPE_ATTEMPT2_RUN = "7a11c0de-0000-4000-8000-0000000000f7";
export const SCOPE_CONSOLE_RUN = "7a11c0de-0000-4000-8000-0000000000f8";

type SpecFeature = FeatureSetSpec["features"][number];
const req = (key: string, text: string, acceptance: string[]) => ({ key, text, acceptance });
const SAVED: SpecFeature = {
  key: "saved-addresses",
  title: "Saved addresses",
  summary: "Returning buyers pick a saved address at checkout",
  goals: [{ key: "g.paid-conversion", contribution: 3 }],
  depends_on: ["address-lookup"],
  confidence: 0.8,
  requirements: [
    req("saved-addresses-pick", "The buyer picks one of up to five saved addresses", ["Five addresses at most", "The last used one is preselected"]),
    req("saved-addresses-save", "A new address can be saved while paying", ["Saving is opt-in"]),
    req("saved-addresses-remove", "The buyer removes a saved address from their account", ["Removed addresses are gone at the next checkout"]),
  ],
};
const LOOKUP: SpecFeature = {
  key: "address-lookup",
  title: "Address lookup",
  summary: "The buyer finds their address from a postcode",
  goals: [{ key: "g.activation", contribution: 2 }],
  depends_on: [],
  confidence: 0.75,
  requirements: [
    req("address-lookup-postcode", "A postcode lists the matching addresses", ["Results show within a second"]),
    req("address-lookup-manual", "The buyer can type the address by hand", ["Manual entry is one tap away"]),
  ],
};
const BULK: SpecFeature = {
  key: "bulk-edit",
  title: "Bulk edit",
  summary: "Business buyers update many saved addresses at once",
  goals: [{ key: "g.paid-conversion", contribution: 1 }],
  depends_on: ["saved-addresses", "address-book-export"],
  confidence: 0.7,
  requirements: [
    req("bulk-edit-import", "A buyer uploads a file of address changes", ["Up to 200 rows"]),
    req("bulk-edit-review", "The buyer reviews each change before it is saved", ["Rejected rows are listed"]),
  ],
};
const LABELS: SpecFeature = {
  key: "address-labels",
  title: "Address labels",
  summary: "Buyers name saved addresses (Home, Work)",
  goals: [],
  depends_on: ["saved-addresses"],
  confidence: 0.65,
  requirements: [
    req("address-labels-name", "A saved address takes a short label", ["Labels are 20 characters at most"]),
    req("address-labels-show", "Labels show first in the address picker", ["Unlabelled addresses show the street"]),
  ],
};
const PICK: SpecFeature = {
  key: "pick-address",
  title: "Pick address in one step",
  summary: "Address and delivery choice on one screen",
  goals: [{ key: "g.activation", contribution: 2 }],
  depends_on: ["saved-addresses"],
  confidence: 0.35,
  requirements: [
    req("pick-address-one-screen", "Address and delivery option are chosen on one screen", ["No extra page load"]),
    req("pick-address-summary", "The chosen address shows in the order summary", ["It can be changed from the summary"]),
  ],
};
const EDIT: SpecFeature = {
  key: "address-edit",
  title: "Edit a saved address",
  summary: "Buyers correct a saved address without retyping it",
  goals: [{ key: "g.early-churn", contribution: 1 }],
  depends_on: ["saved-addresses"],
  confidence: 0.7,
  requirements: [req("address-edit-inline", "A saved address is edited in place at checkout", ["Changes apply to this order"])],
};
const NOTES: SpecFeature = {
  key: "delivery-notes",
  title: "Delivery notes",
  summary: "Buyers leave a note for the courier on a saved address",
  goals: [{ key: "g.early-churn", contribution: 1 }],
  depends_on: ["saved-addresses"],
  confidence: 0.7,
  requirements: [req("delivery-notes-text", "A saved address keeps a note for the courier", ["Notes are 140 characters at most"])],
};
const EXPORT_OUT = { key: "address-book-export", reason: "not_now" };
const SHARING_OUT = { key: "address-sharing", reason: "out_of_scope" };

/** Attempt 1: three rows need a person (a blocking dependency, no goal, low confidence). */
const SCOPE_REVIEW_SET: FeatureSetSpec = { features: [SAVED, LOOKUP, BULK, LABELS, PICK, EDIT], excluded: [EXPORT_OUT, SHARING_OUT] };
/** Attempt 2 after a send-back: Bulk edit is back in, Delivery notes is new, a requirement of Saved addresses went. */
const SCOPE_ATTEMPT2_SET: FeatureSetSpec = {
  features: [
    { ...SAVED, requirements: SAVED.requirements.slice(0, 2) },
    LOOKUP,
    { ...BULK, depends_on: ["saved-addresses"] },
    { ...LABELS, goals: [{ key: "g.early-churn", contribution: 1 }] },
    { ...PICK, confidence: 0.7 },
    NOTES,
  ],
  excluded: [EXPORT_OUT],
};
/** The held console approval: one blocking row (Bulk edit depends on the export left out). */
const SCOPE_CONSOLE_SET: FeatureSetSpec = { features: [SAVED, LOOKUP, BULK], excluded: [EXPORT_OUT] };

function seedScopeRun(db: RunsDb, ctx: Omit<RunsContext, "db">, id: string, slug: string, created_at: string, spec: FeatureSetSpec, attempt: number, flags: Record<string, string[]> = {}): { run: RunOut; scope: StoredScope; cp: CheckpointOut } {
  const { from, now } = seedClock();
  const own: RunsDb = { runs: [], artifacts: db.artifacts, scopes: (db.scopes ??= {}), drafts: (db.drafts ??= {}) };
  const full = { ...ctx, db: own, now };
  const r = seedRun(ctx, own, "baseline_to_prd", slug, {}, created_at);
  r.id = id;
  for (const c of r.checkpoints) c.run_id = id;
  from(r.created_at);
  launch(full, r);
  tick(full);
  const [baseline, featureSet] = r.segments;
  Object.assign(r.checkpoints[0], { status: "approved", decided_by: ctx.userId, decided_at: now() });
  next(full, r, baseline);
  tick(full);
  if (attempt > 1) {
    const first = featureSet.attempts[featureSet.attempts.length - 1];
    featureSet.attempts.push({ ...first, attempt, note: "Bring bulk edit back without the export; drop removing addresses for now" });
    featureSet.previous_attempt = { attempt: attempt - 1, artifacts: ["design.md", "feature_set.yaml"] };
  }
  featureSet.artifacts = ["design.md", "feature_set.yaml"];
  db.artifacts[`${r.id}|${featureSet.seq}|feature_set.yaml`] = featureSetYaml(spec, r.document_slug, featureSet.name, attempt);
  db.artifacts[`${r.id}|${featureSet.seq}|design.md`] = SAVED_ADDRESSES_DESIGN;
  if (attempt > 1) {
    db.artifacts[`${r.id}|${featureSet.seq}|feature_set.yaml|${attempt - 1}`] = featureSetYaml(SCOPE_REVIEW_SET, r.document_slug, featureSet.name, attempt - 1);
    db.artifacts[`${r.id}|${featureSet.seq}|design.md|${attempt - 1}`] = SAVED_ADDRESSES_DESIGN;
  }
  own.scopes![r.id] = [];
  proposeScope(full, r, featureSet.seq, attempt, spec, checkOf(spec));
  const scope = own.scopes![r.id][0] as StoredScope;
  // The goals by id, as the API stores a confirmed goal; the excluded rows' reasons as a person would pick.
  const goals = new Map((ctx.confirmedGoals?.() ?? []).map((g) => [g.key, g.id]));
  for (const f of scope.features) {
    f.goals = f.goals.map((g) => ({ ...g, goal_id: goals.get(g.key) ?? null }));
    const s = spec.features.find((x) => x.key === f.key);
    if (s) f.text = s.summary;
    // A row the set leaves out reads as a name ("Address book export"), as the agents titled it.
    if (f.title === f.key) f.title = f.key.charAt(0).toUpperCase() + f.key.slice(1).replace(/-/g, " ");
    f.flags = [...(flags[f.key] ?? [])];
  }
  prepareScope(scope);
  const cp = r.checkpoints.find((c) => c.kind === "feature_set")!;
  if (attempt > 1) cp.payload = { ...cp.payload, attempt };
  recheckScope(own, scope);
  refresh(r);
  db.runs.push(r);
  return { run: r, scope, cp };
}

/**
 * The "scope-review" scenario (C7): the default company plus three Baseline to PRD runs at
 * their feature set: saved-addresses (attempt 1: one blocking dependency, one feature with no
 * goal, one with low confidence that is also new, and a commenter's suggestion), saved-addresses-next (attempt
 * 2, for the Changed filter) and address-book (approved in SwarmCloud's console while one
 * blocking row is open, so the approval is held).
 */
export function seedScopeReviewRuns(db: RunsDb, ctx: Omit<RunsContext, "db">) {
  // Pick address in one step is new as well as low in confidence: one feature, two calls.
  const first = seedScopeRun(db, ctx, SCOPE_REVIEW_RUN, "saved-addresses", "2026-10-17T09:00:00Z", SCOPE_REVIEW_SET, 1, { "pick-address": ["new_feature"] });
  const commenter = (ctx.members ?? []).find((x) => x.email === "commenter@example.com");
  if (commenter) {
    db.drafts![first.cp.id] = {
      revision: 1,
      note: null,
      actions: [
        {
          id: ctx.uuid(),
          item_key: "address-edit",
          kind: "edit",
          field: "decision",
          value: { decision: "exclude", reason: "not_now" },
          answers: [],
          note: null,
          state: "suggested",
          created_by: commenter.id,
          updated_by: commenter.id,
          updated_at: "2026-10-17T09:30:00Z",
        },
      ],
      log: [{ revision: 1, by: displayName(commenter.email) }],
    };
  }
  const second = seedScopeRun(db, ctx, SCOPE_ATTEMPT2_RUN, "saved-addresses-next", "2026-10-17T08:00:00Z", SCOPE_ATTEMPT2_SET, 2);
  second.scope.previous = { "saved-addresses": "include", "address-lookup": "include", "bulk-edit": "exclude", "address-labels": "include", "pick-address": "include", "address-book-export": "exclude", "address-sharing": "exclude" };
  second.scope.previous_requirements = {
    "saved-addresses": ["saved-addresses-pick", "saved-addresses-save", "saved-addresses-remove"],
    "address-lookup": ["address-lookup-postcode", "address-lookup-manual"],
    "bulk-edit": ["bulk-edit-import", "bulk-edit-review"],
    "address-labels": ["address-labels-name", "address-labels-show"],
    "pick-address": ["pick-address-one-screen", "pick-address-summary"],
    "address-book-export": [],
    "address-sharing": [],
  };
  const held = seedScopeRun(db, ctx, SCOPE_CONSOLE_RUN, "address-book", "2026-10-17T07:00:00Z", SCOPE_CONSOLE_SET, 1);
  held.cp.console = {
    answered_by: "lead@example.com",
    answered_at: "2026-10-17T07:40:00Z",
    via: null,
    verdict: "MERGE",
    findings: [],
    counted: true,
    reason: CONSOLE_HELD,
    needs: "confirm",
    revise: false,
    can_redo: false,
  };
  held.run.token_read_only = true;
  refresh(held.run);
}

/** A Build the baseline run that succeeded at `created_at` (the Baseline rebuild scenarios' last build). */
export function seedFinishedBaselineBuild(ctx: Omit<RunsContext, "db">, db: RunsDb, created_at: string): RunOut {
  const run = seedRun(ctx, db, "baseline", "", {}, created_at);
  Object.assign(run, { document_id: null, document_slug: null, status: "succeeded", started_at: created_at, finished_at: created_at, spent_usd: run.estimate_usd ?? 0 });
  for (const s of run.segments) Object.assign(s, { status: "succeeded", cost_usd: s.estimate_usd ?? 0 });
  return run;
}
