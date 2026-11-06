/**
 * one-roadmap-many-prds (the owner, Nov 4: the company has ONE roadmap, never one per PRD): the
 * company roadmap (Product roadmap) that every PRD feeds, as api/oracle/roadmap/company serves it.
 *
 * The "one-roadmap" scenario (MOCK_SCENARIO_KEY): the default company plus the area PRDs User
 * Safety and Scale, whose items sit on the one Product roadmap; the older PRD Trust plan, replaced
 * by both (read-only, its items no longer on the roadmap); and Trust plan's own older roadmap,
 * kept as history (its one item never on Simple). Invented data only.
 */
import type { Schemas } from "@/lib/api/client";
import { stableUuid } from "./ids";
import type { SeedItem, SimpleDb } from "./simple-roadmap";

export const ONE_ROADMAP_SCENARIO = "one-roadmap";
/** old-milestones: "one-roadmap" with goal milestones still on the older Trust plan roadmap. */
export const OLD_MILESTONES_SCENARIO = "old-milestones";
export const COMPANY_SLUG = "product-roadmap";
export const COMPANY_TITLE = "Product roadmap";
/** The area PRDs that feed it (slug, title), and the PRD they replace. */
export const AREA_PRDS: [slug: string, title: string][] = [
  ["user-safety", "User Safety"],
  ["scale", "Scale"],
];
export const OLD_PRD: [slug: string, title: string] = ["trust-plan", "Trust plan"];
export const OLD_ROADMAP: [slug: string, title: string] = ["trust-plan-roadmap", "Trust plan roadmap"];

export const prdRef = (slug: string, title: string): Schemas["SimpleDocRef"] => ({ id: stableUuid(`simple-prd/${slug}`), slug, title });

const [SAFETY, SCALE] = AREA_PRDS.map(([slug, title]) => prdRef(slug, title));

/** The company roadmap's items: two PRDs' items on one roadmap (days from the quarter's start). */
const ITEMS: SeedItem[] = [
  { key: "report-button", title: "Report button on every post", horizon: "now", roadmap: COMPANY_SLUG, prd_doc: SAFETY, confidence: "high", start: 7, end: 30, source: "engineering" },
  { key: "block-list", title: "Block list", horizon: "now", roadmap: COMPANY_SLUG, prd_doc: SAFETY, confidence: "medium", start: 31, end: 55, source: "engineering", depends: ["report-button"] },
  { key: "read-replicas", title: "Read replicas in two regions", horizon: "now", roadmap: COMPANY_SLUG, prd_doc: SCALE, confidence: "medium", start: 14, end: 48, source: "engineering" },
  { key: "queue-backpressure", title: "Queue backpressure", horizon: "now", roadmap: COMPANY_SLUG, prd_doc: SCALE, confidence: "low", start: 49, end: 70, source: "engineering" },
];

/** An item only Trust plan's older roadmap holds: history, never on Simple. */
export const OLD_ITEM = "Trusted seller badge";
const OLD_ITEMS: SeedItem[] = [
  { key: "trusted-badge", title: OLD_ITEM, horizon: "now", roadmap: OLD_ROADMAP[0], prd_doc: prdRef(...OLD_PRD), confidence: "high", start: 3, end: 20, source: "engineering" },
];

/** Puts the company roadmap's items on Simple, in place of the per-PRD roadmaps' (history now). */
export function seedCompanyRoadmap(db: SimpleDb): SimpleDb {
  db.extra_roadmaps = {
    [COMPANY_SLUG]: { title: COMPANY_TITLE, prd: SAFETY.title, track: "safety", track_title: "User Safety track" },
    [OLD_ROADMAP[0]]: { title: OLD_ROADMAP[1], prd: OLD_PRD[1], track: "trust", track_title: "Trust track" },
  };
  // The company roadmap alone feeds Simple (api/oracle/roadmap/company.feeding_ids).
  db.company_roadmap = COMPANY_SLUG;
  const all = [...ITEMS, ...OLD_ITEMS];
  db.items = all.map((s) => ({ ...s }));
  db.ids = Object.fromEntries(all.map((s) => [s.key, stableUuid(`simple-item/${s.key}`)]));
  db.own = {};
  db.suggestions = [];
  db.decisions = {};
  db.key_dates = {};
  return db;
}
