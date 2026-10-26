/**
 * Mock of the intake routes (api/oracle/intake/router.py) for NEXT_PUBLIC_API_MOCKS=1:
 * New product idea, the Opportunity and Gaps summary, question batches, answers,
 * decisions and proposals. It works on the v2 mock tables (./v2.ts) and keeps the API's
 * shapes and role rules; its analysis is a fixed, simplified stand-in for the engine
 * (one gap per category, ranked by importance and impact). It has no source items: S6
 * findings are only those a scenario seeds (V2Db.intake_findings); GET .../findings shows
 * them as the API does, and only the author sets a level (#343); a scenario may mark gaps private (V2Db.private_gap_ids), and their questions are then asked
 * of, reassigned or delegated to the intake's author only, as in the API.
 * B4 (owners clear critical gaps) and the author-only repin and re-analysis hold here too.
 * C2 Questions to people: every asked question has a person (the intake's author unless
 * someone is named), POST /v1/questions asks a teammate, PATCH /v1/questions/{id}
 * reassigns or withdraws, GET /v1/inbox/questions is what is asked of me, and GET
 * /v1/people is the member directory, with the API's rules.
 * C5 Pre-draft questions: GET .../next-batch previews the next batch exactly as asking it
 * would ask it; the draft gate answers POST .../runs with 409 and the blocking gaps while a
 * critical blocker is open; a draft run keeps the answers that existed when it was made
 * (answers_since_run counts the later ones); an intake question's Inbox row opens
 * /intakes/<id>. seedBeforeDrafting adds the "before-drafting" scenario's brief.
 * Synthetic placeholders only.
 */
import type { Schemas } from "@/lib/api/client";
import { applyNudge, nudgeReason, type Nudge, type Nudges } from "./learned";
import { displayName } from "@/lib/names";
import { baselineReviewStatus } from "./baseline";
import type { V2Db } from "./v2";

type Role = "viewer" | "commenter" | "approver" | "owner";
type Gap = Schemas["KnowledgeGapOut"];
type Question = Schemas["StakeholderQuestionOut"];
/** C4: an intake row with the brief's fields (goals, out of scope, PRD template and theme, O1d answers). */
type Intake = Schemas["ProductIntakeOut"] & Partial<BriefFields>;
interface BriefFields {
  goal_ids: string[];
  out_of_scope: string[];
  template: string | null;
  theme: string | null;
  prd_answers: Schemas["PrdAnswers"] | null;
}
type IntakeCreate = Schemas["IntakeCreate"] & Partial<BriefFields>;
type IntakePatch = Schemas["IntakePatch"] & Partial<BriefFields>;
type IntakeRunIn = Partial<Schemas["IntakeRunIn"]> & { template?: string | null; theme?: string | null; reuse_baseline?: boolean | null };
type Proposal = Schemas["IntakeProposalOut"];
type Category = Gap["category"];
type Impact = Gap["impact"][number];
type Importance = Gap["importance"];

/** A member as the mock knows them (GET /v1/people, who can be asked). */
export interface MockPerson {
  id: string;
  email: string;
  /** A5: their own name, when set. */
  name?: string | null;
  role: Role;
  status?: string;
}

/** What a question's subject is, for its Inbox line and its Open link. */
export interface SubjectLookup {
  document: (id: string) => { slug: string; title: string; latest: number; heading: (key: string) => string | null } | null;
  entity: (id: string) => string | null;
  checkpoint: (id: string) => { run_id: string; kind: string } | null;
  /** A Plan item's title, by its PRD and key (F2 Ask from the Plan). */
  roadmapItem?: (documentId: string, key: string) => string | null;
}

export interface IntakeContext {
  userId: string;
  role: Role;
  /** C4: the confirmed goals' titles by id (the brief's goals must be confirmed goals). */
  confirmedGoals?: () => Map<string, string>;
  /** Creates a draft run through the runs mock (POST /v1/runs). */
  createRun: (body: Schemas["RunCreate"]) => Promise<Response>;
  /** C4: changes the intake's draft run, not started yet (PATCH /v1/runs/{id}); null when it is no longer a draft. */
  updateRun?: (id: string, body: Schemas["RunPatch"]) => Promise<Response | null>;
  /** The company's members (C2); without them nobody can be asked a teammate's question. */
  people?: MockPerson[];
  subjects?: SubjectLookup;
  /** The approved (locked) section keys of a document's latest version, by its id or slug; a
   * PRD patch on one of them is refused, as review.service.locked_section_keys does. */
  lockedSections?: (document: string) => string[];
  /** C1 lane 2, "Requests behind it": why these requests cannot be behind a brief (null when
   * they can), linking them to the new brief, and releasing them when it is archived. */
  requests?: {
    refusal: (ids: string[]) => { status: number; detail: string } | null;
    link: (intakeId: string, ids: string[]) => void;
    release: (intakeId: string) => void;
  };
  /** H11 Ask people questions: the level Oracle follows now (Recommend without it). */
  questionsLevel?: () => "observe" | "draft" | "recommend" | "act";
  /** Kept learnings about question categories: they tune the drafted questions' order. */
  learned?: () => Nudges;
  /** C5 late answers: raises a whole-draft feedback item on the document's latest version
   * (by its id or slug); null when it has none yet. */
  raiseFeedback?: (
    document: string,
    item: { summary: string; author_id: string | null; intake_question_id: string; intake_answer_id: string },
  ) => { slug: string; version: number } | null;
  /** Withdraws the late answers' feedback items of these answers, as late_answers.on_sharing
   * does when their finding goes back to private or counts: deletes the ones nobody acted on,
   * keeps the others with their quote withheld; returns the answer ids of the kept ones. */
  withdrawFeedback?: (answerIds: string[]) => string[];
}

/** H11 questions at Observe: why no batch is proposed or asked (as oracle.intake.autoask). */
export const QUESTIONS_OBSERVE = "Oracle is set to observe questions: it asks no one. An owner can change this in Settings › Autonomy.";
const questionsLevel = (ctx: IntakeContext) => ctx.questionsLevel?.() ?? "recommend";

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
/** Kept learnings about question categories, read as each request starts (./learned.ts). */
let learned: Nudges = {};
function ranked(gaps: Gap[]): Gap[] {
  return [...gaps].sort((a, b) => group(a) - group(b) || score(b) - score(a));
}
/** The nudge each gap was last ranked with, by gap id (the API's analysis["learned"]): a gap
 * whose question was asked keeps its own, so asked questions are never re-ranked. */
const synced = new Map<string, Nudge | undefined>();
/** A drafted question's why, and the learning that moved it ("Recommended because ..."). */
function rationaleOf(g: Gap): string {
  const n = synced.get(g.id);
  return `${LABEL[g.category]} gap, ${g.importance}.${n ? ` ${nudgeReason(n)}` : ""}`;
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

function intakeOut(i: Intake, db?: V2Db): Schemas["IntakeOut"] {
  const ids = (i.analysis as { source_ids?: string[] }).source_ids;
  const run = db?.intake_runs?.[i.id];
  return {
    ...i,
    source_ids: Array.isArray(ids) ? ids : [],
    goal_ids: i.goal_ids ?? [],
    out_of_scope: i.out_of_scope ?? [],
    template: i.template ?? null,
    theme: i.theme ?? null,
    prd_answers: i.prd_answers ?? null,
    run_ids: run ? [run.run_id] : [],
  } as Schemas["IntakeOut"];
}

/**
 * C4: the brief's goals and out-of-scope lines answer their questions as the author's
 * decision (kind answer, user_decision), as the API's apply_brief_fields does; B4 holds (a
 * non-owner's answer leaves the critical goal gap waiting for review). Asked again on PATCH:
 * a new answer, the latest wins.
 */
function applyBriefFields(db: V2Db, ctx: IntakeContext, intake: Intake, at = now()) {
  const goals = ctx.confirmedGoals?.() ?? new Map<string, string>();
  const lines: [Category, string | null, string[]][] = [
    ["goal_alignment", intake.goal_ids?.length ? `Serves: ${intake.goal_ids.map((id) => goals.get(id) ?? id).join("; ")}` : null, intake.goal_ids ?? []],
    ["non_goals", intake.out_of_scope?.length ? `Out of scope: ${intake.out_of_scope.join("; ")}` : null, []],
  ];
  for (const [category, body, entityIds] of lines) {
    if (!body) continue;
    const gap = db.gaps.find((g) => g.intake_id === intake.id && g.category === category);
    if (!gap || FROZEN.has(gap.status)) continue;
    let question = db.questions.find((q) => q.gap_id === gap.id && q.status !== "withdrawn");
    if (!question) {
      question = {
        id: uuid(), gap_id: gap.id, intake_id: intake.id, document_id: intake.document_id, category, prompt: CATEGORIES.find((c) => c[0] === category)?.[4] ?? gap.statement,
        rationale: `${LABEL[category]} gap, ${gap.importance}.`, priority: 0, batch: null, asked_to: intake.author_id, asked_by: null,
        module_key: gap.related_modules[0] ?? null, section_key: null, status: "draft", created_at: at, updated_at: at,
      };
      db.questions.push(question);
    }
    question.status = "answered";
    question.asked_to ??= intake.author_id;
    question.updated_at = at;
    db.answers.push({
      id: uuid(), question_id: question.id, kind: "answer", body, answered_by: ctx.userId, delegated_to: null, evidence_ids: [],
      knowledge_state: "user_decision", created_at: at,
    });
    gap.status = gap.importance === "critical" && !atLeast(ctx.role, "owner") ? "answered_pending_review" : "answered";
    gap.knowledge_state = "user_decision";
    if (entityIds.length) gap.entity_ids = [...entityIds];
    gap.lock_version += 1;
    gap.updated_at = at;
  }
  syncQuestions(db, intake, at);
}

/** C4: the brief's fields as given (422 for a goal that is not a confirmed goal, or too many lines). */
function briefFields(ctx: IntakeContext, input: Partial<BriefFields>): Partial<BriefFields> | string {
  const out: Partial<BriefFields> = {};
  if (input.goal_ids != null) {
    const goals = ctx.confirmedGoals?.() ?? new Map<string, string>();
    const ids = [...new Set(input.goal_ids)];
    if (ids.length > 10) return "At most 10 goals";
    const unknown = ids.find((id) => !goals.has(id));
    if (unknown) return `Goal ${unknown} is not a confirmed goal`;
    out.goal_ids = ids;
  }
  if (input.out_of_scope != null) {
    const lines = input.out_of_scope.map((l) => l.trim());
    if (lines.length > 20 || lines.some((l) => !l || l.length > 300)) return "Up to 20 out-of-scope lines of 1 to 300 characters";
    out.out_of_scope = lines;
  }
  if (input.template !== undefined) out.template = input.template;
  if (input.theme !== undefined) out.theme = input.theme;
  if (input.prd_answers !== undefined) out.prd_answers = input.prd_answers;
  return out;
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
    intake: intakeOut(intake, db),
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
    ...drafting(db, intake),
  };
}

/** The intake's draft run, and the answers given after it (C5). */
function drafting(
  db: V2Db,
  intake: Intake,
): Pick<Schemas["IntakeSummary"], "draft_run_id" | "answers_since_run" | "late_answers_as_feedback" | "draft_document" | "draft_version"> {
  const run = db.intake_runs?.[intake.id];
  if (!run) return { draft_run_id: null, answers_since_run: 0, late_answers_as_feedback: 0, draft_document: null, draft_version: null };
  const mine = new Set(db.questions.filter((q) => q.intake_id === intake.id).map((q) => q.id));
  const since = db.answers.filter((a) => mine.has(a.question_id) && !run.answer_ids.includes(a.id)).length;
  const raised = Object.values(db.late_answer_feedback ?? {}).filter((r) => r.intake_id === intake.id && !r.withheld);
  const last = raised.at(-1);
  return {
    draft_run_id: run.run_id,
    answers_since_run: intake.status === "converted" ? since : 0,
    late_answers_as_feedback: raised.length,
    draft_document: last?.slug ?? run.document ?? null,
    draft_version: last?.version ?? null,
  };
}

/** The prefix of a late answer's feedback item, as late_answers.LEAD. */
export const LATE_ANSWER_LEAD = "Answered after drafting started";
/** A kept item's summary while its finding is not shared in full, as late_answers.WITHHELD. */
export const LATE_ANSWER_WITHHELD = `${LATE_ANSWER_LEAD} (withheld while its finding is not shared in full)`;

/**
 * C5 late answers, as late_answers.on_answer: an answer with a body given after the intake's
 * draft run started becomes one whole-draft feedback item on its PRD, linked to its question.
 */
function raiseLateAnswer(db: V2Db, ctx: IntakeContext, question: Question, answer: Schemas["StakeholderAnswerOut"]) {
  const intake = question.intake_id ? db.intakes.find((i) => i.id === question.intake_id) : undefined;
  const run = intake ? db.intake_runs?.[intake.id] : undefined;
  if (!intake || !run || intake.status !== "converted" || run.answer_ids.includes(answer.id)) return;
  if (answer.kind !== "answer" || !answer.body || !ctx.raiseFeedback) return;
  const gap = db.gaps.find((g) => g.id === question.gap_id);
  const before = db.late_answer_feedback?.[answer.id];
  if ((gap && !quotable(db, gap)) || (before && !before.withheld)) return;
  const document = intake.document_id ?? run.document;
  if (!document) return;
  const at = ctx.raiseFeedback(document, {
    summary: `${LATE_ANSWER_LEAD}: ${question.prompt} ${answer.body}`.slice(0, 4000),
    author_id: answer.answered_by ?? null,
    intake_question_id: question.id,
    intake_answer_id: answer.id,
  });
  // A kept item reads in full again (raiseFeedback restores its summary).
  if (at) db.late_answer_feedback = { ...db.late_answer_feedback, [answer.id]: { intake_id: intake.id, ...(before ?? at), withheld: false } };
}

/**
 * Whether others read the gap's answers in full (S6, as answers.proposal_mode "full"): not a
 * private gap, and not a finding of the author's that is private or shared at counts only.
 */
function quotable(db: V2Db, gap: Gap): boolean {
  if (privateGap(db, gap)) return false;
  const finding = Object.values(db.intake_findings ?? {}).flat().find((f) => f.gap_id === gap.id);
  return !finding || finding.sharing === "summary" || finding.sharing === "full";
}

/** A finding's level changed: its late answers' feedback items follow it (late_answers.on_sharing). */
function lateAnswersOnSharing(db: V2Db, ctx: IntakeContext, gapId: string) {
  const gap = db.gaps.find((g) => g.id === gapId);
  if (!gap) return;
  const questions = db.questions.filter((q) => q.gap_id === gap.id);
  const answers = db.answers.filter((a) => questions.some((q) => q.id === a.question_id));
  if (!quotable(db, gap)) {
    const ids = answers.map((a) => a.id).filter((id) => db.late_answer_feedback?.[id]);
    const kept = ctx.withdrawFeedback?.(ids) ?? [];
    for (const id of ids) {
      if (kept.includes(id)) db.late_answer_feedback![id] = { ...db.late_answer_feedback![id], withheld: true };
      else delete db.late_answer_feedback![id];
    }
    return;
  }
  for (const a of answers) raiseLateAnswer(db, ctx, questions.find((q) => q.id === a.question_id)!, a);
}

/** The draft gate (C5): the critical blockers neither answered nor decided. */
function blockingGapIds(db: V2Db, intake: Intake): string[] {
  return summary(db, intake, intake.author_id ?? "").readiness.blocking_gap_ids;
}

function batchView(db: V2Db, intake: Intake, n: number | null): Schemas["QuestionBatch"] {
  const questions = db.questions.filter((q) => q.intake_id === intake.id);
  const batch = n ?? (Math.max(0, ...questions.map((q) => q.batch ?? 0)) || null);
  return {
    intake_id: intake.id,
    batch,
    questions: cards(
      db,
      questions.filter((q) => batch != null && q.batch === batch).sort((a, b) => a.priority - b.priority),
    ),
    remaining: questions.filter((q) => q.status === "draft").length,
  };
}

/** A new brief: one gap per category, its questions drafted in rank order. */
function addIntake(db: V2Db, authorId: string, title: string, brief: string, sourceIds: string[], at = now(), id = uuid()): Intake {
  const scope = brief.split(/(?<=[.!?])\s+/)[1]?.replace(/\.$/, "") ?? title;
  const analysis = {
    users: [], problem: null, outcomes: [], goal_ids: [], scope: [scope], non_goals: [], dependencies: [],
    blockers: [], category: "feature", conflicts: [], source_ids: sourceIds, signals: {},
  };
  const intake: Intake = {
    id, title, brief: brief.trim(), author_id: authorId, source_snapshot_ids: [uuid()],
    status: "awaiting_answers", document_id: null, lock_version: 1, created_at: at, updated_at: at, analysis,
  };
  db.intakes.push(intake);
  for (const [key, , importance, impact, , modules] of CATEGORIES) {
    db.gaps.push({
      id: uuid(), intake_id: intake.id, document_id: null, category: key, statement: `${LABEL[key]}: not known yet.`,
      impact, importance, evidence_ids: [], confidence: null, knowledge_state: "unknown", status: "unknown",
      owner_id: null, related_modules: modules, stop_condition: null, entity_ids: [], section_keys: [],
      created_by: null, lock_version: 1, created_at: at, updated_at: at,
    });
  }
  syncQuestions(db, intake, at);
  return intake;
}

/** Keep one question per open gap, drafted in rank order. */
function syncQuestions(db: V2Db, intake: Intake, at = now()) {
  const gaps = db.gaps.filter((g) => g.intake_id === intake.id);
  const asked = (g: Gap) => db.questions.some((q) => q.gap_id === g.id && q.status !== "draft" && q.status !== "withdrawn");
  for (const g of gaps) if (!asked(g)) synced.set(g.id, learned[g.category]);
  const tuned = (g: Gap) => applyNudge(score(g), synced.get(g.id));
  [...gaps].sort((a, b) => group(a) - group(b) || tuned(b) - tuned(a)).forEach((g, i) => {
    const mine = db.questions.filter((q) => q.gap_id === g.id && q.status !== "withdrawn");
    if (!OPEN.has(g.status)) {
      mine.filter((q) => q.status === "draft").forEach((q) => (q.status = "withdrawn"));
      return;
    }
    mine.filter((q) => q.status === "draft").forEach((q) => Object.assign(q, { priority: (i + 1) * 10, rationale: rationaleOf(g) }));
    if (mine.length || g.status !== "unknown") return;
    const prompt = CATEGORIES.find((c) => c[0] === g.category)?.[4] ?? g.statement;
    db.questions.push({
      id: uuid(), gap_id: g.id, intake_id: intake.id, document_id: intake.document_id, category: g.category,
      prompt, rationale: rationaleOf(g), priority: (i + 1) * 10, batch: null,
      asked_to: g.owner_id, asked_by: null, module_key: g.related_modules[0] ?? null, section_key: g.section_keys[0] ?? null,
      status: "draft", created_at: at, updated_at: at,
    });
  });
}

/** Archived: the brief's open questions are retired (#307). Restored: asked again, a delegated one of its delegate. */
function retireQuestions(db: V2Db, intake: Intake) {
  const archived = intake.status === "archived";
  for (const q of db.questions.filter((x) => x.intake_id === intake.id)) {
    if (archived && (q.status === "asked" || q.status === "delegated")) q.status = "retired";
    else if (!archived && q.status === "retired") {
      q.status = db.answers.some((a) => a.question_id === q.id && a.kind === "delegate") ? "delegated" : "asked";
    }
  }
}

/** Every asked question has a person (C2): `assign`, else the gap's owner, else the intake's author. */
/**
 * Ask the next batch. Each question goes to someone who can answer it, as in the API: its own
 * person, else its gap's owner, else the intake's author, else the asker, else the first
 * approver; a private finding's question goes to the author.
 */
function askBatch(db: V2Db, ctx: IntakeContext, intake: Intake, size: number, assign: Record<string, string> = {}): Question[] {
  const questions = db.questions.filter((q) => q.intake_id === intake.id);
  for (const q of questions) if (q.status === "draft" && assign[q.id]) q.asked_to = assign[q.id];
  const drafts = chooseDrafts(questions, size);
  const n = Math.max(0, ...questions.map((q) => q.batch ?? 0)) + 1;
  // At Draft (H11 questions) the person the preview named, never the sender (as the API).
  const asker = questionsLevel(ctx) !== "draft";
  for (const q of drafts) {
    const g = db.gaps.find((x) => x.id === q.gap_id);
    Object.assign(q, { status: "asked", batch: n, asked_by: ctx.userId, asked_to: personFor(db, ctx, intake, q, asker), updated_at: now() });
    if (g && g.status === "unknown") g.status = "asked";
  }
  return drafts;
}

/** The next batch's drafts, in the order they are asked (preview and ask share it, C5). */
function chooseDrafts(questions: Question[], size: number): Question[] {
  return questions.filter((q) => q.status === "draft").sort((a, b) => a.priority - b.priority).slice(0, size);
}

/** Who a question is asked of: its own person, else its gap's owner, else the intake's author,
 * else the asker, else the first approver; a private finding's question, the author. */
function personFor(db: V2Db, ctx: IntakeContext, intake: Intake, q: Question, asker = true): string | null {
  const g = db.gaps.find((x) => x.id === q.gap_id);
  if (privateGap(db, g)) return intake.author_id ?? null;
  // Without a member list, the mock cannot tell who can answer: anyone named may be asked.
  const able = (id: string | null | undefined): id is string => !!id && (!ctx.people || canAnswer(ctx, id));
  const approver = (ctx.people ?? []).find((x) => x.status !== "disabled" && atLeast(x.role, "approver"))?.id;
  return [q.asked_to, g?.owner_id, intake.author_id, asker ? ctx.userId : null].find(able) ?? approver ?? intake.author_id ?? null;
}

/** A batch's cards (GET .../question-batch, .../next-batch). */
function cards(db: V2Db, questions: Question[]): Schemas["QuestionCard"][] {
  return questions.map((q) => ({
    question: q,
    gap: db.gaps.find((g) => g.id === q.gap_id) ?? null,
    evidence: [],
    answer_paths: PATHS,
    answers: db.answers.filter((a) => a.question_id === q.id),
  }));
}

const SEES: Schemas["FindingOut"]["sharing"][] = ["private", "counts", "summary", "full"];

/** An intake's findings as `userId` sees them (S6): the author every one; anyone else those
 * shared at counts or above, the summary from the summary level, the sources in full. */
function findingsFor(db: V2Db, intake: Intake, userId: string): Schemas["FindingOut"][] {
  const all = db.intake_findings?.[intake.id] ?? [];
  if (intake.author_id === userId) return all;
  return all
    .filter((f) => f.sharing !== "private")
    .map((f) => {
      const at = SEES.indexOf(f.sharing);
      return {
        ...f,
        draft_summary: null,
        unshared_item_ids: [],
        summary: at >= 2 ? f.summary : null,
        gap_id: at >= 2 ? f.gap_id : null,
        source_item_ids: at >= 3 ? f.source_item_ids : [],
      };
    });
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
  learned = ctx.learned?.() ?? {};

  if (p[1] === "intakes" && p.length === 2 && m === "POST") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const input = await body<IntakeCreate>();
    if (!input?.title || !input.brief || input.brief.trim().length < 20 || input.brief.length > 4000) return fail(422, "a brief needs at least a sentence");
    const fields = briefFields(ctx, input);
    if (typeof fields === "string") return fail(422, fields);
    const raw = input.request_ids ?? [];
    // IntakeCreate.request_ids has max_length=50: FastAPI's own validation error.
    if (raw.length > 50) {
      const msg = `List should have at most 50 items after validation, not ${raw.length}`;
      return json(422, { detail: [{ type: "too_long", loc: ["body", "request_ids"], msg, input: raw }] });
    }
    const requestIds = [...new Set(raw)];
    const refused = requestIds.length ? ctx.requests?.refusal(requestIds) : null;
    if (refused) return fail(refused.status, refused.detail);
    const intake = addIntake(db, ctx.userId, input.title, input.brief, input.source_ids ?? []);
    Object.assign(intake, fields);
    if (requestIds.length) ctx.requests?.link(intake.id, requestIds);
    applyBriefFields(db, ctx, intake);
    // At Observe and Draft a new brief asks no one; a person sends (H11 questions).
    if (questionsLevel(ctx) === "recommend" || questionsLevel(ctx) === "act") askBatch(db, ctx, intake, input.batch_size ?? 5);
    return json(201, summary(db, intake, ctx.userId));
  }

  if (p[1] === "intakes" && p[2] && p.length >= 3 && !(p.length === 3 && m === "GET")) {
    const intake = findIntake(p[2]);
    if (!intake) return fail(404, "Intake not found");
    const leaf = p[3];
    if (p.length === 3 && m === "PATCH") {
      if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
      if (intake.author_id !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "Only the intake's author or an approver can do this");
      const patch = await body<IntakePatch>();
      if (patch.lock_version !== intake.lock_version) return fail(409, "Someone else changed this since you loaded it; reload and try again");
      const fields = briefFields(ctx, patch);
      if (typeof fields === "string") return fail(422, fields);
      if (Object.keys(fields).length) {
        if (intake.status === "converted") return fail(409, "This brief is drafting; its fields no longer change");
        Object.assign(intake, fields);
        if (fields.goal_ids || fields.out_of_scope) applyBriefFields(db, ctx, intake);
      }
      if ("document" in patch && !atLeast(ctx.role, "approver")) return fail(403, "Linking an intake to a PRD needs an approver");
      if (patch.title) intake.title = patch.title;
      if (patch.status && patch.status !== intake.status) {
        intake.status = patch.status;
        retireQuestions(db, intake);
        // An archived brief that made no PRD releases the requests behind it.
        if (intake.status === "archived") ctx.requests?.release(intake.id);
      }
      intake.lock_version += 1;
      intake.updated_at = now();
      return json(200, intakeOut(intake, db));
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
    if (leaf === "next-batch" && m === "GET") {
      if (intake.author_id !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "Only the intake's author or an approver sees the next batch");
      const size = Number(q.get("size") ?? 5);
      if (!(size >= 1 && size <= 10)) return fail(422, "size is 1 to 10");
      const questions = db.questions.filter((x) => x.intake_id === intake.id);
      const remaining = questions.filter((x) => x.status === "draft").length;
      const level = questionsLevel(ctx);
      if (level === "observe") return json(200, { questions: [], remaining, held: QUESTIONS_OBSERVE } satisfies Schemas["NextBatch"]);
      // Copies: the stored question keeps its person until the batch is asked. At Draft each
      // keeps its own named person, never the reader.
      const shown = chooseDrafts(questions, size).map((x) => ({ ...x, asked_to: personFor(db, ctx, intake, x, level !== "draft") }));
      return json(200, { questions: cards(db, shown), remaining, held: null } satisfies Schemas["NextBatch"]);
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
    if (leaf === "findings" && m === "GET") return json(200, findingsFor(db, intake, ctx.userId));
    if (leaf === "findings" && (m === "PATCH" || m === "POST")) {
      if (intake.author_id !== ctx.userId) return fail(403, "Only the intake's author can share its findings");
      const all = db.intake_findings?.[intake.id] ?? [];
      const changes =
        m === "PATCH" && p.length === 5
          ? [{ finding_id: p[4], sharing: (await body<Schemas["SharingIn"]>()).sharing }]
          : m === "POST" && p[4] === "sharing"
            ? (await body<Schemas["SharingBulkIn"]>()).changes
            : null;
      if (!changes) return null;
      const missing = changes.find((c) => !all.some((f) => f.id === c.finding_id));
      if (missing) return fail(404, `Finding ${missing.finding_id} not found`);
      for (const c of changes) {
        const finding = all.find((f) => f.id === c.finding_id)!;
        const before = finding.sharing;
        finding.sharing = c.sharing;
        if (finding.gap_id && before !== c.sharing) lateAnswersOnSharing(db, ctx, finding.gap_id);
      }
      const set = new Set(changes.map((c) => c.finding_id));
      const out = findingsFor(db, intake, ctx.userId).filter((f) => set.has(f.id));
      return json(200, m === "PATCH" ? out[0] : out);
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
      if (questionsLevel(ctx) === "observe") return fail(409, QUESTIONS_OBSERVE);
      const input = await body<Schemas["QuestionBatchAsk"] | null>();
      const assign = input?.assign ?? {};
      for (const [qid, person] of Object.entries(assign)) {
        const draft = db.questions.find((x) => x.id === qid && x.intake_id === intake.id && x.status === "draft");
        if (!draft) return fail(422, `Question ${qid} is not waiting to be asked here`);
        if (!canAnswer(ctx, person)) return fail(422, CANNOT_ANSWER);
        if (privateGap(db, db.gaps.find((g) => g.id === draft.gap_id)) && person !== intake.author_id) return fail(409, PRIVATE);
      }
      const asked = askBatch(db, ctx, intake, Number(input?.size ?? q.get("size") ?? 5), assign);
      if (!asked.length) return fail(409, "No questions left to ask");
      return json(200, batchView(db, intake, asked[0].batch ?? null));
    }
    if (leaf === "questions" && p[4] === "withdraw" && m === "POST") {
      // The Undo of a batch Oracle asked on its own: still-waiting questions are withdrawn.
      if (intake.author_id !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "Only the intake's author or an approver withdraws these questions");
      const ids = new Set((await body<Schemas["QuestionsWithdraw"]>())?.question_ids ?? []);
      if (!ids.size) return fail(422, "Name at least one question");
      const done = db.questions.filter((x) => x.intake_id === intake.id && ids.has(x.id) && (x.status === "asked" || x.status === "delegated"));
      for (const x of done) Object.assign(x, { status: "withdrawn", updated_at: now() });
      return json(200, { question_ids: done.map((x) => x.id) } satisfies Schemas["QuestionsWithdrawn"]);
    }
    if (leaf === "runs" && m === "POST") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      // Drafting waits until decided (C5): every open critical blocker is named.
      const blocking = blockingGapIds(db, intake);
      if (blocking.length) {
        const n = blocking.length;
        return json(409, { detail: `${n} critical question${n === 1 ? " is" : "s are"} open on this brief`, blocking_gap_ids: blocking } satisfies Schemas["DraftGateClosedOut"]);
      }
      const input = (await body<IntakeRunIn>()) ?? {};
      const document = input.document ?? intake.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      // C4: the intake's template and theme unless the sheet names others; reuse_baseline null
      // (or absent) reuses the baseline when it is reusable.
      const knobs = { ...(input.knobs ?? { depth: "standard", roles: {}, checkpoints: {} }) } as Schemas["KnobsIn"] & { reuse_baseline?: boolean | null };
      const wanted = input.reuse_baseline ?? knobs.reuse_baseline ?? null;
      const review = baselineReviewStatus();
      if (wanted === true && !review.reusable) return json(409, { detail: { code: "baseline_not_reusable", reason: review.reason } });
      knobs.reuse_baseline = wanted ?? review.reusable;
      // #260: the run serves the brief's goals unless the sheet names others.
      knobs.goals ??= (intake as Intake).goal_ids ?? [];
      // A goal of the brief rejected since is left out, not refused (as the API).
      const confirmed = ctx.confirmedGoals?.() ?? new Map<string, string>();
      const stale = ((intake as Intake).goal_ids ?? []).filter((g) => !confirmed.has(g));
      knobs.goals = knobs.goals.filter((g) => !stale.includes(g));
      // Reopening the sheet after an estimate (C4): the intake's one draft run takes the new
      // choices; no second run is made.
      const existing = db.intake_runs?.[intake.id];
      if (existing && ctx.updateRun) {
        const updated = await ctx.updateRun(existing.run_id, {
          knobs, template: input.template ?? (intake as Intake).template ?? null, theme: input.theme ?? (intake as Intake).theme ?? null,
        });
        if (updated) return updated.ok ? new Response(updated.body, { status: 201, headers: updated.headers }) : updated;
      }
      const resp = await ctx.createRun({
        flow: "baseline_to_prd", document, knobs, template: input.template ?? (intake as Intake).template ?? null, theme: input.theme ?? (intake as Intake).theme ?? null,
      });
      if (resp.ok) {
        // The brief stays open until its run starts (startedIntakeRun converts it, C4).
        const run = (await resp.clone().json()) as { id: string };
        db.intake_runs = { ...db.intake_runs, [intake.id]: { run_id: run.id, answer_ids: [], document: document ?? undefined } };
      }
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
        const section = typeof proposal.detail.section_key === "string" ? proposal.detail.section_key : null;
        const document = proposal.detail.document_id ?? proposal.detail.document;
        if (section && typeof document === "string" && (ctx.lockedSections?.(document) ?? []).includes(section)) {
          return fail(409, `Section '${section}' is approved and locked; its text is kept as approved`);
        }
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
      if (!input.statement || input.statement.length > 500) return fail(422, "A gap needs a statement of 1 to 500 characters");
      if ((input.section_keys ?? []).length > 20) return fail(422, "At most 20 sections");
      if (input.owner_id && !(ctx.people ?? []).some((x) => x.id === input.owner_id)) return fail(422, "Unknown owner");
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
      if (patch.owner_id && !(ctx.people ?? []).some((x) => x.id === patch.owner_id)) return fail(422, "Unknown owner");
      if ((patch.section_keys ?? []).length > 20 || (patch.stop_condition ?? "").length > 500) return fail(422, "At most 20 sections, and a stop condition of at most 500 characters");
      if (patch.importance) gap.importance = patch.importance;
      if (patch.status) gap.status = patch.status;
      if (patch.owner_id) gap.owner_id = patch.owner_id;
      if (patch.section_keys) gap.section_keys = patch.section_keys;
      if (patch.stop_condition != null) gap.stop_condition = patch.stop_condition;
      gap.lock_version += 1;
      gap.updated_at = now();
      const intake = gap.intake_id ? findIntake(gap.intake_id) : undefined;
      if (intake) syncQuestions(db, intake);
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

  if (p[1] === "people" && p.length === 2 && m === "GET") {
    const needle = (q.get("q") ?? "").trim().toLowerCase();
    const limit = Math.min(Number(q.get("limit") ?? 20), 500);
    // ids: the named people, a disabled one too (it keeps its name); q and limit do not apply.
    const ids = new Set(q.getAll("ids"));
    if (ids.size > 100) return fail(422, "At most 100 ids");
    const people: Schemas["PersonOut"][] = (ctx.people ?? [])
      .filter((x) => (ids.size ? ids.has(x.id) : x.status !== "disabled" && x.email.includes(needle)))
      .sort((a, b) => a.email.localeCompare(b.email))
      .slice(0, ids.size ? undefined : limit)
      .map((x) => ({
        user_id: x.id, name: displayName(x.email, x.name), email: x.email, role: x.role,
        can_write: x.status !== "disabled" && atLeast(x.role, "commenter"),
      }));
    return json(200, people);
  }

  if (p[1] === "inbox" && p[2] === "questions" && p.length === 3 && m === "GET") {
    return json(200, inboxQuestions(db, ctx));
  }

  if (p[1] === "questions" && p.length === 2 && m === "POST") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const input = await body<Schemas["QuestionCreate"]>();
    const prompt = input?.prompt?.trim() ?? "";
    if (!prompt || prompt.length > 1000 || (input.rationale ?? "").length > 500) return fail(422, "A question needs some words (at most 1000), and a why of at most 500");
    const columns = subjectColumns(db, ctx, input.subject);
    if (!columns) return fail(422, "No such subject");
    if (!canAnswer(ctx, input.asked_to)) return fail(422, CANNOT_ANSWER);
    const question: Question = {
      id: uuid(), gap_id: null, intake_id: null, document_id: null, checkpoint_id: null, item_ref: null, entity_id: null,
      category: "general", prompt, rationale: input.rationale?.trim() || null, priority: 100, batch: null,
      asked_to: input.asked_to, asked_by: ctx.userId, module_key: null, section_key: null, status: "asked",
      created_at: now(), updated_at: now(), ...columns,
    };
    db.questions.push(question);
    return json(201, question);
  }

  if (p[1] === "questions" && p[2] && p.length === 3 && m === "PATCH") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const question = db.questions.find((x) => x.id === p[2]);
    if (!question) return fail(404, "Question not found");
    const input = await body<Schemas["QuestionPatch"]>();
    if (!input || (input.asked_to == null) === (input.status == null)) return fail(422, "Give either asked_to (reassign) or status: withdrawn");
    const intake = question.intake_id ? findIntake(question.intake_id) : undefined;
    const allowed = question.asked_by === ctx.userId || intake?.author_id === ctx.userId || atLeast(ctx.role, "approver");
    if (!allowed) return fail(403, "Only the person who asked, the intake's author or an approver can do this");
    if (question.status === "answered" || question.status === "withdrawn" || question.status === "retired") return fail(409, `This question is ${question.status}; it stays as it is`);
    if (input.status === "withdrawn") question.status = "withdrawn";
    else {
      if (!canAnswer(ctx, input.asked_to!)) return fail(422, CANNOT_ANSWER);
      if (privateGap(db, db.gaps.find((g) => g.id === question.gap_id)) && input.asked_to !== intake?.author_id) return fail(409, PRIVATE);
      question.asked_to = input.asked_to!;
      // A deferred question reassigned is asked again, of the new person (its gap open again).
      if (question.status === "deferred") {
        question.status = "asked";
        const gap = db.gaps.find((g) => g.id === question.gap_id);
        if (gap?.status === "deferred") gap.status = "asked";
      }
    }
    question.updated_at = now();
    return json(200, question);
  }

  if (p[1] === "questions" && p[2] && p[3] === "answers" && m === "POST") {
    if (!atLeast(ctx.role, "commenter")) return forbidden("commenter");
    const question = db.questions.find((x) => x.id === p[2]);
    if (!question) return fail(404, "Question not found");
    const input = await body<Schemas["AnswerIn"]>();
    if (question.status === "answered") return fail(409, "This question is answered; it is not asked again");
    if (question.status === "withdrawn" || question.status === "retired") return fail(409, `A ${question.status} question cannot be answered`);
    if (question.asked_to && question.asked_to !== ctx.userId && !atLeast(ctx.role, "approver")) return fail(403, "This question was asked of someone else");
    if (input.kind === "answer" && !input.body?.trim()) return fail(422, "An answer needs a body");
    if (input.kind === "research" && !(question.intake_id && question.gap_id)) return fail(422, "Only a question about an intake's gap can be researched");
    if (input.kind === "delegate" && (!input.delegated_to || (ctx.people && !canAnswer(ctx, input.delegated_to)))) return fail(422, "Delegate to a person of this company who can answer");
    if (input.kind === "delegate" && privateGap(db, db.gaps.find((g) => g.id === question.gap_id))) {
      const author = question.intake_id ? findIntake(question.intake_id)?.author_id : undefined;
      if (input.delegated_to !== author) return fail(409, PRIVATE);
    }
    const answer: Schemas["StakeholderAnswerOut"] = {
      id: uuid(), question_id: question.id, kind: input.kind, body: input.body ?? null, answered_by: ctx.userId,
      delegated_to: input.kind === "delegate" ? input.delegated_to ?? null : null, evidence_ids: input.evidence_ids ?? [],
      knowledge_state: input.kind === "answer" ? input.knowledge_state ?? "user_decision" : "unknown", created_at: now(),
    };
    db.answers.push(answer);
    raiseLateAnswer(db, ctx, question, answer);
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

// --- questions to people (C2) -------------------------------------------------------------

const CANNOT_ANSWER = "Ask someone who can answer";
const PRIVATE = "Share this finding first to ask someone else";

/** A gap hidden from everyone but its intake's author (S6). */
function privateGap(db: V2Db, gap: Gap | null | undefined): boolean {
  return !!gap && (db.private_gap_ids ?? []).includes(gap.id);
}
const CHECKPOINT_LABEL: Record<string, string> = {
  baseline_confirm: "Confirm the baseline", feature_set: "Feature set and dependencies", priority_order: "Priority order",
  prd_review: "PRD review", eng_review: "Engineering review", roadmap_items: "Roadmap items", roadmap_review: "Roadmap review",
};

/** An active member who can answer: commenter or above. */
function canAnswer(ctx: IntakeContext, id: string): boolean {
  const person = (ctx.people ?? []).find((x) => x.id === id);
  return !!person && person.status !== "disabled" && atLeast(person.role, "commenter");
}

function subjectColumns(db: V2Db, ctx: IntakeContext, subject: Schemas["QuestionCreate"]["subject"]): Partial<Question> | null {
  if (subject.kind === "intake") {
    const intake = db.intakes.find((i) => i.id === subject.intake_id);
    return intake ? { intake_id: intake.id, document_id: intake.document_id } : null;
  }
  if (subject.kind === "document_section") {
    const doc = ctx.subjects?.document(subject.document_id);
    return doc && doc.heading(subject.section_key) != null ? { document_id: subject.document_id, section_key: subject.section_key } : null;
  }
  if (subject.kind === "checkpoint_item") {
    return ctx.subjects?.checkpoint(subject.checkpoint_id) ? { checkpoint_id: subject.checkpoint_id, item_ref: subject.item_ref } : null;
  }
  if (subject.kind === "roadmap_item") {
    return ctx.subjects?.roadmapItem?.(subject.document_id, subject.item_key) != null ? { document_id: subject.document_id, item_ref: subject.item_key } : null;
  }
  return ctx.subjects?.entity(subject.entity_id) != null ? { entity_id: subject.entity_id } : null;
}

function subjectOf(db: V2Db, ctx: IntakeContext, q: Question): Schemas["InboxSubject"] {
  if (q.checkpoint_id) {
    const cp = ctx.subjects?.checkpoint(q.checkpoint_id);
    return { kind: "checkpoint_item", title: `${CHECKPOINT_LABEL[cp?.kind ?? ""] ?? "Checkpoint"} · ${q.item_ref}`, href: cp ? `/runs/${cp.run_id}#decide` : null };
  }
  if (q.entity_id) return { kind: "entity", title: `Baseline · ${ctx.subjects?.entity(q.entity_id) ?? "an entity"}`, href: `/baseline?entity=${q.entity_id}` };
  const doc = q.document_id ? ctx.subjects?.document(q.document_id) : null;
  if (q.item_ref && doc) {
    const title = ctx.subjects?.roadmapItem?.(q.document_id!, q.item_ref) ?? q.item_ref;
    return { kind: "roadmap_item", title: `${doc.title} · ${title}`, href: `/plan?prd=${q.document_id}&item=${encodeURIComponent(q.item_ref)}` };
  }
  const intake = q.intake_id ? db.intakes.find((i) => i.id === q.intake_id) : undefined;
  if (intake) return { kind: "intake", title: `Before drafting · ${intake.title}`, href: `/intakes/${intake.id}` };
  if (!doc) return { kind: "document_section", title: "A document", href: null };
  const heading = q.section_key ? doc.heading(q.section_key) : null;
  return {
    kind: "document_section",
    title: heading ? `${doc.title} · ${heading}` : doc.title,
    href: `/documents/${doc.slug}/v/${doc.latest}${q.section_key ? `#${q.section_key}` : ""}`,
  };
}

/** GET /v1/inbox/questions: asked of me and still open (asked, or delegated to me), oldest first. */
function inboxQuestions(db: V2Db, ctx: IntakeContext): Schemas["InboxQuestion"][] {
  return db.questions
    .filter((q) => q.asked_to === ctx.userId && (q.status === "asked" || q.status === "delegated"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((q) => {
      const asker = (ctx.people ?? []).find((x) => x.id === q.asked_by);
      return {
        question: q,
        asked_by: q.gap_id || !q.asked_by ? { kind: "oracle" as const } : { kind: "person" as const, id: q.asked_by, name: asker ? displayName(asker.email) : "Someone" },
        subject: subjectOf(db, ctx, q),
        gap: db.gaps.find((g) => g.id === q.gap_id) ?? null,
        answer_paths: PATHS.filter((x) => x !== "research" || (q.intake_id && q.gap_id)),
      };
    });
}

// --- the "before-drafting" scenario (C5) ---------------------------------------------------

/** The brief the "before-drafting" scenario seeds: a fixed id, so a test opens its page. */
export const BEFORE_DRAFTING = { intakeId: "c5000000-0000-4000-8000-000000000001", title: "Saved shipping addresses" } as const;

/**
 * The "before-drafting" scenario's brief, by `authorId` (the signed-in owner), with two
 * batches. Batch 1 (20 Oct): Customer and user answered by the approver; Blockers, raised to
 * critical, answered by the approver and waiting for review (B4); Pain evidence asked of the
 * approver. Batch 2 (21 Oct): Success metric and Company-goal alignment asked of the author.
 * The other twelve are not asked yet.
 */
/**
 * C4: an intake's draft run started (POST /v1/runs/{id}/start), as the API's
 * drafting.on_start: the brief is converted and the run reads the answers given before now.
 */
export function startedIntakeRun(db: V2Db, runId: string) {
  const [intakeId, run] = Object.entries(db.intake_runs ?? {}).find(([, r]) => r.run_id === runId) ?? [];
  const intake = intakeId ? db.intakes.find((i) => i.id === intakeId) : undefined;
  if (!intake || !run || intake.status === "converted" || intake.status === "archived") return;
  intake.status = "converted";
  const mine = new Set(db.questions.filter((x) => x.intake_id === intake.id).map((x) => x.id));
  run.answer_ids = db.answers.filter((a) => mine.has(a.question_id)).map((a) => a.id);
}

export function seedBeforeDrafting(db: V2Db, authorId: string, approverId: string) {
  const at = "2026-10-19T09:00:00Z";
  const intake = addIntake(
    db, authorId, BEFORE_DRAFTING.title,
    "Returning buyers retype their shipping address at every checkout. Let them save addresses to check out faster.",
    [], at, BEFORE_DRAFTING.intakeId,
  );
  const gap = (category: Category) => db.gaps.find((g) => g.intake_id === intake.id && g.category === category)!;
  gap("blockers").importance = "critical";
  syncQuestions(db, intake, at);
  const question = (category: Category) => db.questions.find((x) => x.intake_id === intake.id && x.category === category)!;
  question("blockers").rationale = `${LABEL.blockers} gap, critical.`;
  const ask = (category: Category, batch: number, to: string, when: string) => {
    Object.assign(question(category), { status: "asked", batch, asked_by: authorId, asked_to: to, updated_at: when });
    gap(category).status = "asked";
  };
  const reply = (category: Category, body: string, when: string, gapStatus: Gap["status"]) => {
    const q = question(category);
    db.answers.push({
      id: uuid(), question_id: q.id, kind: "answer", body, answered_by: approverId, delegated_to: null, evidence_ids: [],
      knowledge_state: "user_decision", created_at: when,
    });
    q.status = "answered";
    Object.assign(gap(category), { status: gapStatus, knowledge_state: "user_decision" });
  };
  ask("customer_user", 1, approverId, "2026-10-20T09:00:00Z");
  ask("blockers", 1, approverId, "2026-10-20T09:00:00Z");
  ask("pain_evidence", 1, approverId, "2026-10-20T09:00:00Z");
  ask("success_metric", 2, authorId, "2026-10-21T09:00:00Z");
  ask("goal_alignment", 2, authorId, "2026-10-21T09:00:00Z");
  reply("customer_user", "Returning buyers on the web shop, signed in.", "2026-10-20T11:00:00Z", "answered");
  reply("blockers", "The address lookup API has a rate limit that could block pre-fill.", "2026-10-20T12:00:00Z", "answered_pending_review");
  // #343: PRD patches from the customer and blockers answers, and two findings from the author's own sources.
  const customer = question("customer_user");
  db.intake_proposals = [
    ...(db.intake_proposals ?? []),
    {
      id: uuid(), intake_id: intake.id, gap_id: gap("customer_user").id, question_id: customer.id,
      answer_id: db.answers.find((a) => a.question_id === customer.id)?.id ?? null, kind: "prd_patch",
      title: `Add to the PRD: ${LABEL.customer_user}`,
      detail: { document: "saved-addresses", base_version: 2, section_key: "context.users", text: `${customer.prompt} Returning buyers on the web shop, signed in.` },
      status: "proposed", result: {}, created_by: approverId, decided_by: null, decided_at: null, decision_note: null,
      created_at: "2026-10-20T11:00:00Z", updated_at: "2026-10-20T11:00:00Z",
    },
    // On usage-alerts' behaviour section, approved in v1: accepting it is refused (locked).
    {
      id: uuid(), intake_id: intake.id, gap_id: gap("blockers").id, question_id: question("blockers").id,
      answer_id: db.answers.find((a) => a.question_id === question("blockers").id)?.id ?? null, kind: "prd_patch",
      title: `Add to the PRD: ${LABEL.blockers}`,
      detail: { document: "usage-alerts", base_version: 1, section_key: "behaviour", text: "Alerts wait while the address lookup is rate limited." },
      status: "proposed", result: {}, created_by: approverId, decided_by: null, decided_at: null, decision_note: null,
      created_at: "2026-10-20T12:00:00Z", updated_at: "2026-10-20T12:00:00Z",
    },
  ];
  const finding = (kind: Schemas["FindingOut"]["kind"], category: string, sharing: Schemas["FindingOut"]["sharing"], draft: string): Schemas["FindingOut"] => ({
    id: uuid(), kind, origin: "rules", category, sharing, summary: sharing === "private" ? null : `A ${kind} about ${category.replace(/_/g, " ")}`,
    summary_confirmed: false, draft_summary: draft, gap_id: null, source_item_ids: [uuid()], unshared_item_ids: [],
  });
  db.intake_findings = {
    ...db.intake_findings,
    [intake.id]: [
      finding("gap", "pain_evidence", "private", "Support tickets mention retyping the address at every order."),
      finding("item", "constraints", "counts", "A team note limits address storage to one region."),
    ],
  };
}

// --- the "brief-goal-rejected" scenario (#260) ---------------------------------------------

/** The brief the "brief-goal-rejected" scenario seeds: a fixed id, so a test opens its page. */
export const BRIEF_GOAL_REJECTED = { intakeId: "c2600000-0000-4000-8000-000000000001", title: "Gift cards for teams" } as const;

/** A brief by `authorId` that serves `goalIds`; the scenario rejects one of them afterwards. */
export function seedBriefGoalRejected(db: V2Db, authorId: string, goalIds: string[]) {
  const intake: Intake = addIntake(
    db, authorId, BRIEF_GOAL_REJECTED.title,
    "Team buyers want to send gift cards to their staff. Let them buy several gift cards in one order.",
    [], "2026-10-19T09:00:00Z", BRIEF_GOAL_REJECTED.intakeId,
  );
  intake.goal_ids = goalIds;
}
