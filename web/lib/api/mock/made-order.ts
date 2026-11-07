/**
 * Simple changes in the order the API lists them (order_by at, seq): by when, and a tie on
 * when by the order they were made in, never by the random id. `seq` in the API is a
 * change's place in its list here, so pass the list in the order it was made (a filter
 * keeps that order). `when` gives the sort keys, first first; `newest` lists newest first.
 */
export function madeOrder<T>(list: T[], when: (c: T) => (string | null | undefined)[], newest = false): T[] {
  const cmp = (a: string | null | undefined, b: string | null | undefined) =>
    // As Postgres's DESC NULLS LAST and ASC NULLS LAST alike: a missing time sorts last.
    a === b ? 0 : a == null ? (newest ? -1 : 1) : b == null ? (newest ? 1 : -1) : a < b ? -1 : 1;
  const sign = newest ? -1 : 1;
  return list
    .map((c, i) => ({ c, i, k: when(c) }))
    .sort((x, y) => {
      for (let j = 0; j < x.k.length; j++) {
        const d = cmp(x.k[j], y.k[j]);
        if (d) return sign * d;
      }
      return sign * (x.i - y.i);
    })
    .map((x) => x.c);
}
