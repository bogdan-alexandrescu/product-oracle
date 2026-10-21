import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

type TechBrief = Schemas["TechBriefOut"];

/** A tech brief's freshness: its chip's label and kind. */
export const FRESHNESS: Record<TechBrief["freshness"], { label: string; kind: ChipKind }> = {
  fresh: { label: "Fresh", kind: "pass" },
  potentially_stale: { label: "Potentially stale", kind: "warn" },
  under_review: { label: "Under review", kind: "na" },
  reconciled: { label: "Reconciled", kind: "pass" },
};
/** Size and its person-weeks (oracle.engineering.briefs.SIZES). */
const WEEKS: Record<string, number> = { xs: 0.5, s: 1, m: 2, l: 4, xl: 8 };

export function sizeText(size: string): string {
  const weeks = WEEKS[size];
  return weeks == null ? size.toUpperCase() : `${size.toUpperCase()} · about ${weeks} person-week${weeks === 1 ? "" : "s"}`;
}
