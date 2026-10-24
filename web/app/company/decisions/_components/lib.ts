import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { shownDay } from "@/lib/dates";

export type Decision = Schemas["DecisionOut"];
export type DecisionSummary = Schemas["DecisionSummary"];
export type DecisionOption = Schemas["DecisionOption"];
export type Person = Schemas["DecisionPerson"];
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
  { value: "all", label: "All" },
];

/** State chips; Needs me (the default when I have any) is what waits on me to decide or review. */
export type StateFilter = "needs_me" | "proposed" | "review_due" | "decided" | "all";
export const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: "needs_me", label: "Needs me" },
  { value: "proposed", label: "Proposed" },
  { value: "review_due", label: "Review due" },
  { value: "decided", label: "Decided" },
  { value: "all", label: "All" },
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
  pricing: "A pricing memo",
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

/** YYYY-MM-DD, `days` from today (local). */
export function isoDay(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "18 Jan 2027" from a date or a timestamp; "—" for none. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return shownDay(value, { day: "numeric", month: "short", year: "numeric" }, "en-GB");
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
