import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { displayName } from "@/lib/names";

export type Decision = Schemas["DecisionOut"];
export type DecisionSummary = Schemas["DecisionSummary"];
export type DecisionOption = Schemas["DecisionOption"];
/** A member for the pickers, with the name the company knows them by (GET /v1/people). */
export type Person = Schemas["DecisionPerson"] & { name?: string };

/** A person's name; without a member record, the name their email gives ("first.last@" reads "First Last"). */
export const personName = (p: Pick<Person, "email"> & { name?: string }) => p.name?.trim() || displayName(p.email);

/** A picker option's words: the name first, the email after it. */
export const personOption = (p: Person) => {
  const name = personName(p);
  return name === p.email ? name : `${name} · ${p.email}`;
};
export type DecisionState = DecisionSummary["state"];

export const STATE_LABEL: Record<DecisionState, string> = {
  proposed: "Proposed",
  decided: "Decided",
  review_due: "Review due",
  superseded: "Superseded",
  reversed: "Reversed",
  withdrawn: "Withdrawn",
};

export const STATE_KIND: Record<DecisionState, ChipKind> = {
  proposed: "acc",
  decided: "pass",
  review_due: "warn",
  superseded: "na",
  reversed: "crit",
  withdrawn: "na",
};

export const REVERSIBILITY_LABEL: Record<DecisionSummary["reversibility"], string> = {
  reversible: "Reversible",
  irreversible: "Hard to reverse",
};

/** The class switch: judgement calls by default, so a run's stop records never bury them. */
export type ClassFilter = "judgement" | "checkpoint" | "all";
export const CLASS_FILTERS: { value: ClassFilter; label: string }[] = [
  { value: "judgement", label: "Judgement calls" },
  { value: "checkpoint", label: "Checkpoints" },
  { value: "all", label: "All kinds" },
];

/** State chips; Needs me (the default when I have any) is what waits on me to decide or review. */
export type StateFilter = "needs_me" | "proposed" | "review_due" | "decided" | "all";
export const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: "needs_me", label: "Needs me" },
  { value: "proposed", label: "Proposed" },
  { value: "review_due", label: "Review due" },
  { value: "decided", label: "Decided" },
  { value: "all", label: "Any state" },
];

/** The From menu: where a decision came from. The two checkpoint entries split by the choice. */
export const FROM: { value: string; label: string; origin: DecisionSummary["origin"]; chosen?: string }[] = [
  { value: "version_approval", label: "Published versions", origin: "version_approval" },
  { value: "assumption", label: "Risks and assumptions", origin: "assumption" },
  { value: "blocker", label: "Blockers", origin: "blocker" },
  { value: "pushback_override", label: "Pushback overrides", origin: "pushback_override" },
  { value: "priority_override", label: "Priority overrides", origin: "priority_override" },
  { value: "checkpoint_approvals", label: "Checkpoint approvals", origin: "checkpoint", chosen: "approve" },
  { value: "checkpoint_send_backs", label: "Checkpoint send-backs", origin: "checkpoint", chosen: "request_changes" },
  { value: "manual", label: "Recorded by hand", origin: "manual" },
  { value: "oracle", label: "Proposed by Oracle", origin: "oracle" },
];

export const ORIGIN_LABEL: Record<DecisionSummary["origin"], string> = {
  manual: "Recorded by hand",
  oracle: "Proposed by Oracle",
  version_approval: "A published version",
  assumption: "An accepted risk or assumption",
  blocker: "A blocker's resolution",
  pushback_override: "An override of Oracle's pushback",
  priority_override: "A priority override",
  autonomy: "Decided by Oracle",
  checkpoint: "A run's stop",
  request_decline: "A request said no to",
  pricing: "A pricing memo",
  meeting: "A review meeting",
};

export const VERDICT_LABEL: Record<Schemas["DecisionReviewOut"]["verdict"], string> = {
  reaffirmed: "Reaffirmed",
  revisit: "Revisit",
  reversed: "Reversed",
};

export const SUBJECT_LABEL: Record<string, string> = {
  document: "Document",
  document_version: "Version",
  section: "Section",
  roadmap_item: "Roadmap item",
  entity: "Baseline item",
  blocker: "Blocker",
  gap: "Gap",
  run: "Run",
  ritual_occurrence: "Ritual",
  discussion: "Discussion",
};

/** A baseline item's type in words: "acceptance_criterion" reads "Acceptance criterion". */
export const entityTypeLabel = (type: string) => type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");

/** H3's outcome status in the Outcomes tab's words. */
export const OUTCOME_LABEL: Record<NonNullable<Decision["outcome_status"]>, string> = {
  predicted: "Predicted",
  tracking: "Measuring",
  held: "Held",
  partially_held: "Partly held",
  not_held: "Not held",
  inconclusive: "Inconclusive",
};

export const OUTCOME_KIND: Record<NonNullable<Decision["outcome_status"]>, ChipKind> = {
  predicted: "na",
  tracking: "acc",
  held: "pass",
  partially_held: "acc",
  not_held: "crit",
  inconclusive: "line",
};

/** YYYY-MM-DD, `days` from today (local). */
export function isoDay(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Jan 18, 2027" from a date or a timestamp (the shell's formatDate); "—" for none. */
export function shortDate(value: string | null | undefined): string {
  return value ? formatDate(value) : "—";
}

/** A slug key from an option's label, unique among `taken`. */
export function optionKey(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "option";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

export const isCheckpoint = (d: Pick<DecisionSummary, "class">) => d.class === "checkpoint";
