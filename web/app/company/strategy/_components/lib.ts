import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import type { useMe } from "@/lib/me";

export type Stack = Schemas["StrategyStackOut"];
export type Finding = Schemas["StrategyFindingOut"];
export type Choice = Schemas["StackChoice"];
export type Belief = Schemas["StackBelief"];
export type DocKind = "vision" | "strategy";
/** A vision or strategy document, as the documents list names it. */
export type DocRef = { slug: string; title: string };
export type FindingState = Finding["status"];

export const DOC: Record<DocKind, { name: string; title: string; template: string }> = {
  vision: { name: "vision", title: "Vision", template: "vision-narrative" },
  strategy: { name: "product strategy", title: "Product strategy", template: "product-strategy" },
};

export const BELIEF: Record<Belief["status"], { label: string; kind: ChipKind }> = {
  supported: { label: "Supported", kind: "pass" },
  untested: { label: "Untested", kind: "na" },
  strained: { label: "Strained", kind: "warn" },
};

export const FINDING_LABEL: Record<Finding["kind"], string> = {
  goal_without_strategy: "Goal without a strategy",
  focus_without_goal: "Focus without a goal",
  outside_strategy: "Outside the strategy",
  stopped_but_planned: "Stopped in the strategy",
  strategy_review_due: "Strategy review due",
  vision_review_due: "Vision review due",
  no_strategy: "No approved strategy",
};

export const FINDING_STATES: { value: FindingState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "waived", label: "Waived" },
  { value: "resolved", label: "Resolved" },
];

/**
 * Whether the signed-in member may waive an open finding (#370: `can` from useMe). Below the
 * handler's role, only an item outside the strategy (as the API).
 */
export function canWaive(f: Finding, can: ReturnType<typeof useMe>["can"]): boolean {
  if (f.status !== "open") return false;
  return can("waive_strategy_finding", f.kind === "outside_strategy");
}

/** "Oct 1, 2027" from an ISO date or time: the shared format (qa-company-22), never "1 Sept 2027". */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return formatDate(value);
}

export { plural } from "@/lib/format";

/** What a finding's subject is, in a word, when its name is not known. */
const SUBJECT_WORD: Record<Finding["subject_kind"], string> = { entity: "A goal", roadmap_item: "A roadmap item", document: "A document" };

/**
 * What a finding is about, in words: the goal, choice or item by name. pass F F-41: never its
 * reference (a slug such as "product-strategy-team-plans"); a choice is also found by its key.
 */
export function subjectName(f: Finding, stack: Stack | undefined): string {
  const title = typeof f.detail?.title === "string" ? f.detail.title : null;
  if (title) return title;
  const choices = stack?.strategy?.choices ?? [];
  const goals = [...choices.flatMap((c) => c.goals), ...(stack?.unaligned.goals ?? [])];
  const key = f.subject_ref.replace(/^[a-z_]+:/, "");
  const named =
    goals.find((g) => g.id === f.subject_id) ??
    choices.find((c) => c.entity_id === f.subject_id) ??
    choices.find((c) => key === c.id || key.endsWith(`-${c.id}`));
  if (named) return named.title;
  if (f.subject_kind === "document") return f.kind === "vision_review_due" ? "Vision" : "Product strategy";
  if (f.subject_ref.startsWith("strategy_choice:")) return "A focus choice";
  return SUBJECT_WORD[f.subject_kind] ?? "Something";
}

/** pass F F-46: the subject's link says what it opens ("Open goal"), never "Open" alone. */
export function subjectLinkLabel(f: Finding, stack: Stack | undefined): string {
  if (stack?.strategy?.choices.some((c) => c.entity_id === f.subject_id)) return "Open focus choice";
  if (f.subject_kind === "roadmap_item") return "Open item";
  if (f.subject_kind === "document") return f.kind === "vision_review_due" ? "Open vision" : "Open strategy";
  return "Open goal";
}

/** Where a finding's subject is opened: the goal in the baseline, the item on the Plan, the document. */
export function subjectHref(f: Finding, stack: Stack | undefined): string | null {
  const choice = stack?.strategy?.choices.find((c) => c.entity_id === f.subject_id);
  if (choice && stack?.strategy) return `/documents/${stack.strategy.document.slug}/v/${stack.strategy.document.version}#choice-${choice.id}`;
  if (f.subject_kind === "entity" && f.subject_id) return `/baseline?entity=${f.subject_id}`;
  if (f.subject_kind === "roadmap_item") return "/plan";
  if (f.subject_kind === "document") return `/documents/${f.subject_ref}`;
  return null;
}

/** The open findings about a goal, a choice (or the items it stops) or an item. */
export function findingsAbout(findings: Finding[], id: string | null | undefined): Finding[] {
  if (!id) return [];
  return findings.filter((f) => f.subject_id === id || (Array.isArray(f.detail?.choice_ids) && f.detail.choice_ids.includes(id)));
}
