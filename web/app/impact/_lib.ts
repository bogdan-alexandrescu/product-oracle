import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatPercent } from "@/lib/format";

import type { Names } from "./_names";

export type Report = Schemas["ImpactReport"];
export type Output = Schemas["TraceOutput"];
export type Proposal = Schemas["RegenerationProposal"];
export type Dependency = Schemas["TraceDependency"];
export type Freshness = Output["freshness"];

/** Where the report comes from: a document version (preview), a baseline item (what-if) or a recorded change. */
export type ImpactSource = { kind: "version"; doc: string; n: number } | { kind: "entity"; id: string } | { kind: "change"; id: string };

/** Past this many outputs the lineage groups them by category, one node each. */
export const GROUP_AT = 15;

export const CATEGORY: Record<Output["category"], string> = {
  engineering_spec: "Engineering spec",
  wireframe: "Wireframe",
  prototype: "Prototype",
  acceptance_tests: "Acceptance tests",
  roadmap: "Roadmap",
  document: "Document",
};

export const FRESH: Record<Freshness, { label: string; kind: ChipKind }> = {
  fresh: { label: "Fresh", kind: "pass" },
  potentially_stale: { label: "Potentially stale", kind: "warn" },
  under_review: { label: "Under review", kind: "na" },
  reconciled: { label: "Reconciled", kind: "pass" },
};
const ORDER: Record<Freshness, number> = { fresh: 0, reconciled: 1, under_review: 2, potentially_stale: 3 };

export const stalest = (fs: Freshness[]): Freshness => fs.reduce<Freshness>((a, b) => (ORDER[b] > ORDER[a] ? b : a), "fresh");

/** An output's key: its artifact version or its document version. */
export const keyOf = (o: { artifact_version_id?: string | null; document_version_id?: string | null }) =>
  o.artifact_version_id ?? o.document_version_id ?? "";

/** "Approved", "Draft", "In review", "Superseded": an output's status in words. */
export function statusLabel(status: string): string {
  const s = status.replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const outputTitle = (o: Output) => `${o.title} v${o.number}`;

/** The upstream node a dependency points at: a section, a baseline item, or a whole version. */
export type Upstream = {
  key: string;
  kind: "section" | "entity" | "version";
  label: string;
  sub: string;
  /** A short name for the "From …" groups. */
  short: string;
  deleted: boolean;
  deletedAt: string | null;
  entityId: string | null;
  entityKey: string | null;
};

/** "Checkout redesign PRD v1": a dependency's document version in words. */
function whereOf(u: Dependency["upstream"], names?: Names): string {
  if (!u.document_slug) return "";
  const doc = names ? names.doc(u.document_slug) : u.document_slug;
  return `${doc}${u.version_number != null ? ` v${u.version_number}` : ""}`;
}

/** A section's heading, or its key where no names are given. */
const sectionOf = (u: Dependency["upstream"], names?: Names) =>
  u.section_key ? (names ? names.section(u.section_key, u.document_slug, u.version_number) : u.section_key) : "";

export function upstreamOf(d: Dependency, names?: Names): Upstream {
  const u = d.upstream;
  const where = whereOf(u, names);
  if (u.entity) {
    const e = u.entity;
    const conf = e.locked ? "locked" : e.confidence != null ? `${formatPercent(e.confidence)} confidence` : null;
    return {
      key: `e:${e.id}`, kind: "entity", label: e.title, sub: [e.key, e.type.replaceAll("_", " "), conf].filter(Boolean).join(" · "),
      short: u.deleted ? `${e.title} (deleted)` : e.title, deleted: Boolean(u.deleted), deletedAt: u.deleted_at ?? null,
      entityId: e.id, entityKey: e.key,
    };
  }
  if (u.section_key) {
    const section = sectionOf(u, names);
    return {
      key: `s:${u.document_slug ?? ""}#${u.section_key}`, kind: "section", label: section, sub: where ? `Section of ${where}` : "Section",
      short: section, deleted: Boolean(u.deleted), deletedAt: u.deleted_at ?? null, entityId: null, entityKey: null,
    };
  }
  return {
    key: `v:${u.version_id ?? where}`, kind: "version", label: where || "Upstream version", sub: "All of it",
    short: where || "the version", deleted: Boolean(u.deleted), deletedAt: u.deleted_at ?? null, entityId: null, entityKey: null,
  };
}

/** "Checkout redesign PRD v1 · Scope": a dependency's upstream in one line. */
export function upstreamLine(d: Dependency, names?: Names): string {
  const u = d.upstream;
  if (u.entity) return `${u.entity.key} · ${u.entity.title}`;
  return [whereOf(u, names), sectionOf(u, names)].filter(Boolean).join(" · ") || "Upstream";
}

/** Each output's upstream nodes, in first-seen order. */
export function upstreamsOf(o: Output, names?: Names): Upstream[] {
  const seen = new Map<string, Upstream>();
  for (const d of o.dependencies ?? []) {
    const u = upstreamOf(d, names);
    if (!seen.has(u.key)) seen.set(u.key, u);
  }
  return [...seen.values()];
}

/** The plan's proposal for an output, if it has one. */
export function proposalOf(report: Report, o: Output): Proposal | undefined {
  const k = keyOf(o);
  return report.plan.find((p) => keyOf(p) === k);
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
