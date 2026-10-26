"use client";

import { api, unwrap } from "@/lib/api/client";
import type { Role } from "@/lib/me";

/**
 * #723 S1: the two modes of the app, Simple and Studio (D10, D17). A page's mode is in its
 * path (`/simple/...` is Simple, everything else Studio), so a link opens in the mode it was
 * shared from (D13); the person's saved mode (`experience` in GET /v1/me/preferences), or
 * their role's default, only decides where they land after sign-in and on `/`.
 */
export type Mode = "simple" | "studio";

export const SIMPLE_HOME = "/simple";
export const STUDIO_HOME = "/home";

export function modeOf(pathname: string): Mode {
  return pathname === SIMPLE_HOME || pathname.startsWith(`${SIMPLE_HOME}/`) ? "simple" : "studio";
}

export const homeOf = (mode: Mode) => (mode === "simple" ? SIMPLE_HOME : STUDIO_HOME);

/** Unset, viewers and commenters land in Simple, approvers and owners in Studio (owner, D13). */
export function defaultMode(role: Role | null | undefined): Mode {
  return role === "viewer" || role === "commenter" ? "simple" : "studio";
}

/** Where a person lands: their saved mode's home, else their role's; Studio while Simple is off. */
export function landingOf(simpleOn: boolean, saved: Mode | null | undefined, role: Role | null | undefined): string {
  if (!simpleOn) return STUDIO_HOME;
  return homeOf(saved ?? defaultMode(role));
}

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** Simple's pages and the Studio page each one matches (D10); the rest match the other home. */
const PAIRS: [simple: string, studio: string][] = [
  ["/simple/roadmap", "/plan"],
  ["/simple/priorities", "/priorities"],
  ["/simple/meetings", "/company/rituals"],
  ["/simple/decisions", "/company/decisions"],
];

/**
 * The page the switch lands on in the other mode: Home <-> Home, a PRD's one-pager <-> that
 * PRD's page, Roadmap <-> Plan, Priorities <-> Priorities, Meetings <-> Company › Rituals,
 * Decisions <-> Company › Decisions; anything else, the other mode's home. `documentHome`:
 * the list an open document page said it belongs to ("/documents" for a PRD), when known.
 */
export function switchTarget(pathname: string, to: Mode, documentHome?: string): string {
  if (to === modeOf(pathname)) return pathname;
  if (to === "studio") {
    const onePager = /^\/simple\/one-pagers\/([^/]+)/.exec(pathname)?.[1];
    if (onePager) return `/documents/${onePager}`;
    return PAIRS.find(([simple]) => under(pathname, simple))?.[1] ?? STUDIO_HOME;
  }
  const doc = /^\/documents\/([^/]+)/.exec(pathname)?.[1];
  // A document page of another kind (a roadmap, a strategy) has no one-pager.
  if (doc && doc !== "new" && (!documentHome || documentHome === "/documents")) return `/simple/one-pagers/${doc}`;
  return PAIRS.find(([, studio]) => under(pathname, studio))?.[0] ?? SIMPLE_HOME;
}

/** Saves the person's mode: the switch's choice, remembered across reloads and sign-ins. */
export function saveMode(mode: Mode): Promise<unknown> {
  return api.PATCH("/v1/me/preferences", { body: { experience: mode } }).catch(() => undefined);
}

/**
 * Where the signed-in person lands (after sign-in, and on `/`): reads whether Simple is on,
 * their role and their saved mode. Studio's Home when any of it cannot be read.
 */
export async function loadLanding(): Promise<string> {
  try {
    const [caps, prefs] = await Promise.all([unwrap(api.GET("/v1/me/capabilities")), unwrap(api.GET("/v1/me/preferences"))]);
    return landingOf(caps.simple_mode ?? false, prefs.experience, caps.role);
  } catch {
    return STUDIO_HOME;
  }
}
