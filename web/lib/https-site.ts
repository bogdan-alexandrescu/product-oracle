/**
 * An alternative's website as the API's market._website takes it (urlsplit): an https://
 * address with a host and no spaces. Blank is checked by the caller. Shared by the web and
 * the mock, so "https://:443" (no host) is refused in both, as the API refuses it.
 */
export function isHttpsSite(value: string): boolean {
  if (/\s/.test(value)) return false;
  const netloc = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (netloc === undefined) return false;
  const host = netloc.slice(netloc.lastIndexOf("@") + 1);
  if (host.startsWith("[")) return /^\[[^\]]+\](:\d*)?$/.test(host);
  if (/[[\]]/.test(host)) return false;
  return host.split(":")[0].length > 0;
}
