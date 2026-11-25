/**
 * build-palette (#1794): GET /v1/simple/palette as oracle.simple.palette reads it, composed from
 * the mock's own reads so it always agrees with them: the PRDs the person may see
 * (/v1/documents?kind=prd), the Goal map's goals and the metric each reads as its key result,
 * and the roadmap's goal milestones with their codes.
 */
import type { Schemas } from '@/lib/api/client';

type Out = Schemas['PaletteOut'];
type Fetch = (req: Request) => Promise<Response>;

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

export async function routePalette(req: Request, fetcher: Fetch): Promise<Response | null> {
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname !== '/v1/simple/palette') return null;
  const [docs, map, roadmap] = await Promise.all([
    json<{ id: string; slug: string; title: string; status: string; kind?: string }[]>(
      fetcher,
      req,
      '/v1/documents?kind=prd',
      [],
    ),
    json<{
      goals?: {
        id: string;
        name: string;
        measure: string;
        metric?: { id: string; title: string } | null;
      }[];
    }>(fetcher, req, '/v1/simple/goal-map', {}),
    json<{
      goal_milestones?: { id: string; code: string; name: string; date?: string | null }[];
    }>(fetcher, req, '/v1/simple/roadmap', {}),
  ]);
  const goals = map.goals ?? [];
  const out: Out = {
    prds: docs
      .filter((d) => !d.kind || d.kind === 'prd')
      .map((d) => ({ id: d.id, slug: d.slug, title: d.title, status: d.status }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    goals: goals.map((g) => ({ id: g.id, name: g.name, measure: g.measure })),
    key_results: goals.flatMap((g) =>
      g.metric ? [{ id: g.metric.id, name: g.metric.title, goal: g.name, goal_id: g.id }] : [],
    ),
    milestones: (roadmap.goal_milestones ?? []).map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      date: dayWords(m.date),
    })),
  };
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
