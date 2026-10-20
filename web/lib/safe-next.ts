/**
 * The page to return to after sign-in, from a `?next=` value: a path on this site, or
 * `/home`. Browsers treat a backslash, a tab or a line break after the first slash as
 * part of a host (`/\evil.com` goes to evil.com), so any backslash or control character
 * refuses the value; what is left must resolve to this origin. The router parses the
 * result again, and resolving dot-segments can leave a path that starts with `//`
 * (`/.//evil.com` becomes `//evil.com`, another host), so the result itself must also
 * stay on this origin when parsed.
 */
export function safeNextPath(next: string | null | undefined, origin: string): string {
  const home = "/home";
  if (!next || !next.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(next)) return home;
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return home;
    const out = u.pathname + u.search + u.hash;
    if (out.startsWith("//") || new URL(out, origin).origin !== origin) return home;
    return out;
  } catch {
    return home;
  }
}
