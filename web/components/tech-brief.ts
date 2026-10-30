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
/** Shown wherever a code map built from the synced docs only is cited (F5-2, codemap.PARTIAL_LABEL). */
export const DOCS_ONLY = "Docs only: code not read";
/** Size and its person-weeks (oracle.engineering.briefs.SIZES). */
const WEEKS: Record<string, number> = { xs: 0.5, s: 1, m: 2, l: 4, xl: 8 };

export function sizeText(size: string): string {
  const weeks = WEEKS[size];
  return weeks == null ? size.toUpperCase() : `${size.toUpperCase()} · about ${weeks} person-week${weeks === 1 ? "" : "s"}`;
}

/** How a page names the PRD a spec or design rests on, and its sections (qa-docs-35). */
export type PrdWords = { slug: string | null; title: string | null; heading: (key: string) => string | null };

/**
 * A staleness reason in words ("section s-5-2 changed in checkout-redesign" reads
 * 'Section "5.2 Shipping step" changed in Checkout redesign PRD'): section headings and the
 * PRD's title, never keys or slugs (qa-docs-18).
 */
export function reasonText(reason: string, w: PrdWords): string {
  // A key may hold dots ("s-5.2"), but the period that ends the sentence is kept.
  let out = reason.replace(/\bsection ([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g, (_, key: string) => (w.heading(key) ? `section "${w.heading(key)}"` : "a section"));
  if (w.slug) out = out.replaceAll(w.slug, w.title ?? "the PRD");
  return out.charAt(0).toUpperCase() + out.slice(1);
}
