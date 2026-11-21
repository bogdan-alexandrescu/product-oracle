/**
 * #1580: every redirect of the web, in one table, applied by one helper (resolveRedirect),
 * which nginx serves to a full page load and the router (app/__root.tsx) to an in-app one.
 *
 * `from` and `to` are paths; `:name` matches one segment and `:name*` the rest of the path
 * (none or more segments), and the same names in `to` take what they matched. The query comes
 * along unchanged. `bare`, when set, is where a request without a query goes instead of `to`.
 * `permanent` answers 308 (a moved page), otherwise 307.
 */
export type Redirect = { from: string; to: string; permanent: boolean; bare?: string };

export const REDIRECTS: readonly Redirect[] = [
  // c7 Plan rename: the Roadmap page became Plan; old links and bookmarks keep working.
  { from: '/roadmap', to: '/plan', permanent: true },
  // Baseline became the Ground Truth (Nov 4): old links, their sub-paths and queries land there.
  { from: '/baseline/:path*', to: '/ground-truth/:path*', permanent: true },
  // qa-simple-prd-12: a PRD's one-pager has one address (the rail, the links and the mode switch know it).
  { from: '/simple/prds/:doc', to: '/simple/one-pagers/:doc', permanent: false },
  // rirs-36: the To decide tab moved to /requests/to-decide; an old link (with its ?request=)
  // lands there. qa4-work-18: typed bare, /requests/new opens the New request form over All
  // requests, the list a person starts from, not over To decide.
  {
    from: '/requests/new',
    to: '/requests/to-decide',
    permanent: false,
    bare: '/requests?compose=request',
  },
];

/** The table entry's `from` as a matcher: the names it captures, in order, and its pattern. */
function compile(from: string): { names: string[]; pattern: RegExp } {
  const names: string[] = [];
  const source = from
    .split('/')
    .map((seg) => {
      const m = seg.match(/^:(\w+)(\*)?$/);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]);
      return m[2] ? '\u0000' : '([^/]+)';
    })
    .join('/')
    // `/:rest*` matches the bare path too, and any sub-path under it.
    .replace(/\/\u0000/g, '((?:/[^/]+)*)');
  return { names, pattern: new RegExp(`^${source}/?$`) };
}

/**
 * Where a request for `pathname` with `search` ("" or "?a=1") goes, and whether for good;
 * null when no entry matches. Captured segments are kept as the request had them (encoded).
 */
export function resolveRedirect(
  pathname: string,
  search: string,
): { to: string; permanent: boolean } | null {
  for (const r of REDIRECTS) {
    const { names, pattern } = compile(r.from);
    const m = pathname.match(pattern);
    if (!m) continue;
    const query = search.replace(/^\?/, '');
    if (!query && r.bare) return { to: r.bare, permanent: r.permanent };
    let to = r.to;
    names.forEach((name, i) => {
      const value = m[i + 1] ?? '';
      to = to.replace(new RegExp(`/:${name}\\*`), value).replace(`:${name}`, value);
    });
    if (query) to += (to.includes('?') ? '&' : '?') + query;
    return { to: to || '/', permanent: r.permanent };
  }
  return null;
}
