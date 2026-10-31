// MOCK-HOOK: mk-runplan mock-ups only (never merged). Invented data for the decisions RP1 (how a
// run's new features get ranked) and RP2 (where a not-yet-approved PRD's dated items show).

/** The PRD the run writes (invented). */
export const MK_PRD_RP1 = { slug: "saved-addresses", title: "Saved addresses" }; // MOCK-HOOK: the priority-order scenario's PRD
/** RP2's PRD: a draft one-pager in the default scenario (invented). */
export const MK_PRD = { slug: "saved-carts", title: "Saved carts" }; // MOCK-HOOK

/** A feature the run proposes that the baseline does not have yet. */
export type MkNewFeature = { key: string; title: string; goal: string; goalTitle: string; score: number; confidence: number; reach: string; why: string; depends?: string }; // MOCK-HOOK

/** The run's new features, scored from its feature set (invented; a long name so wrapping shows). */
export const MK_NEW_FEATURES: MkNewFeature[] = [ // MOCK-HOOK
  { key: "N-1", title: "Address book per account", goal: "G1", goalTitle: "Keep teams active", score: 7.2, confidence: 0.7, reach: "All buyers", why: "Every other address feature needs the book first." }, // MOCK-HOOK
  { key: "N-2", title: "Default delivery address", goal: "G1", goalTitle: "Keep teams active", score: 5.4, confidence: 0.6, reach: "Most buyers", why: "Asked for in 14 interviews.", depends: "N-1" }, // MOCK-HOOK
  { key: "N-3", title: "Address check at checkout", goal: "G2", goalTitle: "Cut support load", score: 3.9, confidence: 0.55, reach: "All buyers", why: "Wrong addresses are the top support ticket.", depends: "N-1" }, // MOCK-HOOK
  { key: "N-4", title: "Import addresses from a spreadsheet, with a preview before saving", goal: "G1", goalTitle: "Keep teams active", score: 3.1, confidence: 0.5, reach: "Large customers", why: "Large customers keep addresses in sheets.", depends: "N-1" }, // MOCK-HOOK
  { key: "N-5", title: "Shared team addresses", goal: "G2", goalTitle: "Cut support load", score: 2.2, confidence: 0.45, reach: "Teams", why: "Teams re-type the same office address." }, // MOCK-HOOK
  { key: "N-6", title: "Address labels and notes", goal: "G3", goalTitle: "Grow paid seats", score: 1.6, confidence: 0.3, reach: "Repeat buyers", why: "A guess: no evidence yet." }, // MOCK-HOOK
]; // MOCK-HOOK

/** Where each new feature lands in the run's order when the order stop scores them (RP1 a/c done). */
export const MK_MERGED_ORDER = ["F-5", "N-1", "F-4", "N-2", "F-2", "N-3", "N-4", "F-1", "N-5", "F-7", "N-6"]; // MOCK-HOOK

/** A dated item of the run's draft roadmap (invented). */
export type MkDraftItem = { key: string; title: string; start: string; end: string; horizon: "now" | "next" | "later"; owner: string }; // MOCK-HOOK

/** The run's draft roadmap after the engineering dates stop: dated, not approved. */
export const MK_DRAFT_ITEMS: MkDraftItem[] = [ // MOCK-HOOK
  { key: "R-1", title: "Save a cart for later", start: "2026-11-09", end: "2026-12-18", horizon: "now", owner: "Priya Natarajan" }, // MOCK-HOOK
  { key: "R-2", title: "Carts kept across devices", start: "2026-12-07", end: "2027-01-22", horizon: "next", owner: "Tomás Ferreira" }, // MOCK-HOOK
  { key: "R-3", title: "Price-drop note on saved carts", start: "2027-01-11", end: "2027-02-12", horizon: "next", owner: "Priya Natarajan" }, // MOCK-HOOK
  { key: "R-4", title: "Shared carts for teams", start: "2027-01-25", end: "2027-03-19", horizon: "next", owner: "Ama Owusu" }, // MOCK-HOOK
  { key: "R-5", title: "Saved-cart reminder emails", start: "2027-03-01", end: "2027-04-16", horizon: "later", owner: "Jonas Lindqvist" }, // MOCK-HOOK
  { key: "R-6", title: "Turn a cart into a quote", start: "2027-04-05", end: "2027-05-28", horizon: "later", owner: "Ama Owusu" }, // MOCK-HOOK
]; // MOCK-HOOK

/** The months the draft spans, for the small timelines. */
export const MK_RANGE = { start: "2026-11-01", end: "2027-06-01" }; // MOCK-HOOK
