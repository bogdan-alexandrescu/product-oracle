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

/** A brief's question as its words read: its id and text. */
type BriefQuestion = { id: string; question: string };

/**
 * A brief's text for people (production minors 21): no internal file names ("(questions.json)")
 * and no question codes ("otr-q1"): a code the brief asks reads as that question's words, one it
 * does not as "an open question".
 */
export function readerText(text: string, questions: BriefQuestion[] = []): string {
  const byId = new Map(questions.map((q) => [q.id, q.question]));
  return text
    .replace(/\s*\((?:see |in |from )?[\w./-]+\.(?:json|ya?ml|md|txt|csv)\)/gi, "")
    .replace(/\b[\w./-]+\.(?:json|ya?ml)\b/gi, "the brief's notes")
    // A code in capitals ("OTR-Q1") is the same code (review minors 21); a bare "Q1" not asked is left as written.
    .replace(/\b(?:[a-z]{2,6}-)?q\d+\b/gi, (code) => {
      const words = byId.get(code) ?? byId.get(code.toLowerCase());
      if (words) return `“${words.replace(/[.?!]+$/, "")}”`;
      return code.includes("-") ? "an open question" : code;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * An approach's list items (production minors 19): "Do this: - one - two" or one "- item"
 * per line reads as its lead line and a list; text with fewer than two items has no list.
 * Prose with " - " asides ("keep it simple - one table - no queue") is not a list: an inline
 * list follows a colon (review minors 19).
 */
export function approachParts(text: string): { lead: string; items: string[] } {
  const lines = text.split(/(?:^|\n)[ \t]*-\s+(?=\S)/);
  const inline = /^([\s\S]*?:)\s+-\s+(?=\S)([\s\S]*)$/.exec(text);
  const parts = lines.length >= 3 ? lines : inline ? [inline[1], ...inline[2].split(/\s-\s+(?=\S)/)] : [];
  if (parts.length < 3) return { lead: text, items: [] };
  const [lead, ...items] = parts;
  return { lead: lead.trim(), items: items.map((i) => i.trim()).filter(Boolean) };
}
