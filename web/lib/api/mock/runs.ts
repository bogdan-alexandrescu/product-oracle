/**
 * Mock of the runs API (flows, runs, checkpoints, tick, inbox) for NEXT_PUBLIC_API_MOCKS=1.
 * Mirrors api/oracle/runs: the same flows, cost table, $50 approval gate and 1.5x
 * overrun pause. Agents "finish" a segment on POST /v1/internal/tick, at 90% of its
 * estimate, as the API's FakeRuntime does.
 */
import type { Schemas } from "@/lib/api/client";

type RunOut = Schemas["RunOut"];
type SegmentOut = Schemas["SegmentOut"];
type CheckpointOut = Schemas["CheckpointOut"];
type FeedbackRow = Schemas["FeedbackItemOut"];
type DocumentRow = Pick<Schemas["DocumentSummary"], "id" | "slug" | "title" | "kind" | "template" | "theme">;
type VersionSource = Schemas["VersionSource"];
type Kind = DocumentRow["kind"];

export interface RunsDb {
  runs: RunOut[];
  /** `${runId}|${seq}|${name}` -> content */
  artifacts: Record<string, string>;
}

export interface RunsContext {
  db: RunsDb;
  userId: string;
  feedback: FeedbackRow[];
  documents: DocumentRow[];
  latestVersion: (documentId: string) => number | null;
  /** The status of Oracle's live suggestion on a feedback item, if it has one. */
  suggestionStatus?: (feedbackId: string) => Schemas["SuggestionOut"]["status"] | null;
  /** Section keys of a version (a roadmap's items check their PRD sections). */
  sectionKeys: (versionId: string) => string[];
  /** The approved version of a document a run reads (the one named, else the latest approved), or why not. */
  sourceVersion: (documentId: string, number: number | null) => VersionSource | string;
  /** Imports a run's draft as the document's next version. */
  importDraft: (
    slug: string,
    run: Pick<RunOut, "document_kind" | "source" | "template" | "theme">,
  ) => Omit<NonNullable<SegmentOut["draft_import"]>, "warnings">;
  uuid: () => string;
  now: () => string;
}

const ROLES: Schemas["AgentRoleOut"][] = [
  { key: "researcher", title: "Researcher", description: "Gathers and weighs evidence", base_usd: 4 },
  { key: "analyst", title: "Analyst", description: "Turns evidence into structured claims", base_usd: 3 },
  { key: "architect", title: "Architect", description: "Dependencies and high-level design", base_usd: 5 },
  { key: "prioritizer", title: "Prioritizer", description: "Goal-weighted priority order", base_usd: 2.5 },
  { key: "writer", title: "Writer", description: "Writes the PRD draft", base_usd: 6 },
  { key: "critic", title: "Critic", description: "Checks traceability and citations", base_usd: 3 },
];
const READ = ["read:sources", "read:baseline"];

export const FLOW_CATALOG: Schemas["FlowCatalog"] = {
  flows: [
    {
      key: "baseline_to_prd",
      title: "Baseline to PRD",
      description: "Baseline proposal, feature set and design, priority order, PRD draft.",
      requires_document: false,
      target_kind: "prd",
      source_kind: null,
      segments: [
        { name: "baseline", title: "Baseline proposal", roles: ["researcher", "analyst"], scopes: [...READ, "write:proposals"], outputs: ["baseline.yaml", "summary.md"], checkpoint: "baseline_confirm", approver_role: "approver" },
        { name: "feature_set", title: "Feature set, dependencies and design", roles: ["analyst", "architect"], scopes: [...READ, "write:proposals"], outputs: ["feature_set.yaml", "design.md"], checkpoint: "feature_set", approver_role: "approver" },
        { name: "priority", title: "Priority order", roles: ["prioritizer"], scopes: ["read:baseline", "write:proposals"], outputs: ["priority.yaml"], checkpoint: "priority_order", approver_role: "approver" },
        { name: "prd_draft", title: "PRD draft", roles: ["writer", "critic"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["prd.md"], checkpoint: "prd_review", approver_role: "approver" },
      ],
    },
    {
      key: "feedback_loop",
      title: "Feedback loop",
      description: "Pull open feedback on a PRD or roadmap, write the next draft, review it.",
      requires_document: true,
      target_kind: null,
      source_kind: null,
      segments: [
        { name: "next_draft", title: "Next draft", roles: ["analyst", "writer"], scopes: [...READ, "read:documents", "write:drafts"], outputs: ["prd.md"], checkpoint: "prd_review", approver_role: "approver" },
      ],
    },
    {
      key: "prd_to_roadmap",
      title: "Roadmap from an approved PRD",
      description: "Roadmap items from an approved PRD version (horizon, milestone, dependencies, priority), then a roadmap draft in the chosen template.",
      requires_document: false,
      target_kind: "roadmap",
      source_kind: "prd",
      segments: [
        { name: "roadmap_items", title: "Roadmap items", roles: ["analyst", "prioritizer"], scopes: [...READ, "read:documents"], outputs: ["roadmap_items.yaml"], checkpoint: "roadmap_items", approver_role: "approver" },
        { name: "roadmap_draft", title: "Roadmap draft", roles: ["writer", "critic"], scopes: [...READ, "read:documents"], outputs: ["roadmap.md"], checkpoint: "roadmap_review", approver_role: "approver" },
      ],
    },
  ],
  roles: ROLES,
  depths: { quick: 0.5, standard: 1, deep: 2 },
  approval_threshold_usd: 50,
  overrun_factor: 1.5,
  runtime: "fake",
  runtime_notes: ["Local agent runtime: segments finish at once with generic drafts."],
};

const THRESHOLD = 50;
const KIND_NAME: Record<Kind, string> = { prd: "PRD", roadmap: "roadmap" };
// O4: a roadmap starts from Now / Next / Later on the roadmap board unless a run names others.
const ROADMAP_DEFAULTS = { template: "now-next-later", theme: "roadmap-board" };
const FACTOR = 1.5;
const FINAL = ["succeeded", "failed", "cancelled"];
const round2 = (n: number) => Math.round(n * 100) / 100;

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
    error: r.error,
    progress: progressOf(r),
  };
}

type KnobsIn = Partial<Schemas["KnobsIn"]>;

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
  for (const s of flow.segments) checkpoints[s.checkpoint] = raw?.checkpoints?.[s.checkpoint] ?? true;
  return { depth, roles, checkpoints, budget_usd: raw?.budget_usd ?? null };
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
    checkpoint_on: knobs.checkpoints[s.checkpoint] ?? true,
    estimate_usd: null,
    cost_usd: 0,
    workflow_id: null,
    artifacts: [],
    attempts: [],
    draft_import: null,
    items_check: null,
    started_at: null,
    finished_at: null,
    error: null,
  }));
}

/** Segments done of the total and what the run does now, as GET /v1/runs serves them. */
function progressOf(r: RunOut): Schemas["RunProgress"] {
  const now = r.segments.find((s) => s.status === "running") ?? r.segments.find((s) => s.status === "pending");
  return { done: r.segments.filter((s) => s.status === "succeeded").length, total: r.segments.length, now: now?.title ?? null };
}

function refresh(r: RunOut) {
  r.progress = progressOf(r);
  r.spent_usd = round2(r.segments.reduce((sum, s) => sum + s.cost_usd, 0));
  r.waiting_on = r.checkpoints.find((c) => c.status === "pending")?.kind ?? null;
  for (const c of r.checkpoints) c.can_decide = c.status === "pending";
}

function submit(ctx: RunsContext, r: RunOut, s: SegmentOut, note: string | null = null) {
  s.status = "running";
  s.workflow_id = `mock-wf-${ctx.uuid().slice(0, 8)}`;
  s.started_at ??= ctx.now();
  s.finished_at = null;
  s.attempts.push({ attempt: s.attempts.length + 1, workflow_id: s.workflow_id, submitted_at: ctx.now(), cost_usd: 0, note, state: "running" });
  r.status = "running";
}

function finish(ctx: RunsContext, r: RunOut, status: RunOut["status"]) {
  r.status = status;
  r.finished_at = ctx.now();
}

function next(ctx: RunsContext, r: RunOut, s: SegmentOut) {
  const later = r.segments.find((x) => x.seq === s.seq + 1);
  if (later) submit(ctx, r, later);
  else finish(ctx, r, "succeeded");
}

function fileContent(name: string, segment: string, attempt: number): string {
  if (name === "prd.md") return `---\ntitle: Example product PRD\n---\n\n# Example product PRD {#title}\n\nDraft ${attempt} from the local agent runtime.\n`;
  if (name === "roadmap.md") return `---\ntitle: Example product roadmap\nkind: roadmap\n---\n\n# Example product roadmap {#roadmap}\n\nDraft ${attempt} from the local agent runtime.\n`;
  if (name === "roadmap_items.yaml") {
    return `# ${segment} (local agent runtime, attempt ${attempt})\nversion: 1\nitems:\n  - id: price-early\n    title: Show the price early\n    outcome: Fewer buyers drop off at checkout\n    horizon: now\n    milestone: Beta\n    confidence: medium\n    prd_section: features\n`;
  }
  if (name.endsWith(".yaml")) return `# ${segment} (attempt ${attempt})\nitems:\n  - key: g1\n    title: Raise first-order completion to 70%\n    confidence: 0.82\n`;
  return `# ${segment}\n\nWritten by the local agent runtime (attempt ${attempt}).\n`;
}

function advance(ctx: RunsContext, r: RunOut, s: SegmentOut) {
  const def = flowOf(r.flow).segments.find((x) => x.name === s.name)!;
  const attempt = s.attempts.length;
  for (const name of def.outputs) ctx.db.artifacts[`${r.id}|${s.seq}|${name}`] = fileContent(name, s.name, attempt);
  s.artifacts = [...def.outputs].sort();
  // The local runtime's one item cites PRD section "features", as the API's FakeRuntime does.
  if (def.outputs.includes("roadmap_items.yaml")) {
    const known = r.source ? ctx.sectionKeys(r.source.version_id) : [];
    s.items_check = {
      items: 1,
      by_horizon: { now: 1, next: 0, later: 0 },
      problems: known.includes("features")
        ? []
        : [{ code: "unknown_prd_section", message: "item price-early: PRD section 'features' is not in the PRD version", item: "price-early" }],
    };
  }
  if ((def.outputs.includes("prd.md") || def.outputs.includes("roadmap.md")) && r.document_slug) {
    const imp = ctx.importDraft(r.document_slug, r);
    s.draft_import = { ...imp, created: true, warnings: [], error: null };
    r.document_id = imp.document_id ?? null;
  }
  const payload = { segment_seq: s.seq, segment: s.name, attempt, artifacts: s.artifacts };
  const on = r.knobs.checkpoints[def.checkpoint] ?? true;
  const cp: CheckpointOut = {
    id: ctx.uuid(),
    run_id: r.id,
    // As the API: the feedback loop on a roadmap is a roadmap review.
    kind: def.checkpoint === "prd_review" && r.document_kind === "roadmap" ? "roadmap_review" : def.checkpoint,
    status: on ? "pending" : "skipped",
    approver_role: "approver",
    segment_seq: s.seq,
    decided_by: null,
    decided_at: on ? null : ctx.now(),
    note: on ? null : "Turned off when the run started.",
    payload,
    created_at: ctx.now(),
    can_decide: on,
  };
  r.checkpoints.push(cp);
  if (on) r.status = "awaiting_checkpoint";
  else next(ctx, r, s);
}

function tick(ctx: RunsContext): Schemas["TickOut"] {
  const out = { runs_checked: 0, segments_finished: 0, runs_advanced: 0, runs_paused: 0, errors: [] as string[] };
  for (const r of ctx.db.runs) {
    if (r.status !== "running") continue;
    out.runs_checked += 1;
    const s = r.segments.find((x) => x.status === "running");
    if (!s) continue;
    const a = s.attempts[s.attempts.length - 1];
    a.cost_usd = round2((s.estimate_usd ?? 0) * 0.9);
    a.state = "succeeded";
    s.cost_usd = round2(s.attempts.reduce((sum, x) => sum + x.cost_usd, 0));
    s.status = "succeeded";
    s.finished_at = ctx.now();
    out.segments_finished += 1;
    refresh(r);
    if (r.overrun_ceiling_usd != null && r.spent_usd > r.overrun_ceiling_usd) {
      r.status = "paused_overrun";
      out.runs_paused += 1;
      continue;
    }
    advance(ctx, r, s);
    out.runs_advanced += 1;
    refresh(r);
  }
  return out;
}

function launch(ctx: RunsContext, r: RunOut) {
  r.started_at = ctx.now();
  r.overrun_ceiling_usd = round2((r.estimate_usd ?? 0) * FACTOR);
  submit(ctx, r, r.segments[0]);
}

function inbox(ctx: RunsContext): Schemas["InboxOut"] {
  const checkpoints = ctx.db.runs.flatMap((r) =>
    r.checkpoints
      .filter((c) => c.status === "pending")
      .map((c) => ({
        ...c,
        can_decide: true,
        flow: r.flow,
        flow_title: r.flow_title,
        document_slug: r.document_slug,
        segment_title: r.segments.find((s) => s.seq === c.segment_seq)?.title ?? null,
      })),
  );
  // The inbox embeds summaries without their progress, as the API does.
  const bare = (r: RunOut) => ({ ...summary(r), progress: null });
  const approvals = ctx.db.runs.filter((r) => r.status === "awaiting_approval").map(bare);
  const overruns = ctx.db.runs.filter((r) => r.status === "paused_overrun").map(bare);
  const byDoc = new Map<string, FeedbackRow[]>();
  for (const f of ctx.feedback.filter((x) => x.status === "open").sort((a, b) => b.created_at.localeCompare(a.created_at))) {
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
          suggestion_status: status(f),
        })),
      },
    ];
  });
  return {
    checkpoints,
    approvals,
    overruns,
    feedback,
    total: checkpoints.length + approvals.length + overruns.length + feedback.length,
  };
}

/** Handles /v1/flows, /v1/runs/*, /v1/inbox and /v1/internal/tick; null for anything else. */
export async function routeRuns(ctx: RunsContext, req: Request, p: string[]): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "flows" && m === "GET") return json(200, FLOW_CATALOG);
  if (p[1] === "inbox" && m === "GET") return json(200, inbox(ctx));
  if (p[1] === "internal" && p[2] === "tick" && m === "POST") return json(200, tick(ctx));
  if (p[1] !== "runs") return null;

  if (p.length === 2 && m === "GET") {
    const status = new URL(req.url).searchParams.get("status");
    return json(
      200,
      ctx.db.runs
        .filter((r) => !status || r.status === status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(summary),
    );
  }
  if (p.length === 2 && m === "POST") {
    const input = await body<Schemas["RunCreate"]>();
    const flow = flowOf(input.flow);
    const knobs = resolveKnobs(input.flow, input.knobs);
    if (typeof knobs === "string") return fail(422, knobs);
    const find = (ref: string) => ctx.documents.find((d) => d.slug === ref || d.id === ref);
    if (flow.target_kind !== "roadmap" && (input.template || input.theme)) return fail(422, `the ${flow.title} flow takes no template or theme`);
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
    if (!ref) return fail(422, "name the PRD: an existing document, or a new slug to create");
    const doc = find(ref);
    if (flow.requires_document && !doc) return fail(422, `document '${ref}' not found`);
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
      document_slug: doc?.slug ?? ref,
      document_kind: doc?.kind ?? flow.target_kind ?? null,
      source,
      template: roadmap ? (input.template ?? doc?.template ?? ROADMAP_DEFAULTS.template) : null,
      theme: roadmap ? (input.theme ?? doc?.theme ?? ROADMAP_DEFAULTS.theme) : null,
      estimate_usd: null,
      spent_usd: 0,
      created_by: ctx.userId,
      created_at: ctx.now(),
      started_at: null,
      finished_at: null,
      waiting_on: null,
      error: null,
      knobs,
      snapshot_id: null,
      snapshot_as_of: null,
      approved_by: null,
      approved_at: null,
      needs_approval: false,
      overrun_ceiling_usd: null,
      runtime: "fake",
      notes: FLOW_CATALOG.runtime_notes,
      segments: segmentsFor(input.flow, knobs, ctx.uuid),
      checkpoints: [],
    };
    ctx.db.runs.push(run);
    return json(201, run);
  }

  const r = ctx.db.runs.find((x) => x.id === p[2]);
  if (!r) return fail(404, `run ${p[2]} not found`);
  const done = (status = 200) => {
    refresh(r);
    return json(status, r);
  };

  if (p.length === 3 && m === "GET") return done();
  if (p.length === 3 && m === "PATCH") {
    if (r.status !== "draft") return fail(409, "only a draft run can be changed");
    const patch = await body<Schemas["RunPatch"]>();
    if (patch.knobs) {
      const knobs = resolveKnobs(r.flow, patch.knobs);
      if (typeof knobs === "string") return fail(422, knobs);
      r.knobs = knobs;
    }
    if (patch.document) {
      const doc = ctx.documents.find((d) => d.slug === patch.document || d.id === patch.document);
      r.document_id = doc?.id ?? null;
      r.document_slug = doc?.slug ?? patch.document;
    }
    if (r.document_kind === "roadmap") {
      if (patch.template) r.template = patch.template;
      if (patch.theme) r.theme = patch.theme;
    }
    r.segments = segmentsFor(r.flow, r.knobs, ctx.uuid);
    r.estimate_usd = null;
    r.needs_approval = false;
    return done();
  }

  const action = p[3];
  if (action === "estimate" && m === "POST") {
    if (r.status !== "draft") return fail(409, "only a draft run can be estimated");
    for (const s of r.segments) s.estimate_usd = segEstimate(s.roles, r.knobs.depth);
    const total = round2(r.segments.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0));
    r.estimate_usd = total;
    r.needs_approval = total > THRESHOLD;
    const budget = r.knobs.budget_usd ?? null;
    return json(200, {
      run_id: r.id,
      depth: r.knobs.depth,
      total_usd: total,
      segments: r.segments.map((s) => ({ seq: s.seq, name: s.name, title: s.title, roles: s.roles, estimate_usd: s.estimate_usd ?? 0 })),
      approval_threshold_usd: THRESHOLD,
      needs_approval: total > THRESHOLD,
      budget_usd: budget,
      within_budget: budget == null || total <= budget,
    } satisfies Schemas["EstimateOut"]);
  }
  if (action === "start" && m === "POST") {
    if (r.status !== "draft") return fail(409, `run is ${r.status}, not a draft`);
    if (r.estimate_usd == null) return fail(409, "estimate the run first");
    if (r.knobs.budget_usd != null && r.estimate_usd > r.knobs.budget_usd) return fail(422, "the estimate is over the budget");
    r.snapshot_id = ctx.uuid();
    r.snapshot_as_of = ctx.now();
    if (r.estimate_usd > THRESHOLD) r.status = "awaiting_approval";
    else launch(ctx, r);
    return done();
  }
  if (action === "approve" && m === "POST") {
    if (r.status !== "awaiting_approval") return fail(409, `run is ${r.status}, not awaiting approval`);
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
    return done();
  }
  if (action === "checkpoints" && p[5] === "decide" && m === "POST") {
    const cp = r.checkpoints.find((c) => c.id === p[4]);
    if (!cp) return fail(404, "checkpoint not found");
    if (cp.status !== "pending" || r.status !== "awaiting_checkpoint") return fail(409, `checkpoint is ${cp.status}`);
    const { decision, note } = await body<Schemas["CheckpointDecision"]>();
    const text = note?.trim() || null;
    if (decision === "changes_requested" && !text) return fail(422, "say what to change: a note is required to request changes");
    Object.assign(cp, { status: decision, note: text, decided_by: ctx.userId, decided_at: ctx.now() });
    const s = r.segments.find((x) => x.seq === cp.segment_seq)!;
    if (decision === "approved") next(ctx, r, s);
    else submit(ctx, r, s, text);
    return done();
  }
  if (action === "segments" && p[5] === "artifacts" && m === "GET") {
    const content = ctx.db.artifacts[`${r.id}|${p[4]}|${p[6]}`];
    if (content == null) return fail(404, `artifact '${p[6]}' not found`);
    return new Response(content, { headers: { "content-type": "text/plain" } });
  }
  return fail(404, "Route not found");
}

/** Seeded runs: one waiting at a checkpoint, one over the approval threshold, one paused on overrun, one done. */
export function seedRuns(ctx: Omit<RunsContext, "db">): RunsDb {
  const db: RunsDb = { runs: [], artifacts: {} };
  // Seeded runs take fixed times, as they take stable ids: each step a minute after the
  // last, from the run's own creation, so "Started" reads the same on every page load.
  let clock = 0;
  const from = (iso: string) => void (clock = Date.parse(iso));
  const now = () => new Date((clock += 60_000)).toISOString();
  const full = { ...ctx, db, now };
  const make = (flow: RunOut["flow"], document: string, knobs: KnobsIn, created_at: string): RunOut => {
    const doc = ctx.documents.find((d) => d.slug === document);
    const k = resolveKnobs(flow, knobs) as RunOut["knobs"];
    const segments = segmentsFor(flow, k, ctx.uuid);
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
      knobs: k,
      snapshot_id: ctx.uuid(),
      snapshot_as_of: created_at,
      approved_by: null,
      approved_at: null,
      needs_approval: estimate > THRESHOLD,
      overrun_ceiling_usd: null,
      runtime: "fake",
      notes: FLOW_CATALOG.runtime_notes,
      segments,
      checkpoints: [],
    };
    db.runs.push(run);
    return run;
  };

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
    draft_import: { document_id: done.document_id, slug: "checkout-redesign", version: 2, created: true, warnings: [], error: null },
  });
  db.artifacts[`${done.id}|1|prd.md`] = fileContent("prd.md", "next_draft", 1);
  done.checkpoints.push({
    id: ctx.uuid(), run_id: done.id, kind: "prd_review", status: "skipped", approver_role: "approver", segment_seq: 1,
    decided_by: null, decided_at: "2026-10-16T09:20:00Z", note: "Turned off when the run started.", payload: {}, created_at: "2026-10-16T09:20:00Z", can_decide: false,
  });
  Object.assign(done, { status: "succeeded", started_at: "2026-10-16T09:00:00Z", finished_at: "2026-10-16T09:20:00Z", overrun_ceiling_usd: 13.5 });

  for (const r of db.runs) refresh(r);
  return db;
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
