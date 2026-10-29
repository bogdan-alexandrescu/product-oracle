import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDateTime, formatDay, plural } from "@/lib/format";

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

/**
 * "Oct 20", as every other page writes a day (qa-docs-65: the format module; qa-work-46: one way
 * on this page); the full time ("Oct 20, 11:00 AM PDT") goes in the title where it is shown.
 */
export const dayMonth = formatDay;

/** The full time of a day shown with `dayMonth`, for its title. */
export const when = formatDateTime;

/** "1 critical question" / "2 critical questions". */
export function criticalCount(n: number): string {
  return plural(n, "critical question");
}

const WAITING = new Set<Card["question"]["status"]>(["asked", "delegated"]);

/** The answer that stands on a question: its latest. */
const lastAnswer = (c: Card) => c.answers[c.answers.length - 1];

/** The questions asked so far: still open, answered, and of those answered "I don't know" (unknown). */
export type Tally = { open: number; answered: number; unknown: number };

/**
 * qa-work-21: what the asked questions stand at, read off the thread when it is loaded: a
 * question answered "I don't know" counts as answered, as unknown, never as still open; the
 * summary's counts until the thread is read.
 */
export function tally(s: Summary, batches: Batch[] | undefined): Tally {
  if (!batches) return { open: s.batch.asked, answered: s.batch.answered, unknown: 0 };
  const cards = batches.flatMap((b) => b.questions);
  const unknown = cards.filter((c) => lastAnswer(c)?.kind === "dont_know" && (c.question.status === "answered" || WAITING.has(c.question.status)));
  const known = cards.filter((c) => c.question.status === "answered" && lastAnswer(c)?.kind !== "dont_know").length;
  const open = cards.filter((c) => WAITING.has(c.question.status) && lastAnswer(c)?.kind !== "dont_know").length;
  return { open, answered: known + unknown.length, unknown: unknown.length };
}

/** The gaps whose question was answered "I don't know", by gap id. */
export function unknownGaps(batches: Batch[] | undefined): Set<string> {
  return new Set(
    (batches ?? [])
      .flatMap((b) => b.questions)
      .filter((c) => lastAnswer(c)?.kind === "dont_know" && c.question.gap_id)
      .map((c) => c.question.gap_id!),
  );
}

/** "1 critical question holds the draft" / "2 critical questions hold the draft". */
export function holdCount(n: number): string {
  return `${criticalCount(n)} ${n === 1 ? "holds" : "hold"} the draft`;
}

/**
 * Why Draft with Oracle waits (C5 "Draft gate", decided 2026-10-21). rirs-10: the critical
 * questions open in all (the inspector's "Critical open") and, of those, the ones that hold the
 * draft, so the header and the inspector never read as two different counts.
 */
export function gateReason(blocking: number, open: number = blocking): string {
  const all = Math.max(open, blocking);
  const lead = all > blocking ? `${criticalCount(all)} open, ${blocking} ${blocking === 1 ? "holds" : "hold"} the draft` : holdCount(blocking);
  return `${lead}: answer ${blocking === 1 ? "it" : "them"} or record a decision`;
}
