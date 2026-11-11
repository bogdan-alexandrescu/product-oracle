/**
 * The company's tracks keep one order on every page (track-order, owner Nov 9), the API's rule
 * (api/oracle/roadmap/models.py TRACK_ORDER): a track's place number (`order`, lower first; Move
 * up / Move down in the Tracks sheet), then, without one, when it was made. The roadmap read's
 * `tracks` and GET /v1/simple/tracks come in that order; a feature's track carries its `order`.
 */

/** The fields the rule reads (a feature's track is one). */
export type OrderedTrack = { title: string; order?: number | null };

/** The one track order, for Array.prototype.sort: by `order`, a track without one last, then by title. */
export function byTrackOrder(a: OrderedTrack, b: OrderedTrack): number {
  const oa = a.order ?? Infinity;
  const ob = b.order ?? Infinity;
  if (oa !== ob) return oa < ob ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/** `[id, title]` choices in the order of `tracks` (the read's, already in the track order); one it does not list keeps its place after them. */
export function inTrackOrder<T extends readonly [string, string]>(choices: readonly T[], tracks: readonly { id: string }[] | null | undefined): T[] {
  const at = new Map((tracks ?? []).map((t, n) => [t.id, n]));
  return choices
    .map((c, n) => [c, at.get(c[0]) ?? (tracks?.length ?? 0) + n] as const)
    .sort((x, y) => x[1] - y[1])
    .map(([c]) => c);
}
