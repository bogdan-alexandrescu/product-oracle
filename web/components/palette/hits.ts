// build-palette (#1794): what the ⌘K palette finds, as plain data: the roadmap's features (each
// with its code and name), PRDs, goals, key results, milestones (GET /v1/simple/palette) and
// every page, and how typed words match them.
import type { PanelFeature } from '@/app/simple/roadmap/_panel';
import type { Schemas } from '@/lib/api/client';

export type HitKind = 'Feature' | 'PRD' | 'Goal' | 'Key result' | 'Milestone' | 'Action' | 'Page';

export type Hit = {
  key: string;
  kind: HitKind;
  code?: string;
  name: string;
  where: string;
  href?: string;
  feature?: PanelFeature;
  run?: () => void;
  /** The row that shows the rest of this kind. */
  more?: HitKind;
};

export const FOUND_KINDS: HitKind[] = ['Feature', 'PRD', 'Goal', 'Key result', 'Milestone'];
export const GROUP_OF: Record<string, string> = {
  Feature: 'Features',
  PRD: 'PRDs',
  Goal: 'Goals',
  'Key result': 'Key results',
  Milestone: 'Milestones',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$ ]/g, '');

/** A code typed with or without its dash ("F-79", "f79", "79"), or every word in the name. */
export function matches(h: Hit, q: string): boolean {
  const n = norm(q).trim();
  if (!n) return true;
  const code = (h.code ?? '').toLowerCase().replace('-', '');
  const qc = n.replace(/ /g, '');
  if (code && (code === qc || code === `f${qc}` || code.startsWith(qc))) return true;
  const hay = norm(`${h.code ?? ''} ${h.name} ${h.kind}`);
  return n.split(/\s+/).every((w) => hay.includes(w));
}

const word = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');

type Item = Pick<
  Schemas['SimpleRoadmapItem'],
  'id' | 'code' | 'title' | 'status' | 'merged_into'
> & {
  prd?: { id: string; slug: string; title: string } | null;
  track?: { title: string } | null;
};

/** The roadmap's features: each with its code (none yet: its name alone) and name, its track (else
 * its PRD) and status. */
export function featureHits(items: Item[]): Hit[] {
  return items
    .filter((i) => !i.merged_into)
    .map((i) => ({
      key: `f-${i.id}`,
      kind: 'Feature' as const,
      code: i.code || undefined,
      name: i.title,
      where: [i.track?.title || i.prd?.title || 'Roadmap', word(i.status)]
        .filter(Boolean)
        .join(' · '),
      feature: { id: i.id, code: i.code ?? '', name: i.title, prd: i.prd ?? null },
    }));
}

/** PRDs, goals, key results, milestones and the Ground Truth features on no roadmap, each opening
 * where it lives. */
export function indexHits(p: Schemas['PaletteOut'] | undefined): Hit[] {
  if (!p) return [];
  return [
    // On no roadmap, so no item panel: its own place on the Ground Truth.
    ...p.features.map((f) => ({
      key: `e-${f.id}`,
      kind: 'Feature' as const,
      code: f.code || undefined,
      name: f.name,
      where: 'Ground Truth',
      href: `/ground-truth?entity=${f.id}`,
    })),
    ...p.prds.map((d) => ({
      key: `d-${d.id}`,
      kind: 'PRD' as const,
      name: d.title,
      where: ['One-pagers', word(d.status)].join(' · '),
      href: `/simple/one-pagers/${d.slug}`,
    })),
    ...p.goals.map((g) => ({
      key: `g-${g.id}`,
      kind: 'Goal' as const,
      name: g.name,
      where: 'Goal map',
      href: `/simple/goals?goal=${g.id}`,
    })),
    ...p.key_results.map((k) => ({
      key: `k-${k.id}`,
      kind: 'Key result' as const,
      name: k.name,
      where: k.goal || 'Goal map',
      href: k.goal_id ? `/simple/goals?goal=${k.goal_id}` : '/simple/goals',
    })),
    ...p.milestones.map((m) => ({
      key: `m-${m.id}`,
      kind: 'Milestone' as const,
      code: m.code || undefined,
      name: m.name,
      where: ['Roadmap', m.date].filter(Boolean).join(' · '),
      // Its own card on the Roadmap, opened by address (useLinkedMilestone); a track's, its mark.
      href: `/simple/roadmap?milestone=${m.id}`,
    })),
  ];
}

const RECENT = 'oracle.palette.recent';

/** The keys of the items opened last (the empty box shows them first). */
export function recentKeys(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberOpened(key: string): void {
  try {
    localStorage.setItem(
      RECENT,
      JSON.stringify([key, ...recentKeys().filter((k) => k !== key)].slice(0, 3)),
    );
  } catch {
    // Storage full or off: no recent list.
  }
}
