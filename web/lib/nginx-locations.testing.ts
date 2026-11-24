/**
 * #1609, #1715: a reader of nginx/default.conf.template's locations for the unit tests
 * (lib/redirects.test.ts, lib/nginx-config.test.ts). nginx's regex locations are PCRE; the
 * ones the template uses are valid JavaScript patterns too, so the tests run them here.
 */
export type Location = { kind: '=' | '~' | '^~'; pattern: string; body: string };

/** Every top-level `location` of a server block (one level of braces inside, for an `if`). */
export function nginxLocations(conf: string): Location[] {
  const found: Location[] = [];
  const re = /location\s+(=|~|\^~)\s+(\S+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  for (const m of conf.matchAll(re))
    found.push({ kind: m[1] as Location['kind'], pattern: m[2], body: m[3] });
  return found;
}

/**
 * The redirect nginx answers for a path (decoded, as nginx matches it) and a query ("" or
 * "a=1"), or null when the location it picks returns none. Picks as nginx does for these
 * kinds: an exact match, then the longest `^~` prefix, then the first regex in file order.
 */
export function nginxAnswer(
  locations: Location[],
  path: string,
  query: string,
): { code: number; to: string } | null {
  const exact = locations.find((l) => l.kind === '=' && l.pattern === path);
  const prefix = locations
    .filter((l) => l.kind === '^~' && path.startsWith(l.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  let groups: string[] = [];
  const regex = locations.find((l) => {
    if (l.kind !== '~') return false;
    const m = path.match(new RegExp(l.pattern));
    if (m) groups = [...m];
    return m !== null;
  });
  const at = exact ?? prefix ?? regex;
  if (!at) return null;
  const bare = at.body.match(/if \(\$args = ""\) \{\s*return (\d+) (\S+?);\s*\}/);
  const body = at.body.replace(/if \([^)]*\) \{[^}]*\}/g, '');
  const main = body.match(/return (\d+) (\S+?);/);
  const [, code, target] = query === '' && bare ? bare : (main ?? []);
  if (!code) return null;
  const to = target
    .replace(/\$is_args\$args/g, query ? `?${query}` : '')
    .replace(/\$(\d)/g, (_, n: string) => groups[Number(n)] ?? '');
  return { code: Number(code), to };
}
