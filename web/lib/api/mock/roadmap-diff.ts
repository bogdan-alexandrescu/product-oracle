import type { Schemas } from "@/lib/api/client";

/**
 * E3 roadmap item diff for the mock: api/oracle/roadmap/diff.py's classification and
 * api/oracle/roadmap/diff_views.py's rows, ported. Items match by key, then one-to-one by
 * normalised title (a rename); plan changes count, confidence, a one-place rank move, the
 * section's text and the date's state alone are notes.
 */
type Item = Schemas["RoadmapItemOut"];
type Change = Schemas["RoadmapItemChange"];
type Field = Schemas["ItemFieldChange"];

const COUNTED = ["title", "outcome", "horizon", "milestone_name", "milestone_date", "depends_on", "prd_section", "rank"] as const;
const NOTES = ["confidence", "date_state", "section_hash"] as const;
const RANK_THRESHOLD = 2;
const NAMES: Record<string, string> = { key: "item_key", section_hash: "prd_section_text" };
const HORIZON_ORDER: Record<string, number> = { now: 0, next: 1, later: 2 };

type Snap = {
  key: string;
  title: string;
  outcome: string | null;
  horizon: string;
  milestone_name: string | null;
  milestone_date: string | null;
  date_state: string | null;
  depends_on: string[];
  rank: number | null;
  confidence: string | null;
  prd_section: string | null;
  section_hash: string | null;
  position: number;
};

/** An item with its milestone as it stands now (the mock's liveItem). */
export function snapshot(i: Item): Snap {
  const m = (i.milestone ?? null) as Record<string, unknown> | null;
  const date = typeof m?.date === "string" ? m.date : null;
  const refused = typeof m?.refused_date === "string" ? m.refused_date : null;
  const rank = (i.priority as Record<string, unknown> | null)?.rank;
  return {
    key: i.item_key,
    title: i.title,
    outcome: i.outcome ?? null,
    horizon: i.horizon,
    milestone_name: typeof m?.name === "string" ? m.name : null,
    milestone_date: date ?? refused,
    date_state: date ? "verified" : refused ? "refused" : null,
    depends_on: i.depends_on ?? [],
    rank: typeof rank === "number" ? rank : null,
    confidence: i.confidence ?? null,
    prd_section: i.prd.section_key,
    section_hash: i.prd.section_hash,
    position: i.position,
  };
}

export const normalize = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, " ")
    .trim();

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function field(name: string, before: unknown, after: unknown): Field {
  const out: Field = { field: NAMES[name] ?? name, before, after };
  if (name === "depends_on") {
    const b = before as string[];
    const a = after as string[];
    out.added = a.filter((d) => !b.includes(d));
    out.removed = b.filter((d) => !a.includes(d));
  }
  return out;
}

function compare(b: Snap, h: Snap): { fields: Field[]; notes: Field[] } {
  const fields: Field[] = [];
  const notes: Field[] = [];
  if (b.key !== h.key) fields.push(field("key", b.key, h.key));
  for (const name of [...COUNTED, ...NOTES]) {
    const before = b[name];
    const after = h[name];
    if (same(before, after)) continue;
    if (name === "rank" && before != null && after != null) {
      (Math.abs((after as number) - (before as number)) >= RANK_THRESHOLD ? fields : notes).push(field(name, before, after));
    } else if ((COUNTED as readonly string[]).includes(name)) fields.push(field(name, before, after));
    else if (!(name === "date_state" && fields.some((f) => f.field === "milestone_date"))) notes.push(field(name, before, after));
  }
  return { fields, notes };
}

export function diffItems(baseItems: Item[], headItems: Item[]): { summary: Record<string, number>; items: Change[] } {
  const base = baseItems.map(snapshot).sort((a, b) => a.position - b.position);
  const head = headItems.map(snapshot).sort((a, b) => a.position - b.position);
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  head.forEach((h, j) => {
    const i = base.findIndex((b, n) => b.key === h.key && !taken.has(n));
    if (i >= 0) {
      pairs.set(j, i);
      taken.add(i);
    }
  });
  const unique = (list: Snap[], free: (n: number) => boolean) => {
    const seen = new Map<string, number[]>();
    list.forEach((s, n) => {
      const t = normalize(s.title);
      if (free(n) && t) seen.set(t, [...(seen.get(t) ?? []), n]);
    });
    return new Map([...seen].filter(([, ns]) => ns.length === 1).map(([t, ns]) => [t, ns[0]]));
  };
  const baseTitles = unique(base, (n) => !taken.has(n));
  for (const [t, j] of unique(head, (n) => !pairs.has(n))) {
    const i = baseTitles.get(t);
    if (i != null) {
      pairs.set(j, i);
      taken.add(i);
    }
  }
  const present: Change[] = head.map((h, j) => {
    const i = pairs.get(j);
    const row = { item_key: h.key, title: h.title, head_horizon: h.horizon, head_position: h.position };
    if (i == null) return { ...row, change: "added", matched_by: null, base_horizon: null, base_position: null, fields: [], notes: [] };
    const b = base[i];
    const { fields, notes } = compare(b, h);
    const change = fields.some((f) => f.field === "horizon") ? "moved" : fields.length ? "changed" : "unchanged";
    return { ...row, change, matched_by: b.key === h.key ? "key" : "title", base_horizon: b.horizon, base_position: b.position, fields, notes };
  });
  const after = new Map<number, Change[]>();
  base.forEach((b, i) => {
    if (taken.has(i)) return;
    const limit = HORIZON_ORDER[b.horizon] ?? 3;
    let anchor = -1;
    present.forEach((p, j) => {
      if ((HORIZON_ORDER[p.head_horizon ?? ""] ?? 3) <= limit) anchor = j;
    });
    const row: Change = {
      item_key: b.key, change: "dropped", matched_by: null, title: b.title, base_horizon: b.horizon, head_horizon: null,
      base_position: b.position, head_position: null, fields: [], notes: [],
    };
    after.set(anchor, [...(after.get(anchor) ?? []), row]);
  });
  const items = [...(after.get(-1) ?? []), ...present.flatMap((p, j) => [p, ...(after.get(j) ?? [])])];
  const summary = Object.fromEntries(
    (["added", "dropped", "moved", "changed", "unchanged"] as const).map((s) => [s, items.filter((i) => i.change === s).length]),
  );
  return { summary, items };
}
