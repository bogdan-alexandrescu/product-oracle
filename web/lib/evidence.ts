/**
 * The evidence inspector's payload (GET /v1/documents/{doc}/versions/{n}/evidence) pivoted
 * for v2 screen 3: C's coverage matrix (targets and draft citations as rows, sections as
 * columns) is a client-side pivot of the per-section links and citations; A's section table
 * reads the sections as they come (links already strongest first).
 */
import type { Schemas } from "@/lib/api/client";

export type EvidenceInspector = Schemas["EvidenceInspector"];
export type SectionEvidence = Schemas["SectionEvidence"];
export type SectionLinkView = Schemas["SectionLinkView"];
export type SectionLinkTarget = Schemas["SectionLinkTarget"];
export type EvidenceCitation = Schemas["EvidenceCitation"];
export type LinkKind = SectionLinkView["kind"];
export type LinkPrecision = SectionLinkView["precision"];

export const KINDS: { value: LinkKind; label: string; short: string }[] = [
  { value: "evidences", label: "Evidences", short: "Evid" },
  { value: "implements", label: "Implements", short: "Impl" },
  { value: "claims", label: "Claims", short: "Claim" },
  { value: "tests", label: "Tests", short: "Tests" },
  { value: "mentions", label: "Mentions", short: "Ment" },
];
export const PRECISIONS: { value: LinkPrecision; label: string }[] = [
  { value: "section", label: "Section" },
  { value: "paragraph", label: "Paragraph" },
  { value: "claim", label: "Claim" },
];
export const kindLabel = (k: LinkKind) => KINDS.find((x) => x.value === k)?.label ?? k;
export const kindShort = (k: LinkKind) => KINDS.find((x) => x.value === k)?.short ?? k;

const SOURCE: Record<string, string> = {
  slack: "Slack",
  notion: "Notion",
  gdocs: "Google Docs",
  github: "GitHub",
  fireflies: "Meeting notes",
  upload: "Upload",
  web: "Web",
  oracle: "Oracle baseline",
};
/** "github:issue" → "GitHub". */
export const sourceLabel = (kind: string | null | undefined) => (kind ? (SOURCE[kind.split(":")[0]] ?? kind) : "Source");

/** B3's confidence bands, as the mockup's legend: ≥ 0.70, 0.40–0.70, < 0.40, unscored. */
export function tone(c: number | null | undefined): "pass" | "warn" | "crit" | "na" {
  if (c == null) return "na";
  return c >= 0.7 ? "pass" : c >= 0.4 ? "warn" : "crit";
}
export const score = (c: number | null | undefined) => (c == null ? "—" : c.toFixed(2));

/** Rejected and superseded items are left out of exports (greyed here). */
export const leftOut = (t: SectionLinkTarget) => t.status === "rejected" || t.status === "superseded";

export function targetTitle(t: SectionLinkTarget): string {
  if (t.title) return t.title;
  if (t.restricted) return "Restricted source";
  return t.ref ?? "Untitled";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

/** The second line of a target: its ref and status, or its source and state. */
export function targetSub(t: SectionLinkTarget): string {
  if (t.type === "entity") return [t.entity_type ? cap(t.entity_type) : "Baseline item", t.status ? t.status.replace(/_/g, " ") : null, t.locked ? "locked" : null].filter(Boolean).join(" · ");
  const parts: string[] = [sourceLabel(t.source_kind)];
  if (t.restricted) parts.push("restricted · kind only");
  if (t.source_removed) parts.push("source removed");
  return parts.filter(Boolean).join(" · ");
}

export function targetEyebrow(t: SectionLinkTarget): string {
  if (t.type === "entity") return `Baseline ${t.entity_type ?? "item"}`;
  if (t.type === "evidence") return `Evidence · ${sourceLabel(t.source_kind)}`;
  return `Source item · ${sourceLabel(t.source_kind)}`;
}

export type MatrixGroup = "baseline" | "evidence" | "citations";
export const GROUP_LABEL: Record<MatrixGroup, string> = {
  baseline: "Baseline items",
  evidence: "Evidence & source items",
  citations: "Draft citations",
};

export type MatrixRow = {
  /** "entity:<id>", "evidence:<id>", "source_item:<id>" or "cite:<key>". */
  id: string;
  group: MatrixGroup;
  title: string;
  sub: string;
  muted: boolean;
  target?: SectionLinkTarget;
  citation?: EvidenceCitation;
  /** Section key → this row's links there (strongest first). */
  links: Map<string, SectionLinkView[]>;
  /** Sections whose draft cites it (citation rows). */
  cited: Set<string>;
  stale: boolean;
};

export const targetKey = (t: SectionLinkTarget) => `${t.type}:${t.id}`;

/** Targets (baseline items, then evidence and source items) and draft citations as rows. */
export function pivot(sections: SectionEvidence[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const s of sections) {
    for (const l of s.links) {
      const id = targetKey(l.target);
      let row = rows.get(id);
      if (!row) {
        row = {
          id,
          group: l.target.type === "entity" ? "baseline" : "evidence",
          title: targetTitle(l.target),
          sub: targetSub(l.target),
          muted: leftOut(l.target) || l.target.restricted,
          target: l.target,
          links: new Map(),
          cited: new Set(),
          stale: false,
        };
        rows.set(id, row);
      }
      row.links.set(s.section_key, [...(row.links.get(s.section_key) ?? []), l]);
      if (!l.current) row.stale = true;
    }
    for (const c of s.citations) {
      const id = `cite:${c.cite_key}`;
      let row = rows.get(id);
      if (!row) {
        row = {
          id,
          group: "citations",
          title: c.title || c.ref,
          sub: sourceLabel(c.source),
          muted: false,
          citation: c,
          links: new Map(),
          cited: new Set(),
          stale: false,
        };
        rows.set(id, row);
      }
      row.cited.add(s.section_key);
    }
  }
  const order: MatrixGroup[] = ["baseline", "evidence", "citations"];
  return [...rows.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** A section with neither links nor citations of its own. */
const bare = (s: SectionEvidence) => s.links.length === 0 && s.citations.length === 0;

/**
 * The unsupported sections' keys: a section counts only when neither it nor any deeper
 * section under it (the sections after it, until one at its level or above) has links or
 * citations. The level-1 title is never flagged.
 */
export function unsupportedKeys(sections: SectionEvidence[]): Set<string> {
  const out = new Set<string>();
  sections.forEach((s, i) => {
    if (s.level <= 1) return;
    let end = i + 1;
    while (end < sections.length && sections[end].level > s.level) end++;
    if (sections.slice(i, end).every(bare)) out.add(s.section_key);
  });
  return out;
}
export const staleCount = (s: SectionEvidence) => s.links.filter((l) => !l.current).length;

/** The lowest scored confidence of a section's links, or null when none is scored. */
export function weakest(s: SectionEvidence): number | null {
  const scored = s.links.map((l) => l.target.confidence).filter((c): c is number => c != null);
  return scored.length ? Math.min(...scored) : null;
}

/** "Brief" or "Full", as the Document tab names its layers. */
export const layerLabel = (layer: string) => (layer === "brief" ? "Brief" : "Full");
