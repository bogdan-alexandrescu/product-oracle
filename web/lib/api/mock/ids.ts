/**
 * Ids for the mock. Seeded data takes stable ids, so the same run, document or
 * item has the same id on every page load (each fresh browser seeds the mock anew);
 * rows created later take random ones and so never collide with the seed.
 */

/**
 * A new company (the "empty" scenario, server.ts's MOCK_SCENARIO_KEY): every seed Simple
 * reads (its roadmap, plan, meetings, reviews, chat, suggestions) starts empty, as Detailed's.
 */
export const newCompany = (): boolean => typeof localStorage !== "undefined" && localStorage.getItem("po-mock-scenario") === "empty";

let scope: { label: string; seq: number } | null = null;

function fnv(text: string, basis: number): number {
  let h = basis;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A v4-shaped uuid derived from `key`: the same key always gives the same id. */
export function stableUuid(key: string): string {
  const hex = [0x811c9dc5, 0x01000193, 0x2a5f7c3d, 0x6b8e1f47]
    .map((basis) => fnv(key, basis).toString(16).padStart(8, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

let counter = 0;
/** Stable inside `seeded`, random outside it. */
export function mockUuid(): string {
  if (scope) return stableUuid(`${scope.label}#${scope.seq++}`);
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  counter += 1;
  return `00000000-0000-4000-8000-${String(Date.now() + counter).padStart(12, "0").slice(-12)}`;
}

/** Runs `seed` with stable ids, numbered from zero under `label`. */
export function seeded<T>(label: string, seed: () => T): T {
  const outer = scope;
  scope = { label: outer ? `${outer.label}/${label}` : label, seq: 0 };
  try {
    return seed();
  } finally {
    scope = outer;
  }
}

/** The id a seeded source item takes, so baseline and document fixtures can point at it. */
export const seededItemId = (sourceId: string, externalId: string) => stableUuid(`source-item/${sourceId}/${externalId}`);

/** The mock's "Product chat" source (./sources.ts), which baseline evidence and a citation use. */
export const PRODUCT_CHAT_ID = "50000000-0000-4000-8000-000000000001";

/** The localStorage key naming the mock's scenario; server.ts says what each one seeds. Here so a seed module reads it without importing server.ts. */
export const MOCK_SCENARIO_KEY = "po-mock-scenario";
