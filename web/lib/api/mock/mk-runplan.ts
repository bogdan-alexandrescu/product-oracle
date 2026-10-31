// MOCK-HOOK: mk-runplan mock-ups only (never merged). Invented data for the decisions RP1 (how a
// run's new features get ranked) and RP2 (where a not-yet-approved PRD's dated items show). // MOCK-HOOK

/** The PRD the run writes (invented). */ // MOCK-HOOK
export const MK_PRD_RP1 = { slug: "saved-addresses", title: "Saved addresses" }; // MOCK-HOOK: the priority-order scenario's PRD
/** The next PRD whose run proposes an order after Saved addresses is approved (RP1 d, invented). */ // MOCK-HOOK
export const MK_NEXT_PRD = { slug: "delivery-slots", title: "Delivery slots" }; // MOCK-HOOK
/** RP2's PRD: a draft one-pager in the default scenario (invented). */ // MOCK-HOOK
export const MK_PRD = { slug: "saved-carts", title: "Saved carts" }; // MOCK-HOOK

/** A feature the run proposes that the baseline does not have yet. */ // MOCK-HOOK
export type MkNewFeature = { key: string; title: string; goalTitle: string; weight: number; contribution: number; effort: number; score: number; confidence: number; reach: string; why: string; depends?: string }; // MOCK-HOOK

/** The run's new features, scored on the baseline's own formula (goal weight × contribution × confidence ÷ effort) and goals (invented; a long name so wrapping shows). */ // MOCK-HOOK
export const MK_NEW_FEATURES: MkNewFeature[] = [ // MOCK-HOOK
  { key: "N-1", title: "Address book per account", goalTitle: "Raise activation", weight: 3, contribution: 2, effort: 1, score: 4.2, confidence: 0.7, reach: "All buyers", why: "Every other address feature needs the book first." }, // MOCK-HOOK
  { key: "N-2", title: "Default delivery address", goalTitle: "Raise activation", weight: 3, contribution: 3, effort: 2, score: 2.7, confidence: 0.6, reach: "Most buyers", why: "Asked for in 14 interviews.", depends: "N-1" }, // MOCK-HOOK
  { key: "N-3", title: "Address check at checkout", goalTitle: "Grow paid conversion", weight: 2, contribution: 2, effort: 1, score: 2.4, confidence: 0.6, reach: "All buyers", why: "Wrong addresses are the top reason a paid order fails.", depends: "N-1" }, // MOCK-HOOK
  { key: "N-4", title: "Import addresses from a spreadsheet, with a preview before saving", goalTitle: "Raise activation", weight: 3, contribution: 2, effort: 2, score: 1.8, confidence: 0.6, reach: "Large customers", why: "Large customers keep addresses in sheets.", depends: "N-1" }, // MOCK-HOOK
  { key: "N-5", title: "Shared team addresses", goalTitle: "Grow paid conversion", weight: 2, contribution: 1, effort: 1, score: 1.2, confidence: 0.6, reach: "Teams", why: "Teams re-type the same office address." }, // MOCK-HOOK
  { key: "N-6", title: "Address labels and notes", goalTitle: "Grow paid conversion", weight: 2, contribution: 3, effort: 4, score: 0.45, confidence: 0.3, reach: "Repeat buyers", why: "A guess: no evidence yet." }, // MOCK-HOOK
]; // MOCK-HOOK

/** Where each new feature lands in the run's order when the order stop scores them (RP1 a/c done): by score after the two rows the run placed on purpose. */ // MOCK-HOOK
export const MK_MERGED_ORDER = ["F-5", "F-4", "F-2", "N-1", "N-2", "N-3", "F-1", "N-4", "N-5", "F-7", "N-6"]; // MOCK-HOOK

/** A dated item of the run's draft roadmap (invented). */ // MOCK-HOOK
export type MkDraftItem = { key: string; title: string; start: string; end: string; horizon: "now" | "next" | "later"; owner: string }; // MOCK-HOOK

/** The run's draft roadmap after the engineering dates stop: dated, not approved. */ // MOCK-HOOK
export const MK_DRAFT_ITEMS: MkDraftItem[] = [ // MOCK-HOOK
  { key: "R-1", title: "Save a cart for later", start: "2026-11-09", end: "2026-12-18", horizon: "now", owner: "Priya Natarajan" }, // MOCK-HOOK
  { key: "R-2", title: "Carts kept across devices", start: "2026-12-07", end: "2027-01-22", horizon: "next", owner: "Tomás Ferreira" }, // MOCK-HOOK
  { key: "R-3", title: "Price-drop note on saved carts", start: "2027-01-11", end: "2027-02-12", horizon: "next", owner: "Priya Natarajan" }, // MOCK-HOOK
  { key: "R-4", title: "Shared carts for teams", start: "2027-01-25", end: "2027-03-19", horizon: "next", owner: "Ama Owusu" }, // MOCK-HOOK
  { key: "R-5", title: "Saved-cart reminder emails", start: "2027-03-01", end: "2027-04-16", horizon: "later", owner: "Jonas Lindqvist" }, // MOCK-HOOK
  { key: "R-6", title: "Turn a cart into a quote", start: "2027-04-05", end: "2027-05-28", horizon: "later", owner: "Ama Owusu" }, // MOCK-HOOK
]; // MOCK-HOOK

/** The months the draft spans, for the small timelines. */ // MOCK-HOOK
export const MK_RANGE = { start: "2026-11-01", end: "2027-06-01" }; // MOCK-HOOK
