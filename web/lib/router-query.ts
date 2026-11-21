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

/** Only what would change the query's meaning is escaped (`:` and `/` stay as typed, as Next kept them). */
const encode = (text: string) =>
  text.replace(/[%&=#+\s]/g, (c) => (c === ' ' ? '+' : encodeURIComponent(c)));

/** Back to text as it came: a key with no value stays bare (`?latest`, not `?latest=`). */
export function stringifyQuery(search: Record<string, unknown>): string {
  const parts = Object.entries(search).flatMap(([k, v]) =>
    (Array.isArray(v) ? v : [v])
      .filter((x) => x !== undefined)
      .map((x) => (x === '' ? encode(k) : `${encode(k)}=${encode(String(x))}`)),
  );
  return parts.length ? `?${parts.join('&')}` : '';
}
