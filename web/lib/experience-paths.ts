/**
 * #723: the pure path rules of the two modes (no API), so specs can test them without a page.
 * lib/experience re-exports them.
 */

/*
 * #723 S1: the two modes of the app, Simple and Detailed (D10, D17). A page's mode is in its
 * path (`/simple/...` is Simple, everything else Detailed), so a link opens in the mode it was
 * shared from (D13); the person's saved mode (`experience` in GET /v1/me/preferences), or
 * their role's default (`default_experience` in GET /v1/me/capabilities), only decides where
 * they land after sign-in and on `/`.
 */
export type Mode = "simple" | "detailed";

export const SIMPLE_HOME = "/simple";
export const DETAILED_HOME = "/home";

export function modeOf(pathname: string): Mode {
  return pathname === SIMPLE_HOME || pathname.startsWith(`${SIMPLE_HOME}/`) ? "simple" : "detailed";
}

export const homeOf = (mode: Mode) => (mode === "simple" ? SIMPLE_HOME : DETAILED_HOME);

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/**
 * Simple's pages and the Detailed page each one matches (D10); the rest match the other home.
 * A one-pager and its PRD's page match first (switchTarget), so the lists' pair (qa-shell-5)
 * only takes the lists themselves.
 */
const PAIRS: [simple: string, detailed: string][] = [
  ["/simple/roadmap", "/plan"],
  ["/simple/priorities", "/priorities"],
  ["/simple/meetings", "/company/rituals"],
  ["/simple/decisions", "/company/decisions"],
  ["/simple/one-pagers", "/documents"],
];

/**
 * The page the switch lands on in the other mode: Home <-> Home, a PRD's one-pager <-> that
 * PRD's page, One-pagers <-> PRDs, Roadmap <-> Plan, Priorities <-> Priorities, Meetings <->
 * Company › Rituals, Decisions <-> Company › Decisions; anything else, the other mode's home.
 * `documentHome`: the list an open document page said it belongs to ("/documents" for a PRD),
 * when known.
 */
export function switchTarget(pathname: string, to: Mode, documentHome?: string): string {
  if (to === modeOf(pathname)) return pathname;
  if (to === "detailed") {
    const onePager = /^\/simple\/one-pagers\/([^/]+)/.exec(pathname)?.[1];
    if (onePager) return `/documents/${onePager}`;
    return PAIRS.find(([simple]) => under(pathname, simple))?.[1] ?? DETAILED_HOME;
  }
  const doc = /^\/documents\/([^/]+)/.exec(pathname)?.[1];
  if (doc && doc !== "new") {
    if (!documentHome || documentHome === "/documents") return `/simple/one-pagers/${doc}`;
    // A document page of another kind (a roadmap, a strategy) has no one-pager: its list's match, else Home.
    return PAIRS.find(([, detailed]) => detailed !== "/documents" && under(documentHome, detailed))?.[0] ?? SIMPLE_HOME;
  }
  return PAIRS.find(([, detailed]) => under(pathname, detailed))?.[0] ?? SIMPLE_HOME;
}
