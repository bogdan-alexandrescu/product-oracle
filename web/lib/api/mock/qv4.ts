// QV4 mock-up switches: force usage-alerts-roadmap's sharing state from the page URL. // MOCK-HOOK
import type { Schemas } from "../client"; // MOCK-HOOK
// MOCK-HOOK
/** The roadmap the QV4 mock-ups are about. */ // MOCK-HOOK
export const QV4_SLUG = "usage-alerts-roadmap"; // MOCK-HOOK
// MOCK-HOOK
/** A switch from the page's URL (?mkpub=, ?mkdates=), or null. */ // MOCK-HOOK
export function qv4Param(name: string): string | null { // MOCK-HOOK
  if (typeof window === "undefined") return null; // MOCK-HOOK
  return new URLSearchParams(window.location.search).get(name); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** &mkdates=1: every date has a basis; &mkdates=0: at least one date has none. Only on the QV4 roadmap. */ // MOCK-HOOK
export function qv4Marks( // MOCK-HOOK
  slug: string, // MOCK-HOOK
  sections: { section_key: string }[], // MOCK-HOOK
  marks: Schemas["DateMarkOut"][], // MOCK-HOOK
): Schemas["DateMarkOut"][] { // MOCK-HOOK
  const mk = qv4Param("mkdates"); // MOCK-HOOK
  if (slug !== QV4_SLUG || (mk !== "0" && mk !== "1")) return marks; // MOCK-HOOK
  if (mk === "1") return marks.map((m) => ({ ...m, status: "verified" as const, label: null })); // MOCK-HOOK
  if (marks.some((m) => m.label)) return marks; // MOCK-HOOK
  const key = sections.find((s) => s.section_key !== "sources")?.section_key ?? "now"; // MOCK-HOOK
  return [...marks, { section_key: key, text: "2026-12-15", date: "2026-12-15", status: "unverified" as const, label: "unverified", bases: [], where: "body" as const }]; // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
let qv4Done = false; // MOCK-HOOK
// MOCK-HOOK
/** &mkpub=draft|approved|published, once per page load (so a click can still change it after). */ // MOCK-HOOK
export function qv4PubOnce(apply: (state: "draft" | "approved" | "published") => void) { // MOCK-HOOK
  if (qv4Done) return; // MOCK-HOOK
  qv4Done = true; // MOCK-HOOK
  const s = qv4Param("mkpub"); // MOCK-HOOK
  if (s === "draft" || s === "approved" || s === "published") apply(s); // MOCK-HOOK
} // MOCK-HOOK
