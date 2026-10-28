"use client";

import { api, ApiError, unwrap } from "@/lib/api/client";

import { DETAILED_HOME, homeOf, type Mode } from "./experience-paths";

export { DETAILED_HOME, homeOf, modeOf, SIMPLE_HOME, switchTarget, type Mode } from "./experience-paths";

/**
 * Where a person lands: their saved mode's home, else their role's default (the API's
 * `default_experience`: viewers and commenters in Simple, D13); Detailed while Simple is off.
 */
export function landingOf(simpleOn: boolean, saved: Mode | null | undefined, byRole: Mode | null | undefined): string {
  if (!simpleOn) return DETAILED_HOME;
  return homeOf(saved ?? byRole ?? "detailed");
}

/** Plain sign-in, without `next`: after it, the landing rule decides where they go. */
export const SIGN_IN = "/login";

/** Saves the person's mode: the switch's choice, remembered across reloads and sign-ins. */
export function saveMode(mode: Mode): Promise<unknown> {
  return api.PATCH("/v1/me/preferences", { body: { experience: mode } }).catch(() => undefined);
}

/**
 * Where the signed-in person lands (after sign-in, and on `/`): reads whether Simple is on,
 * their role's default mode and their saved mode. Signed out, plain sign-in (#725 review:
 * a `next` would pin them to one mode); Detailed's Home when any of it cannot be read.
 */
export async function loadLanding(): Promise<string> {
  try {
    const [caps, prefs] = await Promise.all([unwrap(api.GET("/v1/me/capabilities")), unwrap(api.GET("/v1/me/preferences"))]);
    return landingOf(caps.simple_mode ?? false, prefs.experience, caps.default_experience);
  } catch (e) {
    return e instanceof ApiError && e.status === 401 ? SIGN_IN : DETAILED_HOME;
  }
}
