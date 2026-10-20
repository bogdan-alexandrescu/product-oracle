import type { EntityOut, Schemas } from "@/lib/api/client";

type RevisionOut = Schemas["RevisionOut"];

/** A goal figure read from its attrs: "45%" -> 45 "%", "400 clinics" -> 400 "clinics", "below 8%" -> 8 "%". */
export type Figure = { value: number; unit: string };

export function parseFigure(raw: unknown): Figure | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, unit: "" } : null;
  if (typeof raw !== "string") return null;
  const m = raw.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/(-?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].trim() };
}

/** "below 8%" is met at or under 8; "above 40" at or over; a bare target only when reached exactly. */
export function direction(raw: unknown): "down" | "up" | null {
  if (typeof raw !== "string") return null;
  if (/^\s*(below|under|less than|at most|max(imum)?|<|≤)/i.test(raw)) return "down";
  if (/^\s*(above|over|more than|at least|min(imum)?|>|≥)/i.test(raw)) return "up";
  return null;
}

export type GoalView = {
  id: string;
  /** G1, G2… in the baseline's order (heaviest first). */
  tag: string;
  title: string;
  metric: string | null;
  proposed: boolean;
  /** 0-100, or null when the baseline has none. */
  confidence: number | null;
  current: Figure | null;
  target: Figure | null;
  /** The target as written ("below 8%"). */
  targetText: string | null;
  /** The goal's unit: the target's, else the current value's. */
  unit: string;
  met: boolean;
};

/** Live goals, heaviest first, tagged G1, G2… as the Baseline tags them. */
export function goalViews(entities: EntityOut[]): GoalView[] {
  return entities
    .filter((e) => e.type === "goal" && e.status !== "rejected")
    .sort((a, b) => Number(b.attrs?.weight ?? 0) - Number(a.attrs?.weight ?? 0) || a.title.localeCompare(b.title))
    .map((g, i) => {
      const current = parseFigure(g.attrs?.current);
      const target = parseFigure(g.attrs?.target);
      const dir = direction(g.attrs?.target);
      const met =
        !!current &&
        !!target &&
        (dir === "down" ? current.value <= target.value : dir === "up" ? current.value >= target.value : current.value === target.value);
      return {
        id: g.id,
        tag: `G${i + 1}`,
        title: g.title,
        metric: typeof g.attrs?.metric === "string" ? g.attrs.metric : null,
        proposed: g.status === "proposed",
        confidence: g.confidence == null ? null : Math.round(g.confidence * 100),
        current,
        target,
        targetText: g.attrs?.target == null ? null : String(g.attrs.target),
        unit: target?.unit || current?.unit || "",
        met,
      };
    });
}

export type Point = { at: string; value: number };

const SIX_MONTHS_MS = 183 * 24 * 3600 * 1000;

/**
 * The goal's `current` over time, from the revisions the baseline records whenever attrs
 * change: one point per revision that set a readable value, the six months up to the latest.
 */
export function historyOf(revisions: RevisionOut[]): Point[] {
  const points = revisions
    .map((r) => {
      const attrs = (r.after?.attrs ?? null) as Record<string, unknown> | null;
      const f = attrs ? parseFigure(attrs.current) : null;
      return f ? { at: r.created_at, value: f.value } : null;
    })
    .filter((p): p is Point => p !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  // Drop repeats: a revision that changed something else carries the same value.
  const series = points.filter((p, i) => i === 0 || p.value !== points[i - 1].value || i === points.length - 1);
  const last = series.at(-1);
  if (!last) return [];
  const from = Date.parse(last.at) - SIX_MONTHS_MS;
  return series.filter((p) => Date.parse(p.at) >= from);
}

/** Whole months the series spans, at least one: the "6m" after a change. */
export function spanMonths(points: Point[]): number {
  if (points.length < 2) return 0;
  const ms = Date.parse(points.at(-1)!.at) - Date.parse(points[0].at);
  return Math.max(1, Math.round(ms / (30.4 * 24 * 3600 * 1000)));
}

/** "38%" for a percent goal, "236" otherwise: the unit beyond % goes after the target. */
export function formatValue(f: Figure, unit: string): string {
  const n = Math.round(f.value * 10) / 10;
  return unit === "%" ? `${n}%` : `${n}`;
}
