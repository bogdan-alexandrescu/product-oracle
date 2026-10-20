/**
 * Links to a section of a version (I3 PRD navigation, item 7): every link to a section
 * (feedback items, reports, comments, banners, Resolve, Inbox, Home) is built here, so
 * they all use one form. The PRD page reads it back with `keyFromHash`, which also takes
 * the older `#s-<key>` form that earlier links and saved bookmarks carry.
 */

/** The hash naming a section: `#problem`. */
export function sectionHash(key: string): string {
  return `#${encodeURIComponent(key)}`;
}

/** The app path of a version, at a section when `key` is given: `/documents/x/v/2#problem`. */
export function sectionHref(doc: string, n: number, key?: string | null): string {
  return `/documents/${doc}/v/${n}${key ? sectionHash(key) : ""}`;
}

/** The section a URL hash names: `#problem`, or the older `#s-problem`. A key that itself starts with `s-` matches first. */
export function keyFromHash(hash: string | null | undefined, keys: ReadonlySet<string>): string | null {
  if (!hash) return null;
  let h = hash.replace(/^#/, "");
  try {
    h = decodeURIComponent(h);
  } catch {
    // A malformed escape: match it as written.
  }
  if (keys.has(h)) return h;
  if (h.startsWith("s-") && keys.has(h.slice(2))) return h.slice(2);
  return null;
}
