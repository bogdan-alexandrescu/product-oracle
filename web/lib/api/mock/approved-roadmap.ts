/**
 * approved-roadmap-to-simple: approving a roadmap version applies its plan to the roadmap's
 * items, so Simple › Roadmap reads the approved version's dates (as the API's
 * oracle.simple.approved_roadmap). The version's text carries a plan table (Key, Item, Start,
 * End, Dates from, Status) and a milestones table (Milestone, Date, Gates, Counts when).
 *
 * The "approved-roadmap" scenario (MOCK_SCENARIO_KEY): the roadmap Example trails, built from
 * the PRD Trail maps; version 2 is approved with five items on old engineering estimates
 * (Trip reports starts before Route search ends: a broken link), version 3 is in review with
 * the re-planned dates and two milestones. Invented data only.
 */
import type { Schemas } from "@/lib/api/client";
import type { SectionSeed } from "./fixtures";
import { stableUuid } from "./ids";
import { codedTitle, shownCode, shownName } from "./item-code";
import { slugOf } from "./plan-edits";
import { companyToday, roadmapKeyOf, simpleWindows, type SeedItem, type SimpleDb } from "./simple-roadmap";

export const APPROVED_ROADMAP_SCENARIO = "approved-roadmap";
/** The "crowded-milestones" scenario: Example trails with version 3 already approved and five
 * milestones in two weeks (two on Jan 15, then Jan 25, 27 and 29), for the Timeline's labels. */
export const CROWDED_MILESTONES_SCENARIO = "crowded-milestones";
/** The "photo-pins-feature" scenario: "approved-roadmap" with Photo pins linked to the Ground
 * Truth feature TR-9, so it shows TR-9 by its feature (its title stays "Photo pins"). */
export const PHOTO_PINS_FEATURE_SCENARIO = "photo-pins-feature";
export const TRAILS_SLUG = "example-trails";
export const TRAILS_TITLE = "Example trails";
export const TRAILS_PRD_SLUG = "trail-maps";
export const TRAILS_PRD_TITLE = "Trail maps";
const TRAILS_TRACK = "trails";

/** A plan row: an item's key, title, ISO start and end (none: no dates), the source words, its status. */
export interface PlanRow {
  key: string;
  title: string;
  start: string | null;
  end: string | null;
  basis: string | null;
  status: string;
}
export interface PlanMilestone {
  name: string;
  date: string | null;
  gates: string[];
  counts: string;
}
/** What the last applied version said (SimpleDb.applied, by roadmap slug). */
export interface AppliedRecord {
  version: number;
  approved_at: string;
  href: string;
  plan: PlanRow[];
  milestones: PlanMilestone[];
  shipped: string[];
  moved_out: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Dec 1, 2026" (or 2026-12-01) as an ISO day; null when it is no date. */
export function planDay(text: string): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(t);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The version's plan and milestones tables; null when its text has no plan table. */
export function parsePlan(markdown: string): { rows: PlanRow[]; milestones: PlanMilestone[] } | null {
  const rows: PlanRow[] = [];
  const milestones: PlanMilestone[] = [];
  let mode: "plan" | "milestones" | null = null;
  let cols: string[] = [];
  let sawPlan = false;
  for (const raw of markdown.split("\n")) {
    if (!raw.trim().startsWith("|")) {
      mode = null;
      continue;
    }
    const c = cells(raw);
    const lower = c.map((x) => x.toLowerCase());
    if (lower.includes("key") && lower.includes("dates from") && lower.includes("status")) {
      mode = "plan";
      cols = lower;
      sawPlan = true;
      continue;
    }
    if (lower.includes("milestone") && lower.includes("counts when")) {
      mode = "milestones";
      cols = lower;
      continue;
    }
    if (!mode || c.every((x) => /^:?-+:?$/.test(x) || !x)) continue;
    const at = (name: string) => c[cols.indexOf(name)] ?? "";
    if (mode === "plan" && at("key")) {
      rows.push({ key: at("key"), title: at("item") || at("key"), start: planDay(at("start")), end: planDay(at("end")), basis: at("dates from") || null, status: at("status").toLowerCase() });
    } else if (mode === "milestones" && at("milestone")) {
      milestones.push({ name: at("milestone"), date: planDay(at("date")), gates: at("gates").split(",").map((g) => g.trim()).filter(Boolean), counts: at("counts when") });
    }
  }
  return sawPlan ? { rows, milestones } : null;
}

const leaves = (status: string): "shipped" | "moved_out" | null =>
  status === "shipped" ? "shipped" : status.replace(/[^a-z]/g, "") === "nextprd" ? "moved_out" : null;

/** approved_roadmap._state: a plan row's state (shipped, done or launched; moved to the next PRD); null for a row still planned. */
export const planRowState = (status: string): string | null =>
  ["shipped", "done", "launched"].includes(status) ? "shipped" : leaves(status);

/** approved_roadmap._not_added: why a plan row whose title code a live item of the roadmap shows already (shownCode: its feature's,
 * its PRD section's, else its title's) adds no item, in plain words ("F-31 Launch flow was not added: F-31 is already the code of
 * F-31 Alert routing by team"); null when it is free. */
export function rowCodeTaken(db: SimpleDb, slug: string, title: string): string | null {
  const code = codedTitle(title, null)[0];
  if (!code) return null;
  const featureCode = (id: string) => db.feature_codes?.[id];
  const hit = db.items.find((x) => x.roadmap === slug && !x.trashed && shownCode(x, featureCode)?.toUpperCase() === code.toUpperCase());
  return hit ? `${title} was not added: ${code} is already the code of ${shownName(hit, featureCode)}` : null;
}

/**
 * Applies a roadmap version's plan to its Simple items: each listed item takes the version's
 * dates and their source words (a person's own typed dates stay), a shipped item and one moved
 * to the next PRD leave the plan, an unknown key is a new item; its milestones replace the
 * ones the last applied version gave. False when the text has no plan table (nothing changes).
 */
export function applyApprovedRoadmap(db: SimpleDb, slug: string, version: { number: number; approved_at: string; markdown: string; href: string }): boolean {
  const plan = parsePlan(version.markdown);
  if (!plan) return false;
  const w = simpleWindows(companyToday());
  const mine = db.items.filter((s) => s.roadmap === slug);
  const shipped: string[] = [];
  const moved: string[] = [];
  for (const row of plan.rows) {
    const s = db.items.find((x) => x.key === row.key && x.roadmap === slug);
    const gone = leaves(row.status);
    if (gone) {
      if (s) {
        db.items.splice(db.items.indexOf(s), 1);
        (gone === "shipped" ? shipped : moved).push(s.title);
      }
      continue;
    }
    if (!row.end) continue;
    const dates = { start: row.start, end: row.end, source: /engineering/i.test(row.basis ?? "") ? ("engineering" as const) : ("accepted" as const) };
    if (s) {
      const own = db.own[s.key];
      if (own?.source === "typed") continue;
      delete db.own[s.key];
      Object.assign(s, { dates, basis: row.basis ?? undefined });
      continue;
    }
    // every-field (approved_roadmap._not_added): a row whose title code a live item reads already adds no second item.
    if (rowCodeTaken(db, slug, row.title)) continue;
    const like = mine[0];
    const item: SeedItem = {
      key: row.key, title: row.title, roadmap: slug,
      horizon: row.end <= w.now[1] ? "now" : row.end <= w.next[1] ? "next" : "later",
      ...(like?.track ? { track: like.track } : {}), ...(like?.goal ? { goal: like.goal } : {}),
      dates, basis: row.basis ?? undefined,
    };
    db.items.push(item);
    db.ids[item.key] = stableUuid(`simple-item/${item.key}`);
  }
  const was = db.applied?.[slug];
  (db.applied ??= {})[slug] = {
    version: version.number, approved_at: version.approved_at, href: version.href,
    plan: plan.rows.filter((r) => !leaves(r.status)), milestones: plan.milestones,
    // Applying the same version again keeps what it moved off the plan.
    shipped: shipped.length || was?.version !== version.number ? shipped : was.shipped,
    moved_out: moved.length || was?.version !== version.number ? moved : was.moved_out,
  };
  return true;
}

/**
 * Plan changes (#346): approving the version a change set proposed makes its items the roadmap's
 * items, as Simple reads them (the API's change set writes the version's own RoadmapItem rows):
 * an added item joins in its horizon (no dates yet), a moved or deferred one changes horizon and
 * keeps its dates, a cut one leaves. A reorder changes nothing Simple shows.
 */
export function applyPlanChanges(db: SimpleDb, docSlug: string, changes: Schemas["ChangeSetOut"]["changes"]): void {
  const roadmap = roadmapKeyOf(docSlug);
  const w = simpleWindows(companyToday());
  const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
  const mine = () => db.items.filter((s) => s.roadmap === roadmap);
  for (const c of changes) {
    if (c.op === "add") {
      const key = c.key ?? slugOf(c.title);
      if (mine().some((s) => s.key === key)) continue;
      const like = mine()[0];
      db.items.push({ key, title: c.title, roadmap, horizon: c.horizon, ...(like?.track ? { track: like.track } : {}), ...(like?.goal ? { goal: like.goal } : {}) });
      db.ids[key] = stableUuid(`simple-item/${key}`);
      continue;
    }
    const s = mine().find((x) => x.key === c.key);
    if (!s) continue;
    if (c.op === "cut") db.items.splice(db.items.indexOf(s), 1);
    else if (c.op === "move" || c.op === "defer") {
      const to = c.op === "move" ? c.horizon : "later";
      // Its days count from its horizon's start: moved by the windows' gap, so its dates stay.
      const shift = days(w[s.horizon][0], w[to][0]);
      if (s.start !== undefined) s.start += shift;
      if (s.end !== undefined) s.end += shift;
      if (s.milestone?.day != null) s.milestone = { ...s.milestone, day: s.milestone.day + shift };
      s.horizon = to;
    }
  }
}

/** The applied version's milestones as Simple's milestone marks, on the track of the items they gate. */
export function appliedMilestones(db: SimpleDb, slug: string): Schemas["SimpleMilestone"][] {
  const rec = db.applied?.[slug];
  if (!rec) return [];
  const mine = db.items.filter((s) => s.roadmap === slug);
  return rec.milestones.map((m) => {
    const gated = m.gates.map((k) => mine.find((s) => s.key === k)).filter((s): s is SeedItem => !!s);
    const track = gated.find((s) => s.track)?.track ?? mine.find((s) => s.track)?.track ?? TRAILS_TRACK;
    return {
      id: stableUuid(`simple-applied-milestone/${slug}/${m.name}`), track_id: stableUuid(`simple-track/${track}`), name: m.name, date: m.date,
      horizon: "now" as const, status: "planned" as const, item_ids: gated.map((s) => db.ids[s.key]),
      start_date: null, end_date: null, effort_weeks: null, done_when: m.counts ? [m.counts] : [], targets: [],
    };
  });
}

// ---- The "approved-roadmap" scenario ----

/** The PRD's dates the roadmap's versions write, each verified by the engineering lead (TRAILS-1xx). */
export const TRAILS_BASES: [reference: string, day: string][] = [
  ["TRAILS-101", "2026-12-01"], ["TRAILS-102", "2027-01-08"], ["TRAILS-103", "2027-01-11"], ["TRAILS-104", "2027-01-22"],
  ["TRAILS-105", "2026-12-07"], ["TRAILS-106", "2026-12-18"], ["TRAILS-107", "2027-02-01"], ["TRAILS-108", "2027-03-31"],
  ["TRAILS-109", "2027-01-15"], ["TRAILS-110", "2027-01-29"],
  // Version 2's old estimates.
  ["TRAILS-091", "2026-11-02"], ["TRAILS-092", "2026-11-27"], ["TRAILS-093", "2026-11-09"], ["TRAILS-094", "2027-01-20"],
  ["TRAILS-095", "2026-12-14"], ["TRAILS-096", "2026-12-02"], ["TRAILS-097", "2026-12-30"], ["TRAILS-098", "2027-01-04"],
  ["TRAILS-099", "2027-02-26"],
];

/** Version 2's items on Simple: the old engineering estimates. */
const OLD: [key: string, title: string, start: string, end: string][] = [
  ["offline-sync", "Offline sync", "2026-11-02", "2026-11-27"],
  ["route-search", "Route search", "2026-11-09", "2027-01-20"],
  ["trip-reports", "Trip reports", "2026-12-14", "2027-01-08"],
  ["photo-pins", "Photo pins", "2026-12-02", "2026-12-30"],
  ["trail-chat", "Trail chat", "2027-01-04", "2027-02-26"],
];

const V2_PLAN = `| Key | Item | Start | End | Dates from | Status |
|---|---|---|---|---|---|
| offline-sync | Offline sync | Nov 2, 2026 | Nov 27, 2026 | engineering estimate | planned |
| route-search | Route search | Nov 9, 2026 | Jan 20, 2027 | engineering estimate | planned |
| trip-reports | Trip reports | Dec 14, 2026 | Jan 8, 2027 | engineering estimate | planned |
| photo-pins | Photo pins | Dec 2, 2026 | Dec 30, 2026 | engineering estimate | planned |
| trail-chat | Trail chat | Jan 4, 2027 | Feb 26, 2027 | engineering estimate | planned |`;

const V3_PLAN = `| Key | Item | Start | End | Dates from | Status |
|---|---|---|---|---|---|
| route-search | Route search | Dec 1, 2026 | Jan 8, 2027 | founder commitment | planned |
| trip-reports | Trip reports | Jan 11, 2027 | Jan 22, 2027 | engineering estimate | planned |
| photo-pins | Photo pins | Dec 7, 2026 | Dec 18, 2026 | set by Pat Example | planned |
| offline-sync | Offline sync | | | | shipped |
| keep-improving | TR-9 Keep improving trail maps | Feb 1, 2027 | Mar 31, 2027 | engineering estimate | new |
| trail-chat | Trail chat | | | | next PRD |`;

const V3_MILESTONES = `| Milestone | Date | Gates | Counts when |
|---|---|---|---|
| Trail beta | Jan 15, 2027 | route-search | 50 hikers use it each week |
| Trail launch | Jan 29, 2027 | route-search, trip-reports | every gated item has shipped |`;

const CROWDED_MILESTONES = `| Milestone | Date | Gates | Counts when |
|---|---|---|---|
| Trail beta | Jan 15, 2027 | route-search | 50 hikers use it each week |
| Route preview for group hikes | Jan 15, 2027 | route-search | 20 groups plan a hike with it |
| Photo pins on the map | Jan 25, 2027 | photo-pins | 100 pins a week |
| Trip reports open | Jan 27, 2027 | trip-reports | 30 reports a week |
| Trail launch | Jan 29, 2027 | route-search, trip-reports | every gated item has shipped |`;

/** The roadmap's sections for version 2 (approved) or 3 (in review); crowded: version 3 with
 * the crowded-milestones scenario's five milestones. */
export function trailSections(n: 2 | 3, crowded = false): SectionSeed[] {
  return [
    { key: "summary", level: 2, heading: "Summary", body: n === 2 ? "Trail maps for hikers, planned from the engineering estimates." : "Trail maps for hikers, re-planned: offline sync shipped, trail chat moves to the next PRD." },
    { key: "plan", level: 2, heading: "Plan", body: n === 2 ? V2_PLAN : V3_PLAN },
    ...(n === 3 ? [{ key: "milestones", level: 2, heading: "Milestones", body: crowded ? CROWDED_MILESTONES : V3_MILESTONES }] : []),
  ];
}

/** The Trail maps PRD's one version (approved). */
export const TRAILS_PRD_SECTIONS: SectionSeed[] = [
  { key: "problem", level: 2, heading: "Problem", body: "Hikers lose the trail when they have no signal and cannot share what they saw." },
  { key: "goals", level: 2, heading: "Goals", body: "More hikers plan their trips in the app each week." },
];

/** Puts Example trails on Simple: its roadmap and track, and version 2's items on their old estimates. */
export function seedTrails(db: SimpleDb): SimpleDb {
  (db.extra_roadmaps ??= {})[TRAILS_SLUG] = { title: TRAILS_TITLE, prd: TRAILS_PRD_TITLE, track: TRAILS_TRACK, track_title: "Trail maps track" };
  const w = simpleWindows(companyToday());
  for (const [key, title, start, end] of OLD) {
    db.items.push({
      key, title, roadmap: TRAILS_SLUG, track: TRAILS_TRACK, confidence: "medium",
      horizon: end <= w.now[1] ? "now" : "next",
      dates: { start, end, source: "engineering" },
      ...(key === "trip-reports" ? { depends: ["route-search"] } : {}),
    });
    db.ids[key] = stableUuid(`simple-item/${key}`);
  }
  return db;
}
