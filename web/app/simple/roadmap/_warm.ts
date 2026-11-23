import { api, unwrap } from '@/lib/api/client';
import { takeWarm, warmRead } from '@/lib/api/warm';
import { SIMPLE_MODE } from '@/lib/simple-mode';

/**
 * simple-speed: the reads the roadmap's parts make once the chart is drawn (the tracks, what
 * was removed, the draft PRDs, each planned PRD's no-work weeks) start with the roadmap's own
 * read, not after it has answered. Each part takes its warmed read once (lib/api/warm); every
 * later read is its own, as before.
 */

const PLAN_PRDS = 'po:simple-roadmap-plan-prds';
const TRACKS = 'simple-tracks';
const REMOVED = 'simple-removed';
const DRAFT_PRDS = 'simple-roadmap-draft-prds';
const planKey = (prd: string) => `simple-prd-plan:${prd}`;
// The roadmap's own read, by its query as the page writes it (JSON).
const roadmapKey = (query: string) => `simple-roadmap:${query}`;
const NO_FILTER = { group: 'goal' } as const;

/** A part's own read (`load`), or the one warmed for it. */
export const takeTracks = <T>(load: () => Promise<T>) => takeWarm(TRACKS, load);
export const takeRemoved = <T>(load: () => Promise<T>) => takeWarm(REMOVED, load);
export const takeDraftPrds = <T>(load: () => Promise<T>) => takeWarm(DRAFT_PRDS, load);
export const takePlan = <T>(prd: string, load: () => Promise<T>) => takeWarm(planKey(prd), load);
export const takeRoadmap = <T>(query: string, load: () => Promise<T>) =>
  takeWarm(roadmapKey(query), load);

/** The PRDs whose plans the roadmap read last time in this browser (none: nothing to warm). */
function lastPlanPrds(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(PLAN_PRDS) ?? '[]');
    return Array.isArray(kept) ? kept.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Keeps the PRDs whose plans the roadmap reads, for the next load's warm-up. */
export function keepPlanPrds(prds: string[]): void {
  try {
    localStorage.setItem(PLAN_PRDS, JSON.stringify(prds));
  } catch {
    // No storage (a private window): the plans are read after the roadmap, as before.
  }
}

/** Starts the parts' reads now, beside the roadmap's own; a read already warm is kept. */
export function warmRoadmapPage(): void {
  warmRead(TRACKS, () => unwrap(api.GET('/v1/simple/tracks')));
  warmRead(REMOVED, () => unwrap(api.GET('/v1/simple/removed')));
  warmRead(DRAFT_PRDS, () => unwrap(api.GET('/v1/simple/roadmap/draft-prds')));
  for (const prd of lastPlanPrds())
    warmRead(planKey(prd), () =>
      unwrap(api.GET('/v1/simple/prds/{prd}/plan', { params: { path: { prd } } })),
    );
}

/**
 * On a cold load of the Roadmap its own read and its parts' start at once, beside GET /v1/me,
 * not after it and the capabilities have answered. The page takes them when it is drawn
 * (lib/api/warm): each is still read once. With a filter in the address the page reads for
 * itself, as before. The rail's counts still start once GET /v1/me has answered: the pages
 * share those reads for two seconds only (lib/api/shared-reads), so begun earlier they would
 * be read twice whenever GET /v1/me is slow.
 */
export function warmSimple(path: string, search: string): void {
  if (!SIMPLE_MODE) return;
  if (path !== '/simple/roadmap' || search) return;
  warmRead(roadmapKey(JSON.stringify(NO_FILTER)), () =>
    unwrap(api.GET('/v1/simple/roadmap', { params: { query: NO_FILTER } })),
  );
  warmRoadmapPage();
}
