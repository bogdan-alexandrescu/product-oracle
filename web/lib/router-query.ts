// #1581: how the router reads and writes the query: as the pages read it (URLSearchParams through
// lib/nav.ts), not TanStack's default JSON values.
type Query = Record<string, string | string[]>;

/** The query as plain strings (a repeated key keeps every value), never parsed as JSON. */
export function parseQuery(search: string): Query {
  const out: Query = {};
  for (const [k, v] of new URLSearchParams(search)) {
    const had = out[k];
    out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
  return out;
}

/** Back to text as it came: a key with no value stays bare (`?latest`, not `?latest=`). */
export function stringifyQuery(search: Record<string, unknown>): string {
  const parts = Object.entries(search).flatMap(([k, v]) =>
    (Array.isArray(v) ? v : [v])
      .filter((x) => x !== undefined)
      .map((x) => {
        const pair = new URLSearchParams([[k, String(x)]]).toString();
        return x === '' ? pair.replace(/=$/, '') : pair;
      }),
  );
  return parts.length ? `?${parts.join('&')}` : '';
}
