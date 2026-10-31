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
  /** Checks that could not run, per PRD slug and criterion (the item's ``error``); the "quality" scenario sets one. */
  check_errors?: Record<string, Record<string, string>>;
}

export interface QualityContext {
  db: QualityDb;
  v2: V2Db;
  userId: string;
  role: Role;
  /** Resolves a document (slug or id) and version number to their ids, or null. */
  findVersion: (doc: string, n: number) => { documentId: string; slug: string; versionId: string; authorId?: string | null } | null;
  /** The blockers lane's ``critical_blockers`` hard check for a document (./blockers.ts). */
  blockerGate: (documentId: string) => { status: Status; rationale: string; evidence_ids: string[] };
  /** POST .../quality-review: queues a quality_review job in ./llm-jobs.ts, or refuses it (409 switched off). */
  queueReview?: (documentId: string, n: number) => Schemas["LlmJobOut"] | { status: number; detail: string };
  /** A built-in model job by id (the model review's job). */
  job?: (id: string) => Schemas["LlmJobOut"] | undefined;
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
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
  problem_clarity: ["pass", "The problem names its users and its pain is backed by 2 pieces of evidence.", ["problem"]],
  goal_alignment: ["pass", "Every linked feature (1) serves a confirmed goal (activation).", ["goal-trace"]],
  evidence_provenance: ["warning", "1 piece of evidence is stale.", []],
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
/** The blockers lane's hard check in plain words, as api/oracle/quality/service.py OTHER_CHECKS names it (qa-docs-57). */
const BLOCKERS_CHECK = {
  key: BLOCKERS_KEY,
  title: "Critical blockers",
  question: "Is any critical blocker still unresolved, with no accepted risk or approved experiment behind it?",
  hard: true,
};
const STATUSES: Status[] = ["pass", "warning", "critical", "not_applicable"];

export function seedQuality(): QualityDb {
  return { outcomes: [], learnings: [] };
}

// --- H3 Predicted versus actual ------------------------------------------------------

type Prediction = Schemas["Prediction"];
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const OUTCOME_SCORES: Record<string, number> = { held: 1, partially_held: 0.5, not_held: 0 };
export const CALIBRATION = { floor: 0.5, ceiling: 1.0, min: 5 };

/** The Outcomes table's state: predicted, tracking (measuring), due (a proposal waits), assessed. */
export function stateOf(o: Outcome): "predicted" | "tracking" | "due" | "assessed" {
  if (o.status === "predicted") return "predicted";
  if (o.status === "tracking") return o.proposed_assessment ? "due" : "tracking";
  return "assessed";
}

/** The API's PredictionIn check, in its words. */
function predictionProblem(p: Prediction): string | null {
  const base = p.baseline_value, want = p.predicted_value, line = p.threshold_value;
  if (base == null || want == null) return null;
  if (!p.direction) return "say which way the prediction goes: increase or decrease";
  if ((want - base) * (p.direction === "increase" ? 1 : -1) <= 0)
    return `an ${p.direction} prediction must be ${p.direction === "increase" ? "above" : "below"} its baseline`;
  if (line != null && !(Math.min(base, want) <= line && line <= Math.max(base, want)))
    return "the partly-held line lies between the baseline and the prediction";
  return null;
}

function outcomeRow(over: Partial<Outcome> & Pick<Outcome, "title" | "goal_id" | "status">, owner: string): Outcome {
  const at = new Date(Date.now() - 60 * DAY).toISOString();
  return {
    id: crypto.randomUUID(), outcome_entity_id: null, document_id: null, prd_version_id: null, roadmap_version_id: null,
    roadmap_item_key: null, experiment_id: null, module_keys: [], gap_categories: [], observed: null, assessments: [],
    owner_id: owner, created_by: owner, assessed_at: null, lock_version: 1, created_at: at, updated_at: at,
    roadmap_item_id: null, track_id: null, needs_prediction: false, confidence_at_prediction: 0.5, shipped_at: null,
    ship_signal: null, assess_due_on: null, proposed_assessment: null, decision_id: null,
    prediction: { metric: "Accounts that finish setup within 7 days", predicted: "42%", baseline: "38%", threshold: null, by: null },
    ...over,
  };
}

/** H1: the outcome record deciding a decision with a prediction makes (tracking), as the API's. */
export function addDecisionOutcome(
  db: QualityDb,
  d: { title: string; goal_id: string; prediction: Record<string, unknown>; evidence_ids: string[]; owner_id: string },
  me: string,
): string {
  const at = new Date().toISOString();
  const row = outcomeRow(
    {
      title: d.title, goal_id: d.goal_id, status: "tracking", prediction: d.prediction as Prediction,
      confidence_at_prediction: null, created_at: at, updated_at: at,
    },
    d.owner_id,
  );
  row.created_by = me;
  db.outcomes.push(row);
  return row.id;
}

/**
 * The "outcomes" scenario (synthetic): Saved payment methods is due for its check (38% → 42%,
 * now 41%), Guided setup checklist needs a prediction, Order status emails is measuring, and
 * six earlier predictions on Raise activation were assessed (3 held, 3 not; expected 4.2).
 */
export function seedOutcomes(owner: string, goalId: string, roadmapVersionId: string | null): Outcome[] {
  const now = Date.now();
  const by = isoDay(now - 20 * DAY);
  const typed: Prediction = {
    metric: "Accounts that finish setup within 7 days", baseline: "38%", predicted: "42%", threshold: "40%", by,
    unit: "%", direction: "increase", baseline_value: 38, predicted_value: 42, threshold_value: 40,
  };
  const shipped = new Date(now - 45 * DAY).toISOString();
  const rows: Outcome[] = [
    outcomeRow({
      title: "Saved payment methods", goal_id: goalId, status: "tracking", prediction: typed, roadmap_item_key: "saved-payment",
      gap_categories: ["success_metric"], module_keys: ["M-12"],
      roadmap_version_id: roadmapVersionId, confidence_at_prediction: 0.8, shipped_at: shipped, assess_due_on: isoDay(now - 2 * DAY),
      ship_signal: { kind: "tracker", refs: ["github:example-org/storefront#402", "github:example-org/storefront#403", "github:example-org/storefront#404"], at: shipped, note: null },
      proposed_assessment: { verdict: "partially_held", actual_value: 41, measured_at: isoDay(now - 3 * DAY), observed: "41%", source: "goal_history", note: null },
    }, owner),
    outcomeRow({
      title: "Guided setup checklist", goal_id: goalId, status: "predicted", needs_prediction: true, roadmap_item_key: "setup-checklist",
      roadmap_version_id: roadmapVersionId,
      prediction: { metric: "Accounts that finish setup within 7 days", baseline: "38%", predicted: "Not set yet", threshold: null, by: isoDay(now + 70 * DAY), unit: "%", direction: "increase", baseline_value: 38 },
    }, owner),
    outcomeRow({
      title: "Order status emails", goal_id: goalId, status: "tracking", roadmap_item_key: "status-emails", roadmap_version_id: roadmapVersionId,
      prediction: { ...typed, by: isoDay(now + 40 * DAY) }, shipped_at: shipped, assess_due_on: isoDay(now + 40 * DAY),
      ship_signal: { kind: "milestone", refs: [], at: shipped, note: null },
    }, owner),
  ];
  const past = [["held", 0.8], ["held", 0.8], ["held", 0.7], ["not_held", 0.7], ["not_held", 0.6], ["not_held", 0.6]] as const;
  past.forEach(([verdict, confidence], i) => {
    const at = new Date(now - (30 + i * 20) * DAY).toISOString();
    rows.push(outcomeRow({
      title: `Earlier activation bet ${i + 1}`, goal_id: goalId, status: verdict, confidence_at_prediction: confidence, assessed_at: at,
      observed: verdict === "held" ? "43%" : "37%", prediction: { ...typed, by: isoDay(now - (40 + i * 20) * DAY) },
      assessments: [{ verdict, observed: verdict === "held" ? "43%" : "37%", note: null, evidence_ids: [], assessed_by: owner, assessed_at: at, actor: "person", learnings: [] }],
    }, owner));
  });
  return rows;
}

/** The learnings an assessment drafts, in the API's words (oracle.quality.outcomes.draft_learnings). */
function draftLearnings(o: Outcome, verdict: Schemas["AssessmentIn"]["verdict"]): Schemas["DraftedLearning"][] {
  const draft = (applies_to: "question_category" | "module", target: string, statement: string, direction: Schemas["LearningDraft"]["direction"]) =>
    ({ outcome_id: o.id, statement, applies_to, target, direction, weight: 1, state: "drafted" as const, learning_id: null });
  if (verdict === "inconclusive")
    return [draft("question_category", "success_metric", `'${o.title}' could not be assessed: ask for a measurable metric and a decision threshold earlier`, "recommend_more")];
  const held = verdict === "held";
  const how = held ? "held" : verdict === "partially_held" ? "partly held" : "did not hold";
  const direction = held ? "note" : "recommend_more";
  return [
    ...o.gap_categories.map((c) => draft("question_category", c, `The prediction for '${o.title}' ${how}${held ? "" : `: ask about ${c.replaceAll("_", " ")} earlier`}`, direction)),
    ...o.module_keys.map((k) => draft("module", k, `Module ${k} backed a prediction that ${how}${held ? "" : "; recommend it with its validation fields filled"}`, direction)),
  ];
}

/** The "outcomes" scenarios' learning on record (synthetic): one a person kept by hand. */
export function seedLearnings(owner: string): Learning[] {
  const at = "2026-09-14T10:00:00Z";
  return [{
    id: "00000000-0000-4000-8000-0000000003a1", outcome_id: null, statement: "Ask for the metric's baseline before drafting",
    applies_to: "question_category", target: "success_metric", direction: "recommend_more", weight: 1, status: "active",
    retired_reason: null, created_by: owner, retired_by: null, retired_at: null, created_at: at, updated_at: at,
  }];
}

/** "outcomes-recorded" adds what H11 at Act within limits leaves: Oracle recorded Weekly digest email partly held. */
export function seedOracleRecorded(owner: string, goalId: string): Outcome {
  const now = Date.now();
  const at = new Date(now - 2 * DAY).toISOString();
  const shipped = new Date(now - 50 * DAY).toISOString();
  const o = outcomeRow({
    title: "Weekly digest email", goal_id: goalId, status: "partially_held", roadmap_item_key: "weekly-digest", confidence_at_prediction: 0.5,
    shipped_at: shipped, assess_due_on: isoDay(now - 3 * DAY), assessed_at: at, observed: "41%", gap_categories: ["success_metric"],
    ship_signal: { kind: "milestone", refs: [], at: shipped, note: null },
    prediction: {
      metric: "Accounts that finish setup within 7 days", baseline: "38%", predicted: "42%", threshold: "40%", by: isoDay(now - 10 * DAY),
      unit: "%", direction: "increase", baseline_value: 38, predicted_value: 42, threshold_value: 40,
    },
    proposed_assessment: { verdict: "partially_held", actual_value: 41, measured_at: isoDay(now - 4 * DAY), observed: "41%", source: "goal_history", note: null },
  }, owner);
  o.assessments = [{
    verdict: "partially_held", observed: "41%", note: null, evidence_ids: [], assessed_by: null, assessed_at: at, actual_value: 41,
    measured_at: isoDay(now - 4 * DAY), actor: "oracle", learnings: draftLearnings(o, "partially_held"),
  }];
  return o;
}

function figures(rows: Outcome[], min: number): Schemas["CalibrationFigures"] {
  const score = rows.reduce((s, o) => s + OUTCOME_SCORES[o.status], 0);
  const expected = rows.reduce((s, o) => s + (o.confidence_at_prediction ?? 0.5), 0);
  const factor = Math.round(Math.min(Math.max((score + 1) / (expected + 1), CALIBRATION.floor), CALIBRATION.ceiling) * 100) / 100;
  return {
    n: rows.length, score: Math.round(score * 1000) / 1000, expected: Math.round(expected * 1000) / 1000,
    factor: rows.length >= min && rows.length > 0 ? factor : null, held: rows.filter((o) => o.status === "held").length,
  };
}

/** GET /v1/priorities/calibration over the mock's outcomes; ``titles`` names the goals. */
export function calibration(db: QualityDb | undefined, titles: Record<string, string>, setting: "apply" | "show" = "apply"): Schemas["CalibrationOut"] {
  const since = Date.now() - 365 * DAY;
  const rows = (db?.outcomes ?? []).filter((o) => o.status in OUTCOME_SCORES && o.assessed_at && Date.parse(o.assessed_at) >= since);
  const byGoal = new Map<string, Outcome[]>();
  for (const o of rows) byGoal.set(o.goal_id, [...(byGoal.get(o.goal_id) ?? []), o]);
  return {
    setting, min_outcomes: CALIBRATION.min, floor: CALIBRATION.floor, ceiling: CALIBRATION.ceiling,
    company: figures(rows, CALIBRATION.min),
    goals: [...byGoal].map(([goal_id, rs]) => ({ goal_id, title: titles[goal_id] ?? "", ...figures(rs, CALIBRATION.min) })),
  };
}

const VERDICT_WORDS: Record<string, string> = { held: "held", partially_held: "partly held", not_held: "not held", inconclusive: "inconclusive" };
const shown = (v: number | null | undefined, unit?: string | null) => (v == null ? "no value" : `${v}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`);

/** The outcome rows of my Inbox, as GET /v1/inbox returns them. */
// The verdicts Oracle read but, below Recommend, does not propose (shown again once the level allows).
const unproposed = new WeakMap<Outcome, NonNullable<Outcome["proposed_assessment"]>["verdict"]>();

/**
 * The ticker's pass at H11 Check outcomes' level (the API's shipping.propose, run here before
 * each read): at Observe or Draft a due outcome keeps its actual with no verdict; from Recommend
 * the verdict is proposed; at Act Oracle records a verdict read from data and tells the owner
 * (the company's owners when it has none).
 */
export function outcomesPass(
  db: QualityDb | undefined,
  level: "observe" | "draft" | "recommend" | "act",
  owners: string[],
  acted: (a: { summary: string; subject: Record<string, unknown>; undo: null; notify: string[] }) => void,
) {
  for (const o of db?.outcomes ?? []) {
    const prop = o.proposed_assessment;
    if (o.status !== "tracking" || !prop) continue;
    if (level === "observe" || level === "draft") {
      if (prop.verdict != null) {
        unproposed.set(o, prop.verdict);
        prop.verdict = null;
      }
      continue;
    }
    if (prop.verdict == null && unproposed.has(o)) prop.verdict = unproposed.get(o)!;
    const v = prop.verdict;
    if (level !== "act" || !v || v === "inconclusive" || prop.actual_value == null) continue;
    const at = new Date().toISOString();
    o.assessments = [...o.assessments, {
      verdict: v, observed: prop.observed ?? "no value", note: null, evidence_ids: [], assessed_by: null, assessed_at: at,
      actual_value: prop.actual_value, measured_at: prop.measured_at ?? null, actor: "oracle", learnings: draftLearnings(o, v),
    }];
    Object.assign(o, { status: v, observed: prop.observed ?? "no value", assessed_at: at, updated_at: at, lock_version: o.lock_version + 1 });
    const notify = o.owner_id ? [o.owner_id] : owners;
    if (notify.length) {
      acted({
        summary: `Recorded ${VERDICT_WORDS[v]} for ${o.title}: the goal read ${prop.observed}`,
        subject: { kind: "outcome", key: o.id, href: `/plan/outcomes?outcome=${o.id}` },
        undo: null,
        notify,
      });
    }
  }
}

export function outcomeInboxRows(db: QualityDb | undefined, me: string, roadmapTitle: string): Schemas["InboxOutcome"][] {
  const mine = (db?.outcomes ?? []).filter((o) => o.owner_id === me);
  const out: Schemas["InboxOutcome"][] = [];
  const waiting = mine.filter((o) => o.status === "predicted" && o.needs_prediction);
  if (waiting.length) {
    const n = waiting.length;
    out.push({ id: waiting[0].id, title: `Add predictions · ${roadmapTitle} · ${n} item${n === 1 ? "" : "s"}`, reason: "needs_prediction", state: "predicted", counts: true, count: n, roadmap_version_id: waiting[0].roadmap_version_id ?? null, due_on: null });
  }
  for (const o of mine) {
    if (o.status === "tracking" && o.proposed_assessment) {
      const p = o.prediction;
      out.push({
        id: o.id, title: `Outcome check due · ${o.title} · predicted ${p.baseline ?? "?"} → ${p.predicted}, now ${shown(o.proposed_assessment.actual_value, p.unit)}`,
        reason: "check_due", state: "due", counts: true, count: 1, due_on: o.assess_due_on ?? null, roadmap_version_id: null,
      });
    }
    const last = o.assessments[o.assessments.length - 1];
    if (last?.actor === "oracle" && o.status in VERDICT_WORDS) {
      out.push({ id: o.id, title: `Oracle recorded: ${VERDICT_WORDS[o.status]} · ${o.title}`, reason: "oracle_recorded", state: "assessed", counts: false, count: 1, due_on: o.assess_due_on ?? null, roadmap_version_id: null });
    }
  }
  return out;
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

type Purpose = Schemas["ReadinessDashboard"]["purpose"];

/**
 * qa4-docs-share-11: as the API's rule (criteria.blocker_feasibility) reads the blockers linked
 * to the document, never "No blocker is recorded" beside an open one: an unresolved blocker
 * with an option or experiment but none chosen is a warning, a settled one passes. As the API
 * too, a critical blocker with no workable mitigation (no compliant option left and no planned,
 * running or succeeded experiment) is critical.
 */
function feasibility(ctx: QualityContext, gate: { status: Status; evidence_ids: string[] }): Rule {
  const stuck = (id: string) =>
    !ctx.v2.blocker_options.some((o) => o.blocker_id === id && o.compliance === "compliant" && o.status !== "rejected") &&
    !ctx.v2.feasibility_experiments.some((x) => x.blocker_id === id && ["planned", "running", "succeeded"].includes(x.status));
  if (gate.status === "critical" && gate.evidence_ids.some(stuck))
    return [
      "critical",
      "A critical blocker has no workable mitigation: no compliant option and no feasibility experiment. Advisory here; a critical blocker is held by the Critical blockers check.",
      ["risks"],
      gate.evidence_ids,
    ];
  return gate.status === "critical" || gate.status === "warning"
    ? [
        "warning",
        "A blocker is still open: options or experiments exist, none is chosen. Advisory here; a critical blocker is held by the Critical blockers check.",
        ["risks"],
        gate.evidence_ids,
      ]
    : ["pass", `Every blocker (${gate.evidence_ids.length}) is resolved or has a chosen option.`, ["risks"], gate.evidence_ids];
}

function dashboard(
  ctx: QualityContext,
  v: { documentId: string; slug: string; versionId: string; authorId?: string | null },
  n: number,
  purpose: Purpose = "advisory",
): Schemas["ReadinessDashboard"] {
  const model = reports(ctx, v.versionId, "llm_job")[0];
  const humans = reports(ctx, v.versionId, "human");
  const rules = RULES_BY_SLUG[v.slug] ?? RULES;
  const errors = ctx.db.check_errors?.[v.slug] ?? {};
  const gate = ctx.blockerGate(v.documentId);
  // The blockers lane registers its hard check after the quality criteria.
  const checks = [...CRITERIA, BLOCKERS_CHECK];
  const items: Schemas["ReadinessItem"][] = checks.map((c) => {
    const [status, rationale, section_keys, evidence_ids = []] =
      c.key === BLOCKERS_KEY
        ? [gate.status, gate.rationale, [], gate.evidence_ids]
        : c.key === "blocker_feasibility" && !RULES_BY_SLUG[v.slug] && gate.status !== "not_applicable"
          ? feasibility(ctx, gate)
          : rules[c.key];
    const mf = model && ctx.v2.evaluation_findings.find((f) => f.report_id === model.id && f.criterion === c.key);
    const human = humans.flatMap((r) =>
      ctx.v2.evaluation_findings
        .filter((f) => f.report_id === r.id && f.criterion === c.key)
        .map((f) => ({ status: f.status, rationale: f.rationale, rater_id: r.created_by, report_id: r.id, created_at: r.created_at })),
    );
    return {
      key: c.key, title: c.title, question: c.question, hard: c.hard, status, rationale,
      // qa-docs-2: as the API's rules name it, the version's author (who imported it), never whoever is looking.
      evidence_ids, owner_id: c.key === BLOCKERS_KEY ? null : (v.authorId ?? null), section_keys, error: errors[c.key] ?? null,
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
    composition_revision: null, policy: "advisory", policy_note: POLICY_NOTE, purpose,
    evaluated_at: new Date().toISOString(), blocked: blocking.length > 0, blocking,
    counts: counts(items.map((i) => i.status)), items,
    model_review: model ? modelInfo(ctx, model) : null,
    latest_report: latest ? { id: latest.id, created_at: latest.created_at } : null,
  };
}

function modelInfo(ctx: QualityContext, report: Schemas["EvaluationReportOut"]): Schemas["ModelReviewInfo"] {
  const jobId = typeof report.summary.job_id === "string" ? report.summary.job_id : null;
  const job = jobId ? ctx.job?.(jobId) : undefined;
  return {
    report_id: report.id, job_id: job?.id ?? null, model: job?.model ?? null, created_at: report.created_at,
    label: "model_output", disclaimer: typeof report.summary.disclaimer === "string" ? report.summary.disclaimer : DISCLAIMER,
  };
}

/**
 * The publish gate approve runs for a PRD (api/oracle/review/publish_gate.py): only the
 * latest version (C5), and refused while the verdict for purpose "publish" is blocked. The
 * 409 body, or null when the version may be published. ``critical_blockers`` names each
 * critical blocker (``blockerTitle``), as the Publish screen lists them.
 */
export function publishRefusal(
  ctx: QualityContext,
  v: { documentId: string; slug: string; versionId: string },
  n: number,
  latest: number,
  blockerTitle: (id: string) => string | undefined,
): Schemas["PublishBlockedOut"] | null {
  if (n !== latest) return { detail: `v${latest} exists: only the latest version can be published`, blocking: [], dates: [] };
  const verdict = dashboard(ctx, v, n, "publish");
  if (!verdict.blocked) return null;
  const blocking = verdict.items
    .filter((i) => i.hard && i.status === "critical")
    .flatMap((i): Schemas["PublishBlock"][] => {
      const named = i.key === BLOCKERS_KEY ? i.evidence_ids.flatMap((id) => {
        const title = blockerTitle(id);
        return title ? [{ key: i.key, id, title, rationale: i.rationale }] : [];
      }) : [];
      return named.length ? named : [{ key: i.key, id: i.key, title: i.title, rationale: i.rationale }];
    });
  return { detail: `${blocking.length} block${blocking.length === 1 ? "" : "s"}: ${blocking.map((b) => b.title).join(", ")}`, blocking, dates: [] };
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

type ModelFinding = { criterion: string; status: Status; rationale: string; section_keys: string[] };

/** The mock model's answer to a quality review: two criteria, labelled model output. */
const MOCK_ANSWER: ModelFinding[] = [
  { criterion: "validation_plan", status: "warning", rationale: "The pilot has no stated sample size.", section_keys: ["metrics"] },
  { criterion: "problem_clarity", status: "pass", rationale: "The problem names the users and quantifies the drop-off.", section_keys: ["problem"] },
];

/**
 * Stores a quality_review job's answer as the API's judge does (oracle.quality.judge.run):
 * an ``llm_job`` report labelled model output, its summary naming the job. Returns the job's output.
 */
export function storeModelReview(
  v2: V2Db,
  job: Schemas["LlmJobOut"],
  versionId: string,
  findings: ModelFinding[] = MOCK_ANSWER,
  summary = "Clear problem; the pilot lacks a sample size.",
  at = new Date().toISOString(),
): Record<string, unknown> {
  const c: Record<string, number> = {};
  for (const f of findings) c[f.status] = (c[f.status] ?? 0) + 1;
  const report: Schemas["EvaluationReportOut"] = {
    id: uuid(), document_id: job.document_id!, version_id: versionId, composition_revision: null, evaluator: "llm_job",
    policy: "advisory", status: "complete",
    summary: { label: "model_output", disclaimer: DISCLAIMER, job_id: job.id, counts: c, summary },
    created_by: job.requested_by ?? null, created_at: at,
  };
  v2.evaluation_reports.push(report);
  v2.evaluation_findings.push(
    ...findings.map((f) => ({ id: uuid(), report_id: report.id, ...f, hard: false, evidence_ids: [], owner_id: null, module_key: null, created_at: at })),
  );
  return { report_id: report.id, label: "model_output", criteria: findings.length, counts: c, summary };
}

/**
 * The "quality" scenarios (invented): Team workspaces v2 with a stored rules snapshot, a model
 * review of 7 of the 10 criteria and two people's ratings, and one check that could not run.
 * "quality-job-failed" adds a later model job that failed (pool paused); "quality-job-running"
 * one still running; "quality-off" turns the quality review off for the PRD and stores nothing.
 */
export function seedQualityScenario(
  scenario: string,
  s: {
    quality: QualityDb;
    v2: V2Db;
    jobs: Schemas["LlmJobOut"][];
    disabled: Record<string, Schemas["LlmJobOut"]["kind"][]>;
    documentId: string;
    versionId: string;
    owner: string;
    approver: string;
    commenter: string;
  },
) {
  if (scenario === "quality-off") {
    s.disabled[s.documentId] = [...(s.disabled[s.documentId] ?? []), "quality_review"];
    return;
  }
  const base = { document_id: s.documentId, version_id: s.versionId, composition_revision: null, policy: "advisory", status: "complete" as const };
  const report = (evaluator: "rules" | "human", by: string, at: string, rows: [string, Status, string, string[]][], summary: Record<string, unknown>) => {
    const r: Schemas["EvaluationReportOut"] = { id: uuid(), ...base, evaluator, summary: { counts: counts(rows.map((x) => x[1])), ...summary }, created_by: by, created_at: at };
    s.v2.evaluation_reports.push(r);
    s.v2.evaluation_findings.push(
      ...rows.map(([criterion, status, rationale, section_keys]) => ({
        id: uuid(), report_id: r.id, criterion, status, rationale, hard: evaluator === "rules" && CRITERIA.findIndex((c) => c.key === criterion) >= 10,
        evidence_ids: [], owner_id: by, section_keys, module_key: null, created_at: at,
      })),
    );
  };
  s.quality.check_errors = { "team-workspaces": { downstream_consistency: "artifact dependency lookup timed out" } };
  report("rules", s.owner, "2026-10-20T09:41:00Z",
    CRITERIA.map((c) => [c.key, RULES[c.key][0], RULES[c.key][1], RULES[c.key][2]]),
    { blocked: false, blocking: [], errors: ["downstream_consistency"] });
  report("human", s.commenter, "2026-10-20T11:05:00Z",
    [["scope_testability", "warning", "Non-goals are implied in the scope section; only the acceptance criteria need work.", ["solution"]]],
    { note: "Mostly fine; the acceptance criteria need tests." });
  report("human", s.approver, "2026-10-21T16:20:00Z",
    [
      ["scope_testability", "critical", "Agree: AC-4 cannot be tested.", ["solution"]],
      ["problem_clarity", "pass", "The problem is clear and backed by calls.", ["problem"]],
    ],
    { note: null });
  const at = "2026-10-21T09:52:00Z";
  const job: Schemas["LlmJobOut"] = {
    id: uuid(), kind: "quality_review", document_id: s.documentId, version_number: 2, section_key: null, status: "succeeded",
    input: { version: 2 }, output: null, account_label: "personal", via: "account", model: "claude-sonnet-5",
    input_tokens: 12410, output_tokens: 1128, cost_usd: 0.05, attempts: 1, error: null, error_reason: null, next_reset_at: null,
    requested_by: s.owner, created_at: "2026-10-21T09:51:00Z", started_at: "2026-10-21T09:51:10Z", finished_at: at,
  };
  job.output = storeModelReview(s.v2, job, s.versionId, [
    { criterion: "problem_clarity", status: "pass", rationale: "The problem names the teams who share work and the calls that asked for it.", section_keys: ["problem"] },
    { criterion: "goal_alignment", status: "pass", rationale: "Shared editing maps to the activation goal.", section_keys: [] },
    { criterion: "evidence_provenance", status: "warning", rationale: "One cited figure is older than the last release.", section_keys: [] },
    { criterion: "blocker_feasibility", status: "warning", rationale: "The permissions migration has no stated fallback.", section_keys: [] },
    { criterion: "scope_testability", status: "critical", rationale: "Acceptance criteria describe intent (\"feels easy\") rather than tests; non-goals are missing.", section_keys: ["solution"] },
    { criterion: "validation_plan", status: "warning", rationale: "The pilot has no stated sample size.", section_keys: [] },
    { criterion: "ownership_readiness", status: "pass", rationale: "An owner and a rollout plan are named.", section_keys: [] },
  ], "Clear problem and evidence; the acceptance criteria are not testable.", at);
  s.jobs.push(job);
  if (scenario === "quality-job-failed" || scenario === "quality-job-running") {
    const failed = scenario === "quality-job-failed";
    s.jobs.push({
      ...job, id: uuid(), status: failed ? "failed" : "running", output: null, model: failed ? null : "claude-sonnet-5",
      input_tokens: null, output_tokens: null, cost_usd: null, attempts: 1,
      error: failed ? "no Claude account could take the call" : null, error_reason: failed ? "pool_paused" : null,
      next_reset_at: failed ? "2026-10-22T14:00:00Z" : null,
      created_at: "2026-10-22T10:14:00Z", started_at: "2026-10-22T10:14:05Z", finished_at: failed ? "2026-10-22T10:14:30Z" : null,
    });
  }
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
    if (p[5] === "readiness" && m === "GET") {
      const purpose = q.get("purpose") ?? "advisory";
      if (purpose !== "advisory" && purpose !== "publish") return fail(422, "purpose must be advisory or publish");
      return v ? json(200, dashboard(ctx, v, n, purpose)) : fail(404, "Version not found");
    }
    if (p[5] === "evaluations" && m === "POST" && !p[6]) {
      const denied = need("commenter");
      if (denied) return denied;
      if (!v) return fail(404, "Version not found");
      // A snapshot of what the dashboard shows: every registered check.
      const d = dashboard(ctx, v, n);
      const findings = d.items.map((i) => ({ criterion: i.key, status: i.status, rationale: i.rationale, hard: i.hard, section_keys: i.section_keys }));
      return json(201, storeReport(ctx, v, "rules", findings, { blocked: d.blocked, blocking: d.blocking, errors: d.items.filter((i) => i.error).map((i) => i.key) }));
    }
    if (p[5] === "evaluations" && p[6] === "human" && m === "POST") {
      const denied = need("commenter");
      if (denied) return denied;
      if (!v) return fail(404, "Version not found");
      const data = await body<Schemas["HumanRatingIn"]>();
      const keys = CRITERIA.slice(0, 10).map((c) => c.key);
      if (!data?.ratings?.length) return fail(422, "ratings: List should have at least 1 item after validation, not 0");
      if (data.ratings.some((r) => !r.rationale?.trim())) return fail(422, "rationale: String should have at least 1 character");
      const unknown = [...new Set(data.ratings.map((r) => r.criterion).filter((c) => !keys.includes(c)))].sort();
      if (unknown.length) return fail(422, `unknown criteria: ${unknown.join(", ")}; expected one of ${keys.join(", ")}`);
      if (new Set(data.ratings.map((r) => r.criterion)).size !== data.ratings.length) return fail(422, "rate each criterion once");
      const findings = data.ratings.map((r) => ({ criterion: r.criterion, status: r.status, rationale: r.rationale, hard: false, section_keys: r.section_keys ?? [] }));
      return json(201, storeReport(ctx, v, "human", findings, { note: data.note ?? null }));
    }
    if (p[5] === "quality-review" && m === "POST") {
      const denied = need("approver");
      if (denied) return denied;
      if (!v) return fail(404, "Version not found");
      // A quality_review job, run by the mock's tick (./llm-jobs.ts) like the worker would.
      const job = ctx.queueReview?.(v.documentId, n);
      if (!job) return fail(503, "No job queue");
      if (!("id" in job)) return fail(job.status, job.detail);
      return json(201, job);
    }
    return null;
  }

  if (p[1] === "outcomes") {
    if (m === "GET" && !p[2]) {
      const hits = ctx.db.outcomes.filter(
        (o) =>
          ["goal_id", "document_id", "status", "track_id", "roadmap_item_id"].every(
            (k) => !q.get(k) || String(o[k as keyof Outcome]) === q.get(k),
          ) &&
          (!q.get("state") || stateOf(o) === q.get("state")) &&
          (!q.get("needs_prediction") || String(o.needs_prediction) === q.get("needs_prediction")),
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
      if (data.roadmap_item_id && ctx.db.outcomes.some((x) => x.roadmap_item_id === data.roadmap_item_id))
        return fail(409, "That roadmap item already has an outcome record");
      const now = new Date().toISOString();
      const o: Outcome = {
        id: uuid(), title: data.title, goal_id: data.goal_id, outcome_entity_id: data.outcome_entity_id ?? null,
        document_id: null, prd_version_id: data.prd_version_id ?? null, roadmap_version_id: data.roadmap_version_id ?? null,
        roadmap_item_key: data.roadmap_item_key ?? null, experiment_id: data.experiment_id ?? null,
        roadmap_item_id: data.roadmap_item_id ?? null,
        prediction: { baseline: null, threshold: null, by: null, ...data.prediction },
        module_keys: data.module_keys ?? [], gap_categories: data.gap_categories ?? [], status: "tracking", observed: null,
        needs_prediction: data.prediction.predicted_value == null && !!data.roadmap_item_id,
        assessments: [], owner_id: data.owner_id ?? ctx.userId, created_by: ctx.userId, assessed_at: null, lock_version: 1,
        created_at: now, updated_at: now,
      };
      ctx.db.outcomes.push(o);
      return json(201, o);
    }
    if (m === "PATCH" && p[2] && !p[3]) {
      const o = ctx.db.outcomes.find((x) => x.id === p[2]);
      if (!o) return fail(404, "Outcome not found");
      const data = await body<Schemas["OutcomeUpdate"]>();
      if (data.lock_version !== o.lock_version) return fail(409, "This outcome changed since you opened it; reload it");
      if (data.prediction) {
        if (o.status !== "predicted") return fail(409, "Shipped: the prediction is frozen");
        const problem = predictionProblem(data.prediction);
        if (problem) return fail(422, problem);
        o.prediction = { baseline: null, threshold: null, by: null, ...data.prediction };
        o.needs_prediction = data.prediction.predicted_value == null;
      }
      if (data.owner_id) o.owner_id = data.owner_id;
      Object.assign(o, { updated_at: new Date().toISOString(), lock_version: o.lock_version + 1 });
      return json(200, o);
    }
    if (m === "POST" && p[2] && p[3] === "shipped") {
      const o = ctx.db.outcomes.find((x) => x.id === p[2]);
      if (!o) return fail(404, "Outcome not found");
      if (o.status !== "predicted") return fail(409, "Already shipped");
      const data = (await body<Schemas["ShippedIn"]>()) ?? {};
      const at = data.at ?? new Date().toISOString();
      const after = new Date(Date.parse(at) + 30 * 86_400_000).toISOString().slice(0, 10);
      const by = o.prediction.by ?? null;
      Object.assign(o, {
        status: "tracking", shipped_at: at, ship_signal: { kind: "manual", refs: [], at, note: data.note ?? null },
        assess_due_on: by && by > after ? by : after, lock_version: o.lock_version + 1,
      });
      return json(200, o);
    }
    if (m === "POST" && p[2] && p[3] === "assessments") {
      const o = ctx.db.outcomes.find((x) => x.id === p[2]);
      if (!o) return fail(404, "Outcome not found");
      if (o.status === "predicted") return fail(409, "Not shipped yet: mark it shipped before assessing it");
      const a = await body<Schemas["AssessmentIn"]>();
      const now = new Date().toISOString();
      const learnings = draftLearnings(o, a.verdict);
      o.assessments.push({
        verdict: a.verdict, observed: a.observed, note: a.note ?? null, evidence_ids: a.evidence_ids ?? [], assessed_by: ctx.userId,
        assessed_at: now, actual_value: a.actual_value ?? null, measured_at: a.measured_at ?? null, actor: "person", learnings,
      });
      Object.assign(o, { status: a.verdict, observed: a.observed, assessed_at: now, updated_at: now, lock_version: o.lock_version + 1 });
      const suggested_learnings: Schemas["LearningDraft"][] = learnings.map((d) => ({
        outcome_id: d.outcome_id, statement: d.statement, applies_to: d.applies_to, target: d.target, direction: d.direction, weight: d.weight,
      }));
      return json(200, { outcome: o, suggested_learnings });
    }
    if (m === "POST" && p[2] && p[3] === "learnings" && p[4]) {
      const o = ctx.db.outcomes.find((x) => x.id === p[2]);
      if (!o) return fail(404, "Outcome not found");
      const last = o.assessments[o.assessments.length - 1];
      const draft = last?.learnings?.[Number(p[4])];
      if (!draft) return fail(404, "Drafted learning not found");
      if (draft.state !== "drafted") return fail(409, "Already decided");
      const { decision } = await body<Schemas["LearningDecision"]>();
      if (decision === "keep") {
        const now = new Date().toISOString();
        const l: Learning = {
          id: uuid(), outcome_id: o.id, statement: draft.statement, applies_to: draft.applies_to, target: draft.target,
          direction: draft.direction, weight: draft.weight ?? 1, status: "active", retired_reason: null,
          created_by: ctx.userId, retired_by: null, retired_at: null, created_at: now, updated_at: now,
        };
        ctx.db.learnings.push(l);
        Object.assign(draft, { state: "kept", learning_id: l.id });
      } else draft.state = "skipped";
      o.updated_at = new Date().toISOString();
      return json(200, o);
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
