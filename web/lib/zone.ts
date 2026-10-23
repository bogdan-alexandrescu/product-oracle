/**
 * The zone display dates are shown in (#447): the Company time zone, once GET /v1/me has
 * answered (MeProvider sets it), America/Los_Angeles until then. Plain formatters
 * (lib/format.ts) read it here, as they cannot call a hook.
 */

export const DEFAULT_ZONE = "America/Los_Angeles";

let current = DEFAULT_ZONE;

/** The Company time zone, for a formatter outside a component. */
export const displayZone = (): string => current;

export function setDisplayZone(zone: string | null | undefined): void {
  current = zone || DEFAULT_ZONE;
}
