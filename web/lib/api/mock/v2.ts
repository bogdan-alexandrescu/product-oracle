/**
 * Mock of the Product Oracle v2 read routes (api/oracle/v2/router.py) for
 * NEXT_PUBLIC_API_MOCKS=1: a list and a get per entity, newest first, with the same
 * filters (any query parameter other than limit/offset matches a field of the row).
 * One linked row per entity, synthetic placeholders only. Lanes add their writes here.
 */
import type { Schemas } from "@/lib/api/client";

export interface V2Db {
  modules: Schemas["ModuleDefinitionOut"][];
  module_versions: Schemas["ModuleVersionOut"][];
  template_module_assignments: Schemas["TemplateModuleAssignmentOut"][];
  compositions: Schemas["DocumentCompositionOut"][];
  composition_revisions: Schemas["CompositionRevisionOut"][];
  intakes: Schemas["ProductIntakeOut"][];
  gaps: Schemas["KnowledgeGapOut"][];
  questions: Schemas["StakeholderQuestionOut"][];
  answers: Schemas["StakeholderAnswerOut"][];
  assumption_decisions: Schemas["AssumptionDecisionOut"][];
  blocker_options: Schemas["BlockerOptionOut"][];
  feasibility_experiments: Schemas["FeasibilityExperimentOut"][];
  blocker_events: Schemas["BlockerResolutionEventOut"][];
  change_events: Schemas["ChangeEventOut"][];
  section_links: Schemas["DocumentSectionLinkOut"][];
  artifact_dependencies: Schemas["ArtifactDependencyOut"][];
  evaluation_reports: Schemas["EvaluationReportOut"][];
  evaluation_findings: Schemas["EvaluationFindingOut"][];
  artifact_requests: Schemas["ArtifactRequestOut"][];
  artifact_versions: Schemas["ArtifactVersionOut"][];
  artifact_outputs: Schemas["ArtifactOutputOut"][];
  artifact_review_events: Schemas["ArtifactReviewEventOut"][];
}

/** URL segment after /v1 -> the table it lists. */
const PATHS: Record<string, keyof V2Db> = {
  modules: "modules",
  "module-versions": "module_versions",
  "template-module-assignments": "template_module_assignments",
  compositions: "compositions",
  "composition-revisions": "composition_revisions",
  intakes: "intakes",
  gaps: "gaps",
  questions: "questions",
  answers: "answers",
  "assumption-decisions": "assumption_decisions",
  "blocker-options": "blocker_options",
  "feasibility-experiments": "feasibility_experiments",
  "blocker-events": "blocker_events",
  "change-events": "change_events",
  "section-links": "section_links",
  "artifact-dependencies": "artifact_dependencies",
  "evaluation-reports": "evaluation_reports",
  "evaluation-findings": "evaluation_findings",
  "artifact-requests": "artifact_requests",
  "artifact-versions": "artifact_versions",
  "artifact-outputs": "artifact_outputs",
  "artifact-review-events": "artifact_review_events",
};

/** Fixed ids, so fixtures link to each other and tests can address them. */
export const V2_IDS = {
  module: "a2000000-0000-4000-8000-000000000001",
  moduleVersion: "a2000000-0000-4000-8000-000000000002",
  assignment: "a2000000-0000-4000-8000-000000000003",
  composition: "a2000000-0000-4000-8000-000000000004",
  revision: "a2000000-0000-4000-8000-000000000005",
  intake: "a2000000-0000-4000-8000-000000000006",
  gap: "a2000000-0000-4000-8000-000000000007",
  question: "a2000000-0000-4000-8000-000000000008",
  answer: "a2000000-0000-4000-8000-000000000009",
  assumption: "a2000000-0000-4000-8000-00000000000a",
  option: "a2000000-0000-4000-8000-00000000000b",
  experiment: "a2000000-0000-4000-8000-00000000000c",
  blockerEvent: "a2000000-0000-4000-8000-00000000000d",
  change: "a2000000-0000-4000-8000-00000000000e",
  link: "a2000000-0000-4000-8000-00000000000f",
  dependency: "a2000000-0000-4000-8000-000000000010",
  report: "a2000000-0000-4000-8000-000000000011",
  finding: "a2000000-0000-4000-8000-000000000012",
  request: "a2000000-0000-4000-8000-000000000013",
  artifactVersion: "a2000000-0000-4000-8000-000000000014",
  output: "a2000000-0000-4000-8000-000000000015",
  review: "a2000000-0000-4000-8000-000000000016",
  // Stand-ins for a baseline constraint (the blocker), a requirement and a template.
  blocker: "a2000000-0000-4000-8000-000000000101",
  requirement: "a2000000-0000-4000-8000-000000000102",
  template: "a2000000-0000-4000-8000-000000000103",
} as const;

const AT = "2026-10-19T09:00:00Z";

/** ``documentId`` / ``versionId``: the mock PRD the rows hang off. */
export function seedV2(documentId: string, versionId: string | null, userId: string): V2Db {
  const I = V2_IDS;
  return {
    modules: [
      { id: I.module, key: "constraints.solutions", title: "Constraints, Blockers & Solution Strategy", description: null, builtin: true, archived_at: null, created_by: null, created_at: AT },
    ],
    module_versions: [
      {
        id: I.moduleVersion,
        module_id: I.module,
        version: "1.0.0",
        contract: { id: "constraints.solutions", version: "1.0.0", title: "Constraints, Blockers & Solution Strategy", policy: "required", outputs: ["prd"] },
        contract_hash: "0".repeat(64),
        origin: "builtin",
        created_by: null,
        created_at: AT,
      },
    ],
    template_module_assignments: [
      { id: I.assignment, template_id: I.template, module_key: "constraints.solutions", module_version: null, policy: "required", display_order: 60, section_ids: ["risks"], since_template_version: null, manifest_format: 1, created_by: null, created_at: AT },
    ],
    compositions: [
      { id: I.composition, document_id: documentId, template: "oracle-default", template_version: "1", current_revision: 1, lock_version: 1, created_at: AT, updated_at: AT },
    ],
    composition_revisions: [
      {
        id: I.revision,
        composition_id: I.composition,
        number: 1,
        status: "working",
        modules: [{ key: "constraints.solutions", version: "1.0.0", policy: "required", included: true, reason: "Required by company policy", order: 60, section_ids: ["risks"], driven_by: [], score: null, overridden_by: null }],
        inputs: {
          template: { key: "oracle-default", version: "1" },
          brief: {},
          category: "platform",
          scope: {},
          signals: {},
          baseline: {},
          sources: {},
          stakeholders: {},
          outputs: ["prd"],
          blockers: {},
          policy: {},
          intake_id: I.intake,
          baseline_snapshot_id: null,
          source_snapshot_ids: [],
        },
        decided_by: userId,
        decided_at: AT,
        reason: "First composition",
        parent_number: null,
        document_version_id: null,
        lock_version: 1,
        created_at: AT,
      },
    ],
    intakes: [
      {
        id: I.intake,
        title: "Saved addresses",
        brief: "Returning buyers retype their address at every checkout. Make repeat checkout faster.",
        author_id: userId,
        source_snapshot_ids: [],
        status: "awaiting_answers",
        analysis: {
          users: [{ name: "Returning buyer", knowledge_state: "user_decision" }],
          problem: { statement: "Repeat buyers retype addresses", knowledge_state: "hypothesis" },
          outcomes: [],
          goal_ids: [],
          scope: ["Saved addresses at checkout"],
          non_goals: [],
          dependencies: [],
          blockers: [],
          category: "platform",
          conflicts: [],
        },
        document_id: documentId,
        lock_version: 1,
        created_at: AT,
        updated_at: AT,
      },
    ],
    gaps: [
      {
        id: I.gap,
        intake_id: I.intake,
        document_id: documentId,
        category: "success_metric",
        statement: "No baseline for repeat checkout time",
        impact: ["goals", "scope"],
        importance: "critical",
        evidence_ids: [],
        confidence: null,
        knowledge_state: "unknown",
        status: "asked",
        owner_id: userId,
        related_modules: ["constraints.solutions"],
        stop_condition: "A named metric with a baseline value",
        entity_ids: [I.requirement],
        section_keys: ["metrics"],
        created_by: null,
        lock_version: 1,
        created_at: AT,
        updated_at: AT,
      },
    ],
    questions: [
      { id: I.question, gap_id: I.gap, intake_id: I.intake, document_id: documentId, category: "success_metric", prompt: "Which metric shows repeat checkout got faster?", rationale: "Decides scope and the success criteria", priority: 10, batch: 1, asked_to: userId, asked_by: null, module_key: null, section_key: "metrics", status: "asked", created_at: AT, updated_at: AT },
    ],
    answers: [
      { id: I.answer, question_id: I.question, kind: "dont_know", body: null, answered_by: userId, delegated_to: null, evidence_ids: [], knowledge_state: "unknown", created_at: AT },
    ],
    assumption_decisions: [
      { id: I.assumption, gap_id: I.gap, document_id: documentId, entity_id: null, statement: "Median repeat checkout time is the metric", decision: "accept_assumption", rationale: "Best available signal until analytics are connected", decided_by: userId, decided_at: AT, review_at: null, created_at: AT },
    ],
    blocker_options: [
      {
        id: I.option,
        blocker_id: I.blocker,
        title: "Batch address lookups within the published quota",
        approach: "architecture",
        description: null,
        technical_feasibility: "high",
        policy_feasibility: "high",
        compliance: "compliant",
        status: "evaluating",
        details: { fallback: "Queue lookups and retry within limits" },
        evidence_ids: [],
        owner_id: userId,
        selected_reason: null,
        created_by: null,
        lock_version: 1,
        created_at: AT,
        updated_at: AT,
      },
    ],
    feasibility_experiments: [
      { id: I.experiment, blocker_id: I.blocker, option_id: I.option, hypothesis: "Batching halves lookup calls", method: "Replay a synthetic day of traffic", success_threshold: "Under 50% of today's calls", owner_id: userId, decision_gate_at: null, status: "planned", result: null, evidence_ids: [], lock_version: 1, created_at: AT, updated_at: AT },
    ],
    blocker_events: [
      { id: I.blockerEvent, blocker_id: I.blocker, option_id: I.option, experiment_id: I.experiment, kind: "experiment_started", from_status: "open", to_status: "mitigating", reason: null, actor: `user:${userId}`, data: {}, summary: "Experiment started", created_at: AT },
    ],
    change_events: [
      { id: I.change, subject_kind: "document_section", subject_id: null, subject_ref: "checkout-redesign@2#metrics", document_id: documentId, cause: "section_edited", actor: `user:${userId}`, data: {}, handled_by: [], created_at: AT },
    ],
    section_links: [
      { id: I.link, document_id: documentId, version_id: versionId, section_key: "metrics", section_hash: null, composition_revision: 1, module_key: null, kind: "implements", entity_id: I.requirement, evidence_id: null, source_item_id: null, precision: "section", claim: null, created_by: null, created_at: AT },
    ],
    artifact_dependencies: [
      { id: I.dependency, artifact_version_id: I.artifactVersion, document_version_id: null, upstream_version_id: versionId, upstream_section_key: "metrics", upstream_section_hash: null, upstream_entity_id: null, composition_revision: 1, freshness: "potentially_stale", caused_by_change_id: I.change, stale_since: AT, reconciled_by: null, reconciled_at: null, note: null, created_at: AT, updated_at: AT },
    ],
    evaluation_reports: [
      { id: I.report, document_id: documentId, version_id: versionId, composition_revision: 1, evaluator: "rules", policy: "advisory", status: "complete", summary: { warning: 1 }, created_by: null, created_at: AT },
    ],
    evaluation_findings: [
      { id: I.finding, report_id: I.report, criterion: "success_metrics", status: "warning", hard: false, rationale: "The metric has no baseline value yet", evidence_ids: [], owner_id: userId, section_keys: ["metrics"], module_key: null, created_at: AT },
    ],
    artifact_requests: [
      { id: I.request, kind: "tech_brief", title: "Saved addresses tech brief", source_document_id: documentId, source_version_id: versionId, requirement_ids: [I.requirement], section_keys: ["metrics"], params: {}, status: "succeeded", run_id: null, requested_by: userId, lock_version: 1, created_at: AT, updated_at: AT },
    ],
    artifact_versions: [
      { id: I.artifactVersion, request_id: I.request, number: 1, status: "in_review", freshness: "potentially_stale", source_version_id: versionId, composition_revision: 1, content_hash: null, summary: "Tech brief for saved addresses", provenance: {}, created_by: null, approved_by: null, approved_at: null, created_at: AT },
    ],
    artifact_outputs: [
      { id: I.output, version_id: I.artifactVersion, name: "tech-brief.md", media_type: "text/markdown", size_bytes: 128, sha256: "0".repeat(64), meta: {}, created_at: AT },
    ],
    artifact_review_events: [
      { id: I.review, version_id: I.artifactVersion, kind: "marked_stale", body: "The metrics section changed", actor: "system", data: {}, created_at: AT },
    ],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** GET /v1/<v2 path>[/<id>]; null when the path is not a v2 route. */
export function routeV2(db: V2Db, req: Request, p: string[], q: URLSearchParams): Response | null {
  const table = PATHS[p[1]];
  if (!table || req.method !== "GET" || p.length > 3) return null;
  const rows = db[table] as unknown as Record<string, unknown>[];
  if (p[2]) {
    const row = rows.find((r) => r.id === p[2]);
    if (!row) return json(404, { detail: "Not found" });
    if (table === "evaluation_reports") {
      return json(200, { ...row, findings: db.evaluation_findings.filter((f) => f.report_id === row.id) });
    }
    return json(200, row);
  }
  const limit = Number(q.get("limit") ?? 100);
  const offset = Number(q.get("offset") ?? 0);
  if (!(limit >= 1 && limit <= 500) || !(offset >= 0)) return json(422, { detail: "limit or offset" });
  const filters = [...q.entries()].filter(([k]) => k !== "limit" && k !== "offset");
  const hits = rows
    .filter((r) => filters.every(([k, v]) => String(r[k]) === v))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return json(200, hits.slice(offset, offset + limit));
}
