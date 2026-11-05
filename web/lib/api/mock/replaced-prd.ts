/**
 * new-prd-from-replaced-prd (owner Nov 4), as oracle.intake.carried: what a new PRD
 * replacing an approved PRD carries. Its items (the roadmap items made from it), its
 * standing decided decisions (reversed, withdrawn, replaced and trashed ones left out and
 * named) and its verified, not withdrawn, schedule bases for the area's items.
 *
 * The "replaced-prd" scenario seeds, on the approved Usage alerts PRD, two standing
 * decisions, a reversed one, and verified, proposed and out-of-area bases.
 */

import type { Schemas } from "@/lib/api/client";

type Carried = Schemas["Carried"];
type Decision = Pick<Schemas["DecisionOut"], "id" | "number" | "title" | "status" | "subjects" | "chosen_option">;
type Basis = Schemas["ScheduleBasisOut"];
type Item = Schemas["RoadmapItemOut"];

export const REPLACED_PRD_SCENARIO = "replaced-prd";

const LAPSED: Record<string, string> = { reversed: "reversed", withdrawn: "withdrawn", superseded: "replaced by a later decision" };

export interface CarriedSource {
  doc: { id: string; slug: string; title: string; kind?: string | null; trashed?: boolean } | undefined;
  /** The PRD's latest approved version number, null when none is approved. */
  approvedVersion: number | null;
  /** Its versions' ids (decisions about a version are about it). */
  versionIds: string[];
  /** Every roadmap item made from it. */
  items: Item[];
  decisions: Decision[];
  /** "roadmap" or "document" when a decision is about something in Trash, else null. */
  trashedAbout: (d: Decision) => string | null;
  bases: Basis[];
}

export function carriedFor(
  src: CarriedSource,
  itemKeys: string[],
  area?: { name: string; scope: string },
): Carried | { status: number; detail: string } {
  const { doc } = src;
  if (!doc || doc.trashed) return { status: 404, detail: "That PRD was not found" };
  if ((doc.kind ?? "prd") !== "prd" || src.approvedVersion == null) return { status: 422, detail: "A new PRD can only replace an approved PRD" };
  const titles = new Map<string, string>();
  for (const i of src.items) if (!titles.has(i.item_key)) titles.set(i.item_key, i.title);
  const keys = [...new Set(itemKeys)].filter((k) => titles.has(k));
  const about = new Set([doc.id, ...src.versionIds, ...src.items.map((i) => i.id)]);
  const named = src.decisions
    .filter((d) => (d.status === "decided" || d.status in LAPSED) && (d.subjects ?? []).some((s) => about.has(String(s.id))))
    .sort((a, b) => a.number - b.number);
  const kept: Decision[] = [];
  const left: string[] = [];
  for (const d of named) {
    const trashed = d.status in LAPSED ? null : src.trashedAbout(d);
    if (d.status in LAPSED) left.push(`D-${d.number} ${d.title} (${LAPSED[d.status]})`);
    else if (trashed) left.push(`D-${d.number} ${d.title} (about a ${trashed === "roadmap" ? "roadmap" : "document"} now in Trash)`);
    else kept.push(d);
  }
  const bases = src.bases
    .filter((b) => b.prd_document_id === doc.id && b.status === "verified" && !b.withdrawn_at && b.item_key && keys.includes(b.item_key))
    .sort((a, b) => (a.item_key ?? "").localeCompare(b.item_key ?? "") || a.supports_date.localeCompare(b.supports_date));
  return {
    document_id: doc.id,
    slug: doc.slug,
    title: doc.title,
    version: src.approvedVersion,
    area_name: area?.name ?? null,
    area_scope: area?.scope ?? null,
    items: [...titles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, title]) => ({ key, title, in_area: keys.includes(key) })),
    decisions: kept.map((d) => ({ id: d.id, number: d.number, title: d.title, chosen: d.chosen_option ?? null })),
    left_out: left,
    bases: bases.map((b) => ({ id: b.id, kind: b.kind, reference: b.reference, item_key: b.item_key!, supports_date: b.supports_date, detail: b.detail ?? null })),
  };
}

/** The scenario's schedule bases on the old PRD's items (two in the area, verified). */
export function seedReplacedBases(prdId: string, keys: string[], uuid: () => string): Basis[] {
  const [first, second, third] = keys;
  const at = "2026-10-20T15:00:00Z";
  const basis = (item_key: string | undefined, reference: string, more: Partial<Basis>): Basis | null =>
    item_key
      ? ({
          id: uuid(), kind: "estimate", reference, supports_date: "2026-12-15", detail: null, prd_document_id: prdId, item_key,
          tracker_key: null, tracker_record_id: null, status: "verified", note: null, proposed_by: null, proposed_at: null,
          verified_by: null, verified_at: at, withdrawn_by: null, withdrawn_at: null, withdrawn_reason: null,
          rejected_by: null, rejected_at: null, rejected_reason: null, created_at: at, ...more,
        } as Basis)
      : null;
  return [
    basis(first, "EX-101", { detail: "Two weeks, lead's estimate" }),
    basis(second, "Q4 safety plan", { kind: "commitment", supports_date: "2026-11-30" }),
    basis(first, "EX-102", { status: "proposed", verified_at: null }),
    basis(third, "EX-303", {}),
  ].filter((b): b is Basis => b != null);
}
