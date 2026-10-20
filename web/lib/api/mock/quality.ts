/**
 * Mock of PRD quality and readiness, outcome tracking and learnings
 * (api/oracle/quality/router.py) for NEXT_PUBLIC_API_MOCKS=1. The readiness dashboard is a
 * fixed, synthetic evaluation (the mock does not run the rules); stored reports go into the
 * v2 evaluation tables so the foundation's read routes list them. Same role checks as the
 * API: viewers read, commenters store evaluations and ratings, approvers queue a model
 * review and track outcomes and learnings. Synthetic placeholders only.
 */
import type { Schemas } from "@/lib/api/client";
import { DEPOSITS_IDS } from "./blockers";
import type { V2Db } from "./v2";

type Role = Schemas["Me"]["role"];
type Status = Schemas["ReadinessItem"]["status"];
type Outcome = Schemas["OutcomeOut"];
type Learning = Schemas["LearningOut"];

export interface QualityDb {
  outcomes: Outcome[];
  learnings: Learning[];
}

export interface QualityContext {
  db: QualityDb;
  v2: V2Db;
  userId: string;
  role: Role;
  /** Resolves a document (slug or id) and version number to their ids, or null. */
  findVersion: (doc: string, n: number) => { documentId: string; slug: string; versionId: string } | null;
  /** The blockers lane's ``critical_blockers`` hard check for a document (./blockers.ts). */
  blockerGate: (documentId: string) => { status: Status; rationale: string; evidence_ids: string[] };
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const AT = "2026-10-19T10:00:00Z";
const DISCLAIMER =
  "Model output from Oracle's built-in quality review job: an opinion to compare with the rules and human ratings, not independent ground truth. It never blocks a publish.";
const POLICY_NOTE =
  "T2 (owner decision, 2026-10-19): the evaluation is advisory. A criterion's critical is shown, never a stop. A publish is refused only by a hard check that is critical. There is no numeric publish score.";

export const CRITERIA: Schemas["CriterionInfo"][] = [
  ["problem_clarity", "Problem and user clarity", "Does the PRD say who has the problem, what it is, and what evidence shows the pain?"],
  ["goal_alignment", "Business goal alignment and strategic value", "Does every feature serve a confirmed company goal, and how does it rank?"],
  ["evidence_provenance", "Source evidence and provenance", "Is the PRD backed by fresh, confident evidence without open conflicts?"],
  ["alternatives_tradeoffs", "Alternatives explored and trade-offs", "Were at least two approaches compared, with the trade-off stated?"],
  ["blocker_feasibility", "Blocker and feasibility resolution", "Does every blocker have a workable, compliant mitigation or an experiment?"],
  ["scope_testability", "Scope, non-goals and testable requirements", "Are scope and non-goals explicit, and can each acceptance criterion be tested?"],
  ["economics_scaling", "Economic and scaling assumptions", "Are costs, benefits and scaling assumptions stated and quantified?"],
  ["validation_plan", "Validation plan, success metrics and decision thresholds", "Are there measurable metrics, a decision threshold and a plan to validate?"],
  ["ownership_readiness", "Ownership, review and operational readiness", "Is there an owner, a rollout and operations plan, and review under way?"],
  ["downstream_consistency", "Downstream design and engineering consistency", "Are specs, designs and roadmaps built from this PRD still consistent with it?"],
  ["security_policy", "Critical security and policy requirements", "Has any critical security, privacy or policy requirement failed?"],
  ["third_party_support", "Supported third-party operations", "Does the PRD rely on a third-party operation the provider does not support or permit?"],
].map(([key, title, question], i) => ({ key, title, question, hard: i >= 10, reads: [] }));

type Rule = [Status, string, string[], string[]?];

/** The fixed synthetic evaluation every version shows in mock mode (but the ones below). */
const RULES: Record<string, Rule> = {
  problem_clarity: ["pass", "The problem names its users and its pain is backed by 2 evidence.", ["problem"]],
  goal_alignment: ["pass", "Every linked feature (1) serves a confirmed goal (activation).", ["goal-trace"]],
  evidence_provenance: ["warning", "1 piece(s) of evidence are stale.", []],
  alternatives_tradeoffs: ["warning", "No alternatives considered: no section and no blocker with two options.", []],
  blocker_feasibility: ["pass", "No blocker is recorded; the risks section states the constraints.", ["risks"]],
  scope_testability: ["critical", "No acceptance criteria: nothing says how to test the requirements.", ["solution"]],
  economics_scaling: ["not_applicable", "No economic or scaling module, section or open question applies to this PRD.", []],
  validation_plan: ["warning", "No decision threshold: what result would change the plan?", ["metrics"]],
  ownership_readiness: ["pass", "Owned (an owner line), with review under way. Approvals are gated by the review and publish checks, not here.", []],
  downstream_consistency: ["not_applicable", "No downstream design, engineering or roadmap artifact yet.", []],
  security_policy: ["not_applicable", "No security, privacy or policy requirement is linked to this PRD.", []],
  third_party_support: ["not_applicable", "The PRD relies on no third-party operation.", []],
};
const PASS = (rationale: string): Rule => ["pass", rationale, []];

/** Per PRD (slug): the Quillfield deposits PRD as B1's Publish frame shows it, and a ready one. */
const RULES_BY_SLUG: Record<string, Record<string, Rule>> = {
  "online-deposits": {
    problem_clarity: PASS("The problem names its users and its pain is backed by the no-show count."),
    goal_alignment: ["warning", "The goals section cites G4, still proposed.", ["problem"]],
    evidence_provenance: PASS("Evidence is fresh and confident."),
    alternatives_tradeoffs: PASS("Two refund approaches are compared."),
    blocker_feasibility: ["critical", "The same-day refund blocker has no workable mitigation or experiment.", ["risks"]],
    scope_testability: ["warning", "Two acceptance criteria cannot be tested as written.", ["solution"]],
    economics_scaling: PASS("Deposit amounts are configuration per clinic."),
    validation_plan: PASS("No-show rate with a decision threshold."),
    ownership_readiness: PASS("Owned, with review under way."),
    downstream_consistency: PASS("No downstream artifact is stale."),
    security_policy: PASS("No critical security or policy requirement failed."),
    third_party_support: [
      "critical",
      "Taking a deposit through the booking calendar's API is an operation the provider does not offer.",
      ["solution"],
      [DEPOSITS_IDS.requirement],
    ],
  },
  "visit-reminders": Object.fromEntries(
    Object.keys(RULES).map((k) => [k, PASS(k === "security_policy" || k === "third_party_support" ? "Nothing failed." : "Meets the criterion.")]),
  ),
};
const BLOCKERS_KEY = "critical_blockers";
const STATUSES: Status[] = ["pass", "warning", "critical", "not_applicable"];

export function seedQuality(): QualityDb {
  return { outcomes: [], learnings: [] };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

function uuid(): string {
  return crypto.randomUUID();
}

function counts(statuses: Status[]): Record<string, number> {
  return Object.fromEntries(STATUSES.map((s) => [s, statuses.filter((x) => x === s).length]));
}

function reports(ctx: QualityContext, versionId: string, evaluator: string) {
  return ctx.v2.evaluation_reports
    .filter((r) => r.version_id === versionId && r.evaluator === evaluator)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function dashboard(ctx: QualityContext, v: { documentId: string; slug: string; versionId: string }, n: number): Schemas["ReadinessDashboard"] {
  const model = reports(ctx, v.versionId, "llm_job")[0];
  const humans = reports(ctx, v.versionId, "human");
  const rules = RULES_BY_SLUG[v.slug] ?? RULES;
  const gate = ctx.blockerGate(v.documentId);
  // The blockers lane registers its hard check after the quality criteria.
  const checks = [...CRITERIA, { key: BLOCKERS_KEY, title: "Critical blockers", question: "A readiness check registered by Oracle.", hard: true }];
  const items: Schemas["ReadinessItem"][] = checks.map((c) => {
    const [status, rationale, section_keys, evidence_ids = []] =
      c.key === BLOCKERS_KEY ? [gate.status, gate.rationale, [], gate.evidence_ids] : rules[c.key];
    const mf = model && ctx.v2.evaluation_findings.find((f) => f.report_id === model.id && f.criterion === c.key);
    const human = humans.flatMap((r) =>
      ctx.v2.evaluation_findings
        .filter((f) => f.report_id === r.id && f.criterion === c.key)
        .map((f) => ({ status: f.status, rationale: f.rationale, rater_id: r.created_by, report_id: r.id, created_at: r.created_at })),
    );
    return {
      key: c.key, title: c.title, question: c.question, hard: c.hard, status, rationale,
      evidence_ids, owner_id: ctx.userId, section_keys, error: null,
      model: mf ? { status: mf.status, rationale: mf.rationale, section_keys: mf.section_keys, report_id: model.id } : null,
      human,
      agreement: {
        model: mf ? mf.status === status : null,
        human: human.length ? human.filter((h) => h.status === status).length / human.length : null,
      },
    };
  });
  const blocking = items.filter((i) => i.hard && i.status === "critical").map((i) => i.key);
  const latest = reports(ctx, v.versionId, "rules")[0];
  return {
    document_id: v.documentId, slug: v.slug, version: n, version_id: v.versionId,
    composition_revision: null, policy: "advisory", policy_note: POLICY_NOTE,
    evaluated_at: new Date().toISOString(), blocked: blocking.length > 0, blocking,
    counts: counts(items.map((i) => i.status)), items,
    model_review: model ? { report_id: model.id, job_id: null, model: "mock", created_at: model.created_at, label: "model_output", disclaimer: DISCLAIMER } : null,
    latest_report: latest ? { id: latest.id, created_at: latest.created_at } : null,
  };
}

function storeReport(
  ctx: QualityContext,
  v: { documentId: string; versionId: string },
  evaluator: "rules" | "human" | "llm_job",
  findings: { criterion: string; status: Status; rationale: string; hard: boolean; section_keys: string[] }[],
  summary: Record<string, unknown>,
): Schemas["EvaluationReportDetail"] {
  const report: Schemas["EvaluationReportOut"] = {
    id: uuid(), document_id: v.documentId, version_id: v.versionId, composition_revision: null,
    evaluator, policy: "advisory", status: "complete",
    summary: { counts: counts(findings.map((f) => f.status)), ...summary },
    created_by: ctx.userId, created_at: new Date().toISOString(),
  };
  const rows = findings.map((f) => ({
    id: uuid(), report_id: report.id, ...f, evidence_ids: [], owner_id: ctx.userId, module_key: null, created_at: report.created_at,
  }));
  ctx.v2.evaluation_reports.push(report);
  ctx.v2.evaluation_findings.push(...rows);
  return { ...report, findings: rows };
}

function signals(db: QualityDb, appliesTo: string | null): Schemas["LearningSignal"][] {
  const sign = { recommend_more: 1, recommend_less: -1, note: 0 } as const;
  const groups = new Map<string, Learning[]>();
  for (const l of db.learnings) {
    if (l.status !== "active" || (appliesTo && l.applies_to !== appliesTo)) continue;
    const key = `${l.applies_to}\u0000${l.target}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups.values()]
    .map((ls) => ({
      applies_to: ls[0].applies_to, target: ls[0].target,
      score: ls.reduce((s, l) => s + sign[l.direction] * l.weight, 0),
      learning_ids: ls.map((l) => l.id), statements: ls.slice(0, 3).map((l) => l.statement),
    }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.target.localeCompare(b.target));
}

/** The quality routes; null when the path is not one of them. */
export async function routeQuality(ctx: QualityContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const need = (role: Role) => (atLeast(ctx.role, role) ? null : fail(403, `Requires the ${role} role`));

  if (p[1] === "quality" && p[2] === "criteria" && m === "GET") return json(200, CRITERIA);

  if (p[1] === "documents" && p[3] === "versions" && p[4] && ["readiness", "evaluations", "quality-review"].includes(p[5])) {
    const n = Number(p[4]);
    const v = ctx.findVersion(p[2], n);
    if (p[5] === "readiness" && m === "GET") return v ? json(200, dashboard(ctx, v, n)) : fail(404, "Version not found");
    if (p[5] === "evaluations" && m === "POST" && !p[6]) {
      const denied = need("commenter");
      if (denied) return denied;
      if (!v) return fail(404, "Version not found");
      const findings = CRITERIA.map((c) => ({ criterion: c.key, status: RULES[c.key][0], rationale: RULES[c.key][1], hard: c.hard, section_keys: RULES[c.key][2] }));
      return json(201, storeReport(ctx, v, "rules", findings, { blocked: false, blocking: [], errors: [] }));
    }
    if (p[5] === "evaluations" && p[6] === "human" && m === "POST") {
      const denied = need("commenter");
      if (denied) return denied;
      if (!v) return fail(404, "Version not found");
      const data = await body<Schemas["HumanRatingIn"]>();
      const known = new Set(CRITERIA.slice(0, 10).map((c) => c.key));
      if (!data?.ratings?.length || data.ratings.some((r) => !known.has(r.criterion))) return fail(422, "unknown criteria");
      const findings = data.ratings.map((r) => ({ criterion: r.criterion, status: r.status, rationale: r.rationale, hard: false, section_keys: r.section_keys ?? [] }));
      return json(201, storeReport(ctx, v, "human", findings, { note: data.note ?? null }));
    }
    if (p[5] === "quality-review" && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      if (!v) return fail(404, "Version not found");
      // The mock's model answers at once: two criteria, labelled model output.
      storeReport(ctx, v, "llm_job", [
        { criterion: "validation_plan", status: "warning", rationale: "The pilot has no stated sample size.", hard: false, section_keys: ["metrics"] },
        { criterion: "problem_clarity", status: "pass", rationale: "The problem names the users and quantifies the drop-off.", hard: false, section_keys: ["problem"] },
      ], { label: "model_output", disclaimer: DISCLAIMER });
      const job: Schemas["LlmJobOut"] = {
        id: uuid(), kind: "quality_review", document_id: v.documentId, version_number: n, section_key: null,
        status: "succeeded", input: { version: n, prompt: "quality_review.v1" }, output: null, account_label: null,
        via: null, model: null, input_tokens: null, output_tokens: null, cost_usd: null, attempts: 1, error: null,
        error_reason: null, next_reset_at: null, requested_by: ctx.userId, created_at: AT, started_at: AT, finished_at: AT,
      };
      return json(201, job);
    }
    return null;
  }

  if (p[1] === "outcomes") {
    if (m === "GET" && !p[2]) {
      const hits = ctx.db.outcomes.filter((o) =>
        ["goal_id", "document_id", "status"].every((k) => !q.get(k) || String(o[k as keyof Outcome]) === q.get(k)),
      );
      return json(200, [...hits].reverse());
    }
    if (m === "GET" && p[2]) {
      const o = ctx.db.outcomes.find((x) => x.id === p[2]);
      return o ? json(200, o) : fail(404, "Outcome not found");
    }
    const denied = need("approver");
    if (denied) return denied;
    if (m === "POST" && !p[2]) {
      const data = await body<Schemas["OutcomeCreate"]>();
      if (!data?.goal_id || !data.prediction) return fail(422, "goal_id and prediction are required");
      const now = new Date().toISOString();
      const o: Outcome = {
        id: uuid(), title: data.title, goal_id: data.goal_id, outcome_entity_id: data.outcome_entity_id ?? null,
        document_id: null, prd_version_id: data.prd_version_id ?? null, roadmap_version_id: data.roadmap_version_id ?? null,
        roadmap_item_key: data.roadmap_item_key ?? null, experiment_id: data.experiment_id ?? null,
        prediction: { baseline: null, threshold: null, by: null, ...data.prediction },
        module_keys: data.module_keys ?? [], gap_categories: data.gap_categories ?? [], status: "tracking", observed: null,
        assessments: [], owner_id: data.owner_id ?? ctx.userId, created_by: ctx.userId, assessed_at: null, lock_version: 1,
        created_at: now, updated_at: now,
      };
      ctx.db.outcomes.push(o);
      return json(201, o);
    }
    if (m === "POST" && p[2] && p[3] === "assessments") {
      const o = ctx.db.outcomes.find((x) => x.id === p[2]);
      if (!o) return fail(404, "Outcome not found");
      const a = await body<Schemas["AssessmentIn"]>();
      const now = new Date().toISOString();
      o.assessments.push({ verdict: a.verdict, observed: a.observed, note: a.note ?? null, evidence_ids: a.evidence_ids ?? [], assessed_by: ctx.userId, assessed_at: now });
      Object.assign(o, { status: a.verdict, observed: a.observed, assessed_at: now, updated_at: now, lock_version: o.lock_version + 1 });
      const direction: Schemas["LearningDraft"]["direction"] = a.verdict === "held" ? "note" : "recommend_more";
      const suggested_learnings: Schemas["LearningDraft"][] = [
        ...o.gap_categories.map((target) => ({ outcome_id: o.id, statement: `The prediction for '${o.title}' was ${a.verdict.replace("_", " ")}`, applies_to: "question_category" as const, target, direction, weight: 1 })),
        ...o.module_keys.map((target) => ({ outcome_id: o.id, statement: `Module ${target} backed a prediction that was ${a.verdict.replace("_", " ")}`, applies_to: "module" as const, target, direction, weight: 1 })),
      ];
      return json(200, { outcome: o, suggested_learnings });
    }
    return null;
  }

  if (p[1] === "learnings") {
    if (m === "GET" && p[2] === "signals") return json(200, signals(ctx.db, q.get("applies_to")));
    if (m === "GET" && !p[2]) {
      const hits = ctx.db.learnings.filter((l) =>
        ["applies_to", "target", "status"].every((k) => !q.get(k) || String(l[k as keyof Learning]) === q.get(k)),
      );
      return json(200, [...hits].reverse());
    }
    const denied = need("approver");
    if (denied) return denied;
    if (m === "POST" && !p[2]) {
      const data = await body<Schemas["LearningCreate"]>();
      const now = new Date().toISOString();
      const l: Learning = {
        id: uuid(), outcome_id: data.outcome_id ?? null, statement: data.statement, applies_to: data.applies_to,
        target: data.target, direction: data.direction, weight: data.weight ?? 1, status: "active", retired_reason: null,
        created_by: ctx.userId, retired_by: null, retired_at: null, created_at: now, updated_at: now,
      };
      ctx.db.learnings.push(l);
      return json(201, l);
    }
    if (m === "POST" && p[2] && p[3] === "retire") {
      const l = ctx.db.learnings.find((x) => x.id === p[2]);
      if (!l) return fail(404, "Learning not found");
      const { reason } = (await body<Schemas["LearningRetire"]>()) ?? {};
      const now = new Date().toISOString();
      if (l.status !== "retired") Object.assign(l, { status: "retired", retired_reason: reason ?? null, retired_by: ctx.userId, retired_at: now, updated_at: now });
      return json(200, l);
    }
    return null;
  }
  return null;
}
