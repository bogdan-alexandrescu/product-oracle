/**
 * Mock of the intake routes (api/oracle/intake/router.py) for NEXT_PUBLIC_API_MOCKS=1:
 * New product idea, the Opportunity and Gaps summary, question batches, answers,
 * decisions and proposals. It works on the v2 mock tables (./v2.ts) and keeps the API's
 * shapes and role rules; its analysis is a fixed, simplified stand-in for the engine
 * (one gap per category, ranked by importance and impact). It has no source items, so it
 * has no S6 findings: GET .../findings is empty and only the author may set a level.
 * B4 (owners clear critical gaps) and the author-only repin and re-analysis hold here too.
 * Synthetic placeholders only.
 */
import type { Schemas } from "@/lib/api/client";
import type { V2Db } from "./v2";

type Role = "viewer" | "commenter" | "approver" | "owner";
type Gap = Schemas["KnowledgeGapOut"];
type Question = Schemas["StakeholderQuestionOut"];
type Intake = Schemas["ProductIntakeOut"];
type Proposal = Schemas["IntakeProposalOut"];
type Category = Gap["category"];
type Impact = Gap["impact"][number];
type Importance = Gap["importance"];

export interface IntakeContext {
  userId: string;
  role: Role;
  /** Creates a draft run through the runs mock (POST /v1/runs). */
  createRun: (body: Schemas["RunCreate"]) => Promise<Response>;
}

const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);
const OPEN = new Set<Gap["status"]>(["unknown", "under_investigation", "asked"]);
const DECIDED = new Set<Gap["status"]>(["answered", "validated", "accepted_risk"]);
const FROZEN = new Set<Gap["status"]>(["validated", "accepted_risk"]);
const PATHS: Schemas["QuestionCard"]["answer_paths"] = ["answer", "dont_know", "defer", "delegate", "research"];
const HARD = new Set<Category>(["blockers", "third_party_policy"]);

/** The seventeen §5 categories: label, default importance, impact, question, modules. */
const CATEGORIES: [Category, string, Importance, Impact[], string, string[]][] = [
  ["customer_user", "Customer and user", "high", ["goals", "scope", "module_selection"], "Who exactly is this for, and which segment comes first?", ["context.users"]],
  ["pain_evidence", "Pain evidence", "high", ["goals", "economics"], "What shows this pain is real, and how often does it happen?", ["problem.evidence"]],
  ["goal_alignment", "Company-goal alignment", "critical", ["goals", "scope"], "Which confirmed company goal does this serve, and how much does it contribute (0-3)?", ["goals.outcomes"]],
  ["success_metric", "Success metric and baseline", "critical", ["goals", "scope"], "Which metric shows this worked, what is its value today, and what target by when?", ["goals.outcomes"]],
  ["differentiation", "Strategic differentiation", "medium", ["goals", "economics"], "What makes this better than what buyers can already do or buy?", []],
  ["alternatives", "Alternatives", "medium", ["scope", "feasibility"], "Which alternatives did you consider, including doing nothing?", []],
  ["constraints", "Current and future constraints", "high", ["feasibility", "scope"], "Which technical, legal or team constraints apply now, and later?", ["constraints.solutions"]],
  ["blockers", "Blockers", "high", ["feasibility", "risks", "module_selection"], "What could stop this from shipping at all?", ["constraints.solutions"]],
  ["economic_benefit", "Expected economic benefit", "high", ["economics", "goals"], "What is this worth, roughly and by when?", ["business.case"]],
  ["effort_cost", "Effort and cost", "medium", ["economics", "feasibility"], "Roughly how much effort and running cost would this take?", []],
  ["security_privacy", "Security and privacy", "critical", ["risks", "feasibility", "module_selection"], "Which personal or sensitive data does this touch, and which review does it need?", ["security.privacy"]],
  ["ownership", "Team ownership", "high", ["risks", "scope"], "Which team and which person own building it and its outcome?", []],
  ["non_goals", "Non-goals", "medium", ["scope"], "What is deliberately out of scope for the first release?", ["scope.non_goals"]],
  ["release_rollout", "Release and rollout", "medium", ["risks", "scope"], "How should this roll out, and how would we roll it back?", ["launch.rollout"]],
  ["evaluation_criteria", "Evaluation criteria", "low", ["goals", "risks"], "How will we judge quality before launch?", ["quality.evaluation"]],
  ["third_party_policy", "Third-party policy and API limits", "low", ["feasibility", "risks", "module_selection"], "Which third-party APIs does this rely on, and what are their limits and policies?", ["constraints.solutions", "integrations.third_party"]],
  ["configurability_scaling", "Configurability and scaling", "low", ["feasibility", "economics"], "What scale must this handle, and what must be configurable?", ["scaling.operations"]],
];
const LABEL = Object.fromEntries(CATEGORIES.map((c) => [c[0], c[1]])) as Record<Category, string>;
const IMPACT_WEIGHT: Record<Impact, number> = { goals: 3, feasibility: 3, scope: 2, economics: 2, risks: 2, module_selection: 1 };
const IMPORTANCE_WEIGHT: Record<Importance, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const KNOWN: Record<Gap["knowledge_state"], number> = { unknown: 0, hypothesis: 0.1, ai_inference: 0.4, user_decision: 1, verified_fact: 1 };

let counter = 0;
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  counter += 1;
  return `00000000-0000-4000-8000-${String(Date.now() + counter).padStart(12, "0").slice(-12)}`;
}
const now = () => new Date().toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });
const forbidden = (min: Role) => fail(403, `Requires the ${min} role`);

const score = (g: Gap) =>
  IMPORTANCE_WEIGHT[g.importance] * g.impact.reduce((s, a) => s + IMPACT_WEIGHT[a], 0) * (1 - KNOWN[g.knowledge_state]);
const group = (g: Gap) => (OPEN.has(g.status) ? 0 : g.status === "deferred" ? 1 : 2);
function ranked(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => group(a) - group(b) || score(b) - score(a));
}

function rankedOut(gaps: Gap[]): Schemas["RankedGap"][] {
  return ranked(gaps).map((g, i) => ({
    ...g,
    rank: i + 1,
    score: Math.round(score(g) * 1000) / 1000,
    rank_reason: `${g.importance[0].toUpperCase()}${g.importance.slice(1)} ${LABEL[g.category].toLowerCase()} gap: affects ${g.impact.join(", ").replace(/_/g, " ")}.`,
    evidence: [],
  }));
}

function nextActions(g: Gap): Schemas["NextAction"][] {
  if (!OPEN.has(g.status) && g.status !== "deferred") return [];
  const owner = g.importance === "critical" ? "owner" : "approver";
  return [
    { gap_id: g.id, kind: "answer", label: `Answer the ${LABEL[g.category].toLowerCase()} question`, role: "commenter" },
    { gap_id: g.id, kind: "research", label: "Research this: propose a run that looks into it", role: "commenter" },
    { gap_id: g.id, kind: "delegate", label: "Ask someone who knows", role: "commenter" },
    { gap_id: g.id, kind: "accept_assumption", label: "Proceed on a stated assumption, with a review date", role: owner },
    { gap_id: g.id, kind: "accept_risk", label: "Accept the risk explicitly, with a reason", role: owner },
  ];
}

function intakeOut(i: Intake): Schemas["IntakeOut"] {
  const ids = (i.analysis as { source_ids?: string[] }).source_ids;
  return { ...i, source_ids: Array.isArray(ids) ? ids : [] };
}

function summary(db: V2Db, intake: Intake, userId: string): Schemas["IntakeSummary"] {
  const gaps = db.gaps.filter((g) => g.intake_id === intake.id);
  const questions = db.questions.filter((q) => q.intake_id === intake.id);
  const out = rankedOut(gaps);
  const open = out.filter((g) => OPEN.has(g.status));
  const versions = intake.source_snapshot_ids.map((id, n) => ({ version: n + 1, snapshot_id: id, as_of: intake.created_at }));
  const last = versions[versions.length - 1];
  const critical = gaps.filter((g) => g.importance === "critical" && !DECIDED.has(g.status));
  const blocking = critical.filter((g) => HARD.has(g.category)).map((g) => g.id);
  const modules: Schemas["ModuleHint"][] = [
    { key: "goals.outcomes", policy: "required", reason: "Every feature traces to a confirmed company goal (F3b).", gap_ids: [] },
    { key: "problem.evidence", policy: "required", reason: "The problem needs evidence or an explicitly accepted assumption.", gap_ids: [] },
  ];
  for (const g of ranked(gaps)) {
    if (!["critical", "high"].includes(g.importance) || (DECIDED.has(g.status) && g.status !== "accepted_risk")) continue;
    for (const key of g.related_modules) {
      let hint = modules.find((m) => m.key === key);
      if (!hint) {
        hint = { key, policy: "conditional", reason: `${LABEL[g.category]} is ${g.importance} for this idea.`, gap_ids: [] };
        modules.push(hint);
      }
      if (!hint.gap_ids.includes(g.id)) hint.gap_ids.push(g.id);
    }
  }
  const batches = questions.map((q) => q.batch).filter((b): b is number => b != null);
  const coverage = CATEGORIES.map(([key]) => {
    const g = gaps.find((x) => x.category === key);
    return {
      category: key,
      state: !g || DECIDED.has(g.status) ? "covered" : g.knowledge_state === "unknown" ? "missing" : "partial",
      knowledge_state: g?.knowledge_state ?? "user_decision",
      reason: g ? (DECIDED.has(g.status) ? `Decided (${g.status}).` : "Nothing in the pinned sources or the baseline answers it.") : "The baseline answers it.",
      entity_ids: g?.entity_ids ?? [],
      gap_id: g?.id ?? null,
    } as Schemas["Coverage"];
  });
  const scope = ((intake.analysis as { scope?: string[] }).scope ?? []).filter((s) => typeof s === "string");
  return {
    intake: intakeOut(intake),
    pinned: { version: versions.length, snapshot_id: last?.snapshot_id ?? null, as_of: last?.as_of ?? null, versions },
    new_evidence: { since_version: versions.length, as_of: last?.as_of ?? null, count: intake.author_id === userId ? 0 : null, visible: intake.author_id === userId, items: [] },
    extracted: [
      { field: "problem", text: intake.brief.split(/(?<=[.!?])\s+/)[0].replace(/\.$/, ""), knowledge_state: "hypothesis", origin: "brief", evidence: [] },
      ...scope.map((s) => ({ field: "scope" as const, text: s, knowledge_state: "hypothesis" as const, origin: "brief" as const, evidence: [] })),
    ],
    coverage,
    goals: [],
    missing_goals: true,
    features: scope.map((s) => ({
      title: s,
      entity_id: null,
      key: null,
      knowledge_state: "hypothesis",
      goals: [],
      flags: ["serves_no_goal"],
      rationale: "Serves no confirmed company goal. Under goal-weighted prioritisation (O3) it scores zero and sinks; link it to a confirmed goal, or record a decision to proceed anyway.",
    })),
    conflicts: [],
    stale: [],
    assumptions: open.filter((g) => g.knowledge_state === "hypothesis" || g.knowledge_state === "ai_inference"),
    top_uncertainties: open.slice(0, 5),
    gaps: out,
    next_actions: gaps.filter((g) => g.importance === "critical").flatMap(nextActions),
    template: { key: "oracle-default", name: "Goal-traced PRD", reason: "A cross-functional build: the goal-traced PRD agrees the problem, then the prioritized solution, then launch.", theme: null, modules },
    readiness: { open_critical: critical.length, blocking_gap_ids: blocking, gate: blocking.length ? "blocked" : "clear", private_blocking_gap_ids: [] },
    batch: {
      current: batches.length ? Math.max(...batches) : null,
      asked: questions.filter((q) => q.status === "asked" || q.status === "delegated").length,
      answered: questions.filter((q) => q.status === "answered").length,
      remaining: questions.filter((q) => q.status === "draft").length,
    },
    proposals: (db.intake_proposals ?? []).filter((p) => p.intake_id === intake.id),
    shared_counts: [],
    is_author: intake.author_id === userId,
  };
}

function batchView(db: V2Db, intake: Intake, n: number | null): Schemas["QuestionBatch"] {
  const questions = db.questions.filter((q) => q.intake_id === intake.id);
  const batch = n ?? (Math.max(0, ...questions.map((q) => q.batch ?? 0)) || null);
  return {
    intake_id: intake.id,
    batch,
    questions: questions
      .filter((q) => batch != null && q.batch === batch)
      .sort((a, b) => a.priority - b.priority)
      .map((q) => ({
        question: q,
        gap: db.gaps.find((g) => g.id === q.gap_id) ?? null,
        evidence: [],
        answer_paths: PATHS,
        answers: db.answers.filter((a) => a.question_id === q.id),
      })),
    remaining: questions.filter((q) => q.status === "draft").length,
  };
}

/** Keep one question per open gap, drafted in rank order. */
function syncQuestions(db: V2Db, intake: Intake) {
  ranked(db.gaps.filter((g) => g.intake_id === intake.id)).forEach((g, i) => {
    const mine = db.questions.filter((q) => q.gap_id === g.id && q.status !== "withdrawn");
    if (!OPEN.has(g.status)) {
      mine.filter((q) => q.status === "draft").forEach((q) => (q.status = "withdrawn"));
      return;
    }
    mine.filter((q) => q.status === "draft").forEach((q) => (q.priority = (i + 1) * 10));
    if (mine.length || g.status !== "unknown") return;
    const prompt = CATEGORIES.find((c) => c[0] === g.category)?.[4] ?? g.statement;
    db.questions.push({
      id: uuid(), gap_id: g.id, intake_id: intake.id, document_id: intake.document_id, category: g.category,
      prompt, rationale: `${LABEL[g.category]} gap, ${g.importance}.`, priority: (i + 1) * 10, batch: null,
      asked_to: g.owner_id, asked_by: null, module_key: g.related_modules[0] ?? null, section_key: g.section_keys[0] ?? null,
      status: "draft", created_at: now(), updated_at: now(),
    });
  });
}

function askBatch(db: V2Db, intake: Intake, userId: string, size: number): Question[] {
  const questions = db.questions.filter((q) => q.intake_id === intake.id);
  const drafts = questions.filter((q) => q.status === "draft").sort((a, b) => a.priority - b.priority).slice(0, size);
  const n = Math.max(0, ...questions.map((q) => q.batch ?? 0)) + 1;
  for (const q of drafts) {
    Object.assign(q, { status: "asked", batch: n, asked_by: userId, updated_at: now() });
    const g = db.gaps.find((x) => x.id === q.gap_id);
    if (g && g.status === "unknown") g.status = "asked";
  }
  return drafts;
}

function proposeResearch(db: V2Db, intake: Intake, gap: Gap, userId: string, questionId: string | null, investigate: boolean): Proposal {
  db.intake_proposals ??= [];
  const open = db.intake_proposals.find((p) => p.gap_id === gap.id && p.kind === "research_run" && p.status === "proposed");
  if (open) return open;
  const p: Proposal = {
    id: uuid(), intake_id: intake.id, gap_id: gap.id, question_id: questionId, answer_id: null, kind: "research_run",
    title: `Research: ${LABEL[gap.category]}`,
    detail: { gap_ids: [gap.id], flow: "baseline_to_prd", depth: "quick" },
    status: "proposed", result: {}, created_by: userId, decided_by: null, decided_at: null, decision_note: null,
    created_at: now(), updated_at: now(),
  };
  db.intake_proposals.push(p);
  if (investigate && (gap.status === "unknown" || gap.status === "asked")) gap.status = "under_investigation";
  return p;
}

/** /v1/intakes..., /v1/gaps..., /v1/questions/{id}/answers, /v1/intake-proposals/...;
 * null when the route is not one of these (reads fall through to ./v2.ts). */
export async function routeIntake(db: V2Db, ctx: IntakeContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const findIntake = (id: string) => db.intakes.find((i) => i.id === id);

  if (p[1] === "intakes" && p.length === 2 && m === "POST") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const input = await body<Schemas["IntakeCreate"]>();
    if (!input?.title || !input.brief || input.brief.trim().length < 20 || input.brief.length > 4000) return fail(422, "a brief needs at least a sentence");
    const scope = input.brief.split(/(?<=[.!?])\s+/)[1]?.replace(/\.$/, "") ?? input.title;
    const analysis = {
      users: [], problem: null, outcomes: [], goal_ids: [], scope: [scope], non_goals: [], dependencies: [],
      blockers: [], category: "feature", conflicts: [], source_ids: input.source_ids ?? [], signals: {},
    };
    const intake: Intake = {
      id: uuid(), title: input.title, brief: input.brief.trim(), author_id: ctx.userId, source_snapshot_ids: [uuid()],
      status: "awaiting_answers", document_id: null, lock_version: 1, created_at: now(), updated_at: now(), analysis,
    };
    db.intakes.push(intake);
    for (const [key, , importance, impact, , modules] of CATEGORIES) {
      db.gaps.push({
        id: uuid(), intake_id: intake.id, document_id: null, category: key, statement: `${LABEL[key]}: not known yet.`,
        impact, importance, evidence_ids: [], confidence: null, knowledge_state: "unknown", status: "unknown",
        owner_id: null, related_modules: modules, stop_condition: null, entity_ids: [], section_keys: [],
        created_by: null, lock_version: 1, created_at: now(), updated_at: now(),
      });
    }
    syncQuestions(db, intake);
    askBatch(db, intake, ctx.userId, input.batch_size ?? 5);
    return json(201, summary(db, intake, ctx.userId));
  }

  if (p[1] === "intakes" && p[2] && p.length >= 3 && !(p.length === 3 && m === "GET")) {
    const intake = findIntake(p[2]);
    if (!intake) return fail(404, "Intake not found");
    const leaf = p[3];
    if (p.length === 3 && m === "PATCH") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      if (intake.author_id !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "Only the intake's author or an approver can do this");
      const patch = await body<Schemas["IntakePatch"]>();
      if (patch.lock_version !== intake.lock_version) return fail(409, "Someone else changed this since you loaded it; reload and try again");
      if ("document" in patch && !atLeast(ctx.role, "approver")) return fail(403, "Linking an intake to a PRD needs an approver");
      if (patch.title) intake.title = patch.title;
      if (patch.status) intake.status = patch.status;
      intake.lock_version += 1;
      intake.updated_at = now();
      return json(200, intakeOut(intake));
    }
    if (leaf === "summary" && m === "GET") return json(200, summary(db, intake, ctx.userId));
    if (leaf === "new-evidence" && m === "GET") return json(200, summary(db, intake, ctx.userId).new_evidence);
    if (leaf === "evidence" && m === "GET") {
      if (!q.get("q")) return fail(422, "q is required");
      return json(200, { intake_id: intake.id, q: q.get("q"), pinned_version: intake.source_snapshot_ids.length, as_of: intake.created_at, hits: [] });
    }
    if (leaf === "question-batch" && m === "GET") {
      const n = q.get("batch");
      return json(200, batchView(db, intake, n ? Number(n) : null));
    }
    if (leaf === "composition-inputs" && m === "GET") {
      const gaps = db.gaps.filter((g) => g.intake_id === intake.id);
      const critical = gaps.filter((g) => g.importance === "critical" && !DECIDED.has(g.status));
      return json(200, {
        template: {}, brief: { title: intake.title, text: intake.brief }, category: "feature", scope: {}, signals: {},
        baseline: {}, sources: {}, stakeholders: { answered: gaps.filter((g) => DECIDED.has(g.status)).length, open: gaps.filter((g) => OPEN.has(g.status)).length },
        outputs: ["prd"], blockers: { open_critical_gap_ids: critical.map((g) => g.id) }, policy: {},
        intake_id: intake.id, baseline_snapshot_id: null, source_snapshot_ids: intake.source_snapshot_ids,
      });
    }
    if (leaf === "proposals" && m === "GET") return json(200, (db.intake_proposals ?? []).filter((x) => x.intake_id === intake.id));
    if (leaf === "findings" && m === "GET") return json(200, [] satisfies Schemas["FindingOut"][]);
    if (leaf === "findings" && (m === "PATCH" || m === "POST")) {
      if (intake.author_id !== ctx.userId) return fail(403, "Only the intake's author can share its findings");
      return fail(404, "Finding not found");
    }
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    if (leaf === "analyze" && m === "POST") {
      if (intake.author_id !== ctx.userId) return fail(403, "Only the intake's author can re-run its analysis");
      syncQuestions(db, intake);
      return json(200, summary(db, intake, ctx.userId));
    }
    if (leaf === "repin" && m === "POST") {
      if (intake.author_id !== ctx.userId) return fail(403, "Only the intake's author can repin it");
      intake.source_snapshot_ids = [...intake.source_snapshot_ids, uuid()];
      return json(200, summary(db, intake, ctx.userId));
    }
    if (leaf === "question-batches" && m === "POST") {
      if (intake.author_id !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "Only the intake's author or an approver asks the next batch");
      const asked = askBatch(db, intake, ctx.userId, Number(q.get("size") ?? 5));
      if (!asked.length) return fail(409, "No questions left to ask");
      return json(200, batchView(db, intake, asked[0].batch ?? null));
    }
    if (leaf === "runs" && m === "POST") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      const input = (await body<Schemas["IntakeRunIn"]>()) ?? {};
      const document = input.document ?? intake.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const resp = await ctx.createRun({ flow: "baseline_to_prd", document, knobs: input.knobs ?? { depth: "standard", roles: {}, checkpoints: {} } });
      if (resp.ok) intake.status = "converted";
      return resp;
    }
    return null;
  }

  if (p[1] === "intake-proposals" && p[2] && p.length === 4 && m === "POST") {
    if (!atLeast(ctx.role, "approver")) return forbidden("approver");
    const proposal = (db.intake_proposals ?? []).find((x) => x.id === p[2]);
    if (!proposal) return fail(404, "Proposal not found");
    if (proposal.status !== "proposed") return fail(409, `This proposal is already ${proposal.status}`);
    if (p[3] === "accept") {
      if (proposal.kind === "research_run") {
        const resp = await ctx.createRun({ flow: "baseline_to_prd", document: "research", knobs: { depth: "quick", roles: {}, checkpoints: {} } });
        if (!resp.ok) return resp;
        proposal.result = { run_id: ((await resp.json()) as { id: string }).id };
      } else {
        proposal.result = { feedback_item_id: uuid() };
      }
      Object.assign(proposal, { status: "accepted", decided_by: ctx.userId, decided_at: now(), updated_at: now() });
      return json(200, proposal);
    }
    if (p[3] === "dismiss") {
      const input = await body<Schemas["DismissIn"] | null>();
      Object.assign(proposal, { status: "dismissed", decided_by: ctx.userId, decided_at: now(), decision_note: input?.reason ?? null, updated_at: now() });
      return json(200, proposal);
    }
    return null;
  }

  if (p[1] === "gaps" && m !== "GET") {
    if (p.length === 2 && m === "POST") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      const input = await body<Schemas["GapCreate"]>();
      const intake = findIntake(input.intake_id);
      if (!intake) return fail(404, "Intake not found");
      const cat = CATEGORIES.find((c) => c[0] === input.category);
      const gap: Gap = {
        id: uuid(), intake_id: intake.id, document_id: intake.document_id, category: input.category, statement: input.statement,
        impact: cat?.[3] ?? [], importance: input.importance, evidence_ids: [], confidence: null, knowledge_state: "unknown",
        status: "unknown", owner_id: input.owner_id ?? null, related_modules: cat?.[5] ?? [], stop_condition: null,
        entity_ids: [], section_keys: input.section_keys ?? [], created_by: ctx.userId, lock_version: 1, created_at: now(), updated_at: now(),
      };
      db.gaps.push(gap);
      syncQuestions(db, intake);
      return json(201, gap);
    }
    const gap = db.gaps.find((g) => g.id === p[2]);
    if (p.length === 3 && m === "PATCH") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      if (!gap) return fail(404, "Gap not found");
      const patch = await body<Schemas["GapPatch"]>();
      if (patch.lock_version !== gap.lock_version) return fail(409, "Someone else changed this since you loaded it; reload and try again");
      if (gap.importance === "critical" && patch.importance && patch.importance !== "critical" && !atLeast(ctx.role, "owner")) {
        return fail(403, "Lowering a critical gap's importance needs an owner");
      }
      if (patch.importance) gap.importance = patch.importance;
      if (patch.status) gap.status = patch.status;
      if (patch.owner_id) gap.owner_id = patch.owner_id;
      gap.lock_version += 1;
      return json(200, gap);
    }
    if (p[3] === "decisions" && m === "POST") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      if (!gap) return fail(404, "Gap not found");
      const input = await body<Schemas["DecisionIn"]>();
      if (!input.rationale?.trim()) return fail(422, "A decision needs a rationale");
      if (gap.importance === "critical" && (input.decision === "accept_risk" || input.decision === "accept_assumption") && !atLeast(ctx.role, "owner")) {
        return fail(403, "Accepting a critical gap's risk or assumption needs an owner");
      }
      const answered = gap.status === "answered" || gap.status === "answered_pending_review";
      if (gap.importance === "critical" && input.decision === "validate" && (HARD.has(gap.category) || !answered) && !atLeast(ctx.role, "owner")) {
        return fail(403, "Validating an unanswered critical gap or a critical blocker needs an owner");
      }
      gap.status = { accept_risk: "accepted_risk", accept_assumption: "accepted_risk", validate: "validated", reject: "unknown" }[input.decision] as Gap["status"];
      gap.lock_version += 1;
      const decision: Schemas["AssumptionDecisionOut"] = {
        id: uuid(), gap_id: gap.id, document_id: gap.document_id, entity_id: null, statement: gap.statement, decision: input.decision,
        rationale: input.rationale, decided_by: ctx.userId, decided_at: now(), review_at: input.review_at ?? null, created_at: now(),
      };
      db.assumption_decisions.push(decision);
      return json(201, { decision, gap });
    }
    if (p[3] === "research" && m === "POST") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      if (!gap) return fail(404, "Gap not found");
      const intake = gap.intake_id ? findIntake(gap.intake_id) : undefined;
      if (!intake) return fail(409, "Only an intake's gap can be researched");
      return json(201, proposeResearch(db, intake, gap, ctx.userId, null, true));
    }
    return null;
  }

  if (p[1] === "questions" && p[2] && p[3] === "answers" && m === "POST") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const question = db.questions.find((x) => x.id === p[2]);
    if (!question) return fail(404, "Question not found");
    const input = await body<Schemas["AnswerIn"]>();
    if (question.status === "answered") return fail(409, "This question is answered; it is not asked again");
    if (question.asked_to && question.asked_to !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "This question was asked of someone else");
    if (input.kind === "answer" && !input.body?.trim()) return fail(422, "An answer needs a body");
    if (input.kind === "delegate" && !input.delegated_to) return fail(422, "Delegate to a person of this company who can answer");
    const answer: Schemas["StakeholderAnswerOut"] = {
      id: uuid(), question_id: question.id, kind: input.kind, body: input.body ?? null, answered_by: ctx.userId,
      delegated_to: input.kind === "delegate" ? input.delegated_to ?? null : null, evidence_ids: input.evidence_ids ?? [],
      knowledge_state: input.kind === "answer" ? input.knowledge_state ?? "user_decision" : "unknown", created_at: now(),
    };
    db.answers.push(answer);
    const effects: Record<Schemas["AnswerIn"]["kind"], [Question["status"], Gap["status"] | null]> = {
      answer: ["answered", "answered"], dont_know: ["answered", "unknown"], defer: ["deferred", "deferred"],
      delegate: ["delegated", null], research: ["researching", "under_investigation"],
    };
    const [qs, effect] = effects[input.kind];
    question.status = qs;
    if (input.kind === "delegate") question.asked_to = input.delegated_to ?? null;
    const gap = db.gaps.find((g) => g.id === question.gap_id) ?? null;
    const proposals: Proposal[] = [];
    const gs = gap && effect === "answered" && gap.importance === "critical" && !atLeast(ctx.role, "owner") ? "answered_pending_review" : effect;
    if (gap && !FROZEN.has(gap.status)) {
      if (gs) gap.status = gs;
      if (input.kind === "answer") gap.knowledge_state = answer.knowledge_state;
      if (input.kind === "dont_know") gap.knowledge_state = "unknown";
      if (input.kind === "delegate") gap.owner_id = input.delegated_to ?? null;
      gap.lock_version += 1;
      const intake = gap.intake_id ? findIntake(gap.intake_id) : undefined;
      if (intake && (input.kind === "research" || (input.kind === "dont_know" && gap.importance === "critical"))) {
        proposals.push(proposeResearch(db, intake, gap, ctx.userId, question.id, input.kind === "research"));
      }
      if (intake) syncQuestions(db, intake);
    }
    return json(201, {
      answer, question, gap, proposals, baseline_proposal_ids: [], change_event_id: null,
      next_actions: gap ? nextActions(gap) : [],
    } satisfies Schemas["AnswerResult"]);
  }
  return null;
}
