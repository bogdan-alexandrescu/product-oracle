// build-palette (#1794): the palette's two reads: the roadmap (its features) and the index (PRDs,
// goals, key results, milestones). Not read is not empty: nothing is said to be missing, or
// added, until both have answered.
import { api, unwrap } from '@/lib/api/client';
import { useQuery } from '@/lib/use-query';

export function usePaletteReads() {
  const roadmap = useQuery('simple-roadmap:{}', () => unwrap(api.GET('/v1/simple/roadmap', {})));
  const index = useQuery('simple-palette', () => unwrap(api.GET('/v1/simple/palette')));
  const waiting = [roadmap, index].filter((r) => !r.data);
  return {
    roadmap: roadmap.data,
    index: index.data,
    ready: waiting.length === 0,
    failed: waiting.find((r) => r.error)?.error ?? null,
    retry: () => waiting.forEach((r) => void r.reload()),
  };
}
