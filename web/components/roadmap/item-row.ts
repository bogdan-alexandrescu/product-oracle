import type { Schemas } from "@/lib/api/client";

/**
 * One roadmap item as the shared items table and inspector show it (E2). The Items tab maps
 * the API's RoadmapItemOut here (`toItemRow`); D1 Items review maps its file items to the
 * same shape.
 */
export type Horizon = "now" | "next" | "later";

export type ItemRow = {
  key: string;
  position: number;
  title: string;
  outcome: string | null;
  horizon: Horizon;
  milestone: {
    name: string | null;
    date: string | null;
    refused_date: string | null;
    refused: string | null;
    /** D1: the date is not verified (no "verified" chip); `date_removed`: a staged edit removes it (struck). */
    verified?: boolean;
    date_removed?: boolean;
  } | null;
  /** "high" / "medium" / "low", or a 0-1 number. */
  confidence: string | number | null;
  depends_on: string[];
  prd: { label: string; href: string } | null;
  freshness?: Schemas["RoadmapItemOut"]["freshness"];
  stale_reasons?: string[];
  engineering?: Schemas["TrackerRecordRef"][];
  /** E3: an item the compared version had and this one dropped (a muted, struck row). */
  ghost?: boolean;
  /** D1: a handled row's text is muted; a dropped item's title is struck through. */
  muted?: boolean;
  struck?: boolean;
};

export const HORIZONS: { value: Horizon; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "next", label: "Next" },
  { value: "later", label: "Later" },
];

export const horizonLabel = (h: string) => HORIZONS.find((x) => x.value === h)?.label ?? h;

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/**
 * The API's item as a row. `headings`: the PRD version's section headings by key, for the
 * PRD column's "§ heading" (the key stands in when the heading is unknown).
 */
export function toItemRow(item: Schemas["RoadmapItemOut"], headings?: ReadonlyMap<string, string>): ItemRow {
  const m = item.milestone as Record<string, unknown> | null;
  const key = item.prd.section_key;
  return {
    key: item.item_key,
    position: item.position,
    title: item.title,
    outcome: item.outcome,
    horizon: item.horizon,
    milestone: m
      ? { name: text(m.name), date: text(m.date), refused_date: text(m.refused_date), refused: text(m.refused) }
      : null,
    confidence: item.confidence ?? null,
    depends_on: item.depends_on ?? [],
    prd: item.prd.link ? { label: `§ ${(key && headings?.get(key)) || key || item.prd.document?.title || "PRD"}`, href: item.prd.link } : null,
    freshness: item.freshness,
    stale_reasons: item.stale_reasons,
    engineering: item.engineering,
  };
}

/** A date the API refused or withdrew, or an item whose PRD trace may be stale. */
export function needsAttention(row: ItemRow): boolean {
  // A reconciled item was confirmed still valid: nothing left to look at.
  return !!row.milestone?.refused_date || row.freshness === "potentially_stale" || row.freshness === "under_review";
}

/**
 * The roadmap section that names an item ("Open in document"): the first whose key is
 * `{horizon}-{key}`, else `{key}`, else whose heading equals the title; else the version's
 * first section. Null when the version has none.
 */
export function sectionFor(
  item: { key: string; horizon: string; title: string },
  sections: readonly { section_key: string; heading: string }[],
): string | null {
  const byKey = (k: string) => sections.find((s) => s.section_key === k);
  const found =
    byKey(`${item.horizon}-${item.key}`) ??
    byKey(item.key) ??
    sections.find((s) => s.heading.trim() === item.title.trim()) ??
    sections[0];
  return found?.section_key ?? null;
}
