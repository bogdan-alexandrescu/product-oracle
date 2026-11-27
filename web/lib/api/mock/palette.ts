/**
 * build-palette (#1794): GET /v1/simple/palette as oracle.simple.palette reads it, composed from
 * the mock's own reads so it always agrees with them: the PRDs the person may see
 * (/v1/documents?kind=prd), the confirmed goals (the Goal map's, which the API holds as the
 * same rows) and their key results (the confirmed subgoals, each under its top goal), the
 * roadmap read's milestones (its tracks' and its goals'), one per roadmap code, and the confirmed
 * Ground Truth features no roadmap item holds.
 */
import type { Schemas } from '@/lib/api/client';
import { joinedNames } from '@/lib/milestone-code';

import { ANY_CODE } from './feature-codes';
import { goalMapIdOf } from './goal-map';
import { reply } from './typed';

type Out = Schemas['PaletteOut'];
type Goal = Pick<Schemas['EntityOut'], 'id' | 'title' | 'status' | 'parent_id' | 'attrs'>;
type Milestone = Schemas['SimpleGoalMilestone'];
type Roadmap = Pick<Schemas['SimpleRoadmapOut'], 'goal_milestones' | 'milestones' | 'items'>;
type Feature = Pick<Schemas['EntityOut'], 'id' | 'key' | 'title' | 'status'>;
type Fetch = (req: Request) => Promise<Response>;

/** A key result on the Goal map: "Sign-ups per rep per day" under its goal "Growth" (invented). */
export const PALETTE_KR_SCENARIO = 'palette-key-result';

/** The scenario's goal (the map's first, renamed) and its key result, as Ground Truth goals; in
 * any other scenario, nothing. */
export function seedPaletteGoals(
  scenario: string | null,
  add: (
    type: 'goal',
    key: string,
    title: string,
    more: { attrs?: Record<string, unknown>; status: 'confirmed' },
  ) => { id: string; parent_id?: string | null },
): void {
  if (scenario !== PALETTE_KR_SCENARIO) return;
  const growth = add('goal', 'g.growth', 'Growth', { status: 'confirmed' });
  growth.id = goalMapIdOf('signups');
  const kr = add('goal', 'g.growth.signups', 'Sign-ups per rep per day', {
    attrs: { metric: 'sign-ups per rep per day', target: 40 },
    status: 'confirmed',
  });
  kr.parent_id = growth.id;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-12-02" -> "Dec 2" (month first, as the API words it). */
export function dayWords(iso: string | null | undefined): string {
  if (!iso) return '';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return m && d ? `${MONTHS[m - 1]} ${d}` : '';
}

async function json<T>(fetcher: Fetch, req: Request, path: string, fallback: T): Promise<T> {
  const r = await fetcher(new Request(new URL(path, req.url), { headers: req.headers }));
  return r.ok ? ((await r.json()) as T) : fallback;
}

/** palette._goals: the confirmed live goals, and the confirmed live subgoals under their top goal. */
export function goalsOf(rows: Goal[]): Pick<Out, 'goals' | 'key_results'> {
  const byId = new Map(rows.map((g) => [g.id, g]));
  const gone = (g: Goal, seen: string[] = []): boolean =>
    ['archived', 'rejected'].includes(g.status) ||
    (!!g.parent_id &&
      !seen.includes(g.parent_id) &&
      byId.has(g.parent_id) &&
      gone(byId.get(g.parent_id)!, [...seen, g.id]));
  const live = new Map(
    rows.filter((g) => g.status === 'confirmed' && !gone(g)).map((g) => [g.id, g]),
  );
  const topOf = (g: Goal): Goal =>
    g.parent_id && live.has(g.parent_id) ? topOf(live.get(g.parent_id)!) : g;
  const out: Pick<Out, 'goals' | 'key_results'> = { goals: [], key_results: [] };
  for (const g of [...live.values()].sort((a, b) => a.title.localeCompare(b.title))) {
    const top = topOf(g);
    const measure = g.attrs?.metric;
    if (top === g)
      out.goals.push({
        id: g.id,
        name: g.title,
        measure: typeof measure === 'string' ? measure : '',
      });
    else out.key_results.push({ id: g.id, name: g.title, goal: top.title, goal_id: top.id });
  }
  return out;
}

/** palette._milestones: one per roadmap code (twins folded), by its longer name and its date; a
 * code only a track milestone holds is that milestone's row. */
export function milestonesOf(roadmap: Partial<Roadmap>): Out['milestones'] {
  const goals = roadmap.goal_milestones ?? [];
  const tracks = roadmap.milestones ?? [];
  const names = joinedNames(goals, tracks);
  const groups = new Map<string, Milestone[]>();
  for (const m of [...tracks, ...goals])
    if (m.roadmap_code) groups.set(m.roadmap_code, groups.get(m.roadmap_code) ?? []);
  for (const m of goals) if (m.roadmap_code) groups.get(m.roadmap_code)!.push(m);
  const dayOf = (code: string, of: Milestone[]) => {
    const track = tracks.filter((t) => t.roadmap_code === code);
    if (track[0]?.date) return track[0].date;
    const own = of.flatMap((m) => (m.goal_id && !m.prd && m.date ? [m.date] : []));
    const all = [...track, ...of].flatMap((m) => (m.date ? [m.date] : []));
    return (track.length || !own.length ? all : own).sort()[0];
  };
  return [...groups]
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([code, of]) => ({
      id: (
        of.find((m) => m.goal_id && !m.prd) ??
        of[0] ??
        tracks.find((t) => t.roadmap_code === code)!
      ).id,
      code,
      name: names.get(code)?.name ?? (of[0] ?? tracks.find((t) => t.roadmap_code === code)!).name,
      date: dayWords(dayOf(code, of)),
    }));
}

/** palette._features: the confirmed features (by code, else name) no roadmap item holds. */
export function featuresOf(rows: Feature[], roadmap: Partial<Roadmap>): Out['features'] {
  const held = new Set((roadmap.items ?? []).flatMap((i) => (i.code ? [i.code] : [])));
  return rows
    .filter((f) => f.status === 'confirmed' && !held.has(f.key))
    .map((f) => ({ id: f.id, code: ANY_CODE.test(f.key) ? f.key : null, name: f.title }))
    .sort(
      (a, b) =>
        Number(!a.code) - Number(!b.code) ||
        (a.code ?? '').localeCompare(b.code ?? '') ||
        a.name.localeCompare(b.name),
    );
}

export async function routePalette(req: Request, fetcher: Fetch): Promise<Response | null> {
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname !== '/v1/simple/palette') return null;
  const [docs, map, entities, roadmap, features] = await Promise.all([
    json<{ id: string; slug: string; title: string; status: string; kind?: string }[]>(
      fetcher,
      req,
      '/v1/documents?kind=prd',
      [],
    ),
    json<{ goals?: { id: string; name: string; measure: string }[] }>(
      fetcher,
      req,
      '/v1/simple/goal-map',
      {},
    ),
    json<Goal[]>(fetcher, req, '/v1/baseline/entities?type=goal', []),
    json<Partial<Roadmap>>(fetcher, req, '/v1/simple/roadmap', {}),
    json<Feature[]>(fetcher, req, '/v1/baseline/entities?type=feature', []),
  ]);
  const held = new Set(entities.map((e) => e.id));
  const onMap: Goal[] = (map.goals ?? [])
    .filter((g) => !held.has(g.id))
    .map((g) => ({
      id: g.id,
      title: g.name,
      status: 'confirmed',
      parent_id: null,
      attrs: { metric: g.measure },
    }));
  return reply('/v1/simple/palette', 'get', {
    prds: docs
      .filter((d) => !d.kind || d.kind === 'prd')
      .map((d) => ({ id: d.id, slug: d.slug, title: d.title, status: d.status }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    ...goalsOf([...entities, ...onMap]),
    milestones: milestonesOf(roadmap),
    features: featuresOf(features, roadmap),
  });
}
