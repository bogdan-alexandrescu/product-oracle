import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDateTime, formatDay } from "@/lib/format";

export type Summary = Schemas["IntakeSummary"];
export type Batch = Schemas["QuestionBatch"];
export type Card = Schemas["QuestionCard"];
export type Gap = Schemas["KnowledgeGapOut"];
export type Answer = Schemas["StakeholderAnswerOut"];
export type Category = Gap["category"];

/** The seventeen question categories (build prompt §5), as Oracle names them. */
export const CATEGORY_LABEL: Record<Category, string> = {
  customer_user: "Customer and user",
  pain_evidence: "Pain evidence",
  goal_alignment: "Company-goal alignment",
  success_metric: "Success metric and baseline",
  differentiation: "Strategic differentiation",
  alternatives: "Alternatives",
  constraints: "Current and future constraints",
  blockers: "Blockers",
  economic_benefit: "Expected economic benefit",
  effort_cost: "Effort and cost",
  security_privacy: "Security and privacy",
  ownership: "Team ownership",
  non_goals: "Non-goals",
  release_rollout: "Release and rollout",
  evaluation_criteria: "Evaluation criteria",
  third_party_policy: "Third-party policy and API limits",
  configurability_scaling: "Configurability and scaling",
};

/**
 * The category under a gap's statement, or null when the statement already starts with it
 * ("Security and privacy: not known yet." needs no "Security and privacy" below: qa-docs-65).
 */
export function categoryNote(gap: Pick<Gap, "category" | "statement">): string | null {
  const label = CATEGORY_LABEL[gap.category];
  return gap.statement.trim().toLowerCase().startsWith(label.toLowerCase()) ? null : label;
}

/** A critical gap in these categories is a hard blocker: an owner reviews it (B4). */
export const HARD_BLOCKERS = new Set<Category>(["blockers", "third_party_policy"]);

/** Gap statuses still waiting on an answer. */
export const OPEN_GAP = new Set<Gap["status"]>(["unknown", "asked", "under_investigation"]);

/** Gap statuses that settle a critical question (the API's engine.DECIDED). */
export const DECIDED_GAP = new Set<Gap["status"]>(["answered", "validated", "accepted_risk"]);

/** The intake's status, in the header's words. */
export const STATUS: Record<Summary["intake"]["status"], { label: string; kind: ChipKind }> = {
  draft: { label: "Oracle is reading", kind: "na" },
  analyzing: { label: "Oracle is reading", kind: "na" },
  awaiting_answers: { label: "Waiting for answers", kind: "warn" },
  ready: { label: "Ready to draft", kind: "pass" },
  converted: { label: "Drafting", kind: "acc" },
  archived: { label: "Archived", kind: "na" },
};

/** An answer's knowledge state in plain words (§5 step 3: an inference is never shown as a fact). */
export function knowledgeLabel(a: Answer, mine: boolean, name: string): string {
  if (a.kind !== "answer") return "Unknown";
  if (a.knowledge_state === "user_decision") return mine ? "Your decision" : `${name}'s decision`;
  if (a.knowledge_state === "verified_fact") return "Verified fact";
  if (a.knowledge_state === "hypothesis") return "Hypothesis";
  if (a.knowledge_state === "ai_inference") return "Oracle's inference";
  return "Unknown";
}

/** What a non-answer says in place of a body. */
export const NON_ANSWER: Record<Exclude<Answer["kind"], "answer">, string> = {
  dont_know: "I don't know",
  defer: "Deferred",
  delegate: "Asked someone else",
  research: "Research this",
};

/** "Oct 20", as every other page writes a day (qa-docs-65: the format module). */
export const dayMonth = formatDay;

/** "Oct 20, 11:00 AM PDT". */
export const when = formatDateTime;

/** "1 critical question" / "2 critical questions". */
export function criticalCount(n: number): string {
  return `${n} critical question${n === 1 ? "" : "s"}`;
}

/** Why Draft with Oracle waits (C5 "Draft gate", decided 2026-10-21). */
export function gateReason(n: number): string {
  return `${criticalCount(n)} open: answer ${n === 1 ? "it" : "them"} or record a decision`;
}
