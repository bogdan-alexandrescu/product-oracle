// MOCK-HOOK (whole file): mk-panel-menu mock-ups only. Features and goals sent to Trash from the
// feature panel's menu and from a goal's menu, kept in localStorage; invented people and names.

export type MkTrash = {
  id: string;
  kind: "Feature" | "Goal";
  title: string;
  /** The roadmap (a feature) it was on. */
  where: string;
  key?: string;
  by: string;
  at: string;
  days_left: number;
  /** What Restore puts back, in words. */
  back: string[];
};

const KEY = "mk-trash"; // MOCK-HOOK

/** The mock company's owner, who decides a restore an approver proposes (invented). */
export const MK_OWNER = "Avery Stone"; // MOCK-HOOK

const SEED: MkTrash[] = [ // MOCK-HOOK
  { id: "t-f1", kind: "Feature", title: "Saved filters for alerts", where: "Usage alerts", by: "Priya Shah", at: "2026-11-04T16:20:00Z", days_left: 29, back: ["Dates Nov 16 – Dec 18", "2 links", "Milestone: Beta", "Goal: Grow retention"] },
  { id: "t-g1", kind: "Goal", title: "Cut support tickets by a fifth", where: "Goals", by: "Ana Ortiz", at: "2026-11-03T10:05:00Z", days_left: 28, back: ["Its measure: tickets a week", "3 features linked to it again"] },
  { id: "t-f2", kind: "Feature", title: "Quiet hours for alert push", where: "Usage alerts", by: "Ana Ortiz", at: "2026-11-02T14:40:00Z", days_left: 27, back: ["Dates Dec 1 – Jan 9, 2027", "1 link", "Milestone: None", "Goal: Grow retention"] },
  { id: "t-f3", kind: "Feature", title: "Import from spreadsheets with column matching and saved maps", where: "Guided setup", by: "Liam Brooks", at: "2026-10-30T09:12:00Z", days_left: 24, back: ["Dates Nov 9 – Dec 4", "3 links", "Milestone: Launch", "Goal: Faster activation"] },
  { id: "t-f4", kind: "Feature", title: "Team leaderboard", where: "Guided setup", by: "Priya Shah", at: "2026-10-27T11:30:00Z", days_left: 21, back: ["Dates Jan 5 – Feb 12, 2027", "No links", "Milestone: None", "Goal: None"] },
  { id: "t-g2", kind: "Goal", title: "Win back paused accounts", where: "Goals", by: "Priya Shah", at: "2026-10-22T08:45:00Z", days_left: 16, back: ["Its measure: accounts back a month", "1 feature linked to it again"] },
  { id: "t-f5", kind: "Feature", title: "Alert sound picker", where: "Usage alerts", by: "Liam Brooks", at: "2026-10-18T15:02:00Z", days_left: 12, back: ["Dates Nov 30 – Dec 11", "No links", "Milestone: None", "Goal: Grow retention"] },
  { id: "t-f6", kind: "Feature", title: "Plan compare page", where: "Pricing", by: "Ana Ortiz", at: "2026-10-12T13:00:00Z", days_left: 6, back: ["Dates Dec 7 – Jan 22, 2027", "1 link", "Milestone: Pricing launch", "Goal: None"] },
  { id: "t-f7", kind: "Feature", title: "Holiday theme for the welcome email", where: "Welcome media", by: "Priya Shah", at: "2026-10-08T10:10:00Z", days_left: 2, back: ["Dates Dec 1 – Dec 12", "No links", "Milestone: None", "Goal: None"] },
];

const ls = () => (typeof localStorage === "undefined" ? null : localStorage); // MOCK-HOOK

export function mkTrash(): MkTrash[] { // MOCK-HOOK
  const raw = ls()?.getItem(KEY);
  return raw ? (JSON.parse(raw) as MkTrash[]) : SEED;
}

export function mkSaveTrash(rows: MkTrash[]): void { // MOCK-HOOK
  ls()?.setItem(KEY, JSON.stringify(rows));
}

/** The roadmap items' keys in Trash: the mock roadmap leaves them out. */
export function mkDeletedKeys(): string[] { // MOCK-HOOK
  return mkTrash().flatMap((t) => (t.key ? [t.key] : []));
}

/** Who cut a feature and when, as the panel shows it (the seed's cut item has its own). */
export function mkCutBy(key: string): { by: string; at: string } { // MOCK-HOOK
  const raw = ls()?.getItem(`mk-cut-${key}`);
  return raw ? JSON.parse(raw) : { by: "Liam Brooks", at: "2026-11-02" };
}

export function mkSetCutBy(key: string, by: string, at: string): void { // MOCK-HOOK
  ls()?.setItem(`mk-cut-${key}`, JSON.stringify({ by, at }));
}

/** Deleted documents beside the features and goals, so Trash reads as it will (invented). */
export const MK_DOCS = [ // MOCK-HOOK
  { id: "t-d1", root: { type: "document" as const, id: "d1", slug: "team-alerts-prd", title: "Team alerts PRD", kind: "prd" }, items: [{ type: "document" as const, id: "d1s", slug: null, title: "Team alerts tech brief", kind: "spec" }], deleted_by: null, deleted_by_name: "Ana Ortiz", deleted_at: "2026-11-01T12:30:00Z", reason: null, published: false, purge_after: "2026-12-01T12:30:00Z", days_left: 26 },
  { id: "t-d2", root: { type: "document" as const, id: "d2", slug: "q3-update", title: "Q3 update for the board", kind: "update" }, items: [], deleted_by: null, deleted_by_name: "Liam Brooks", deleted_at: "2026-10-25T09:00:00Z", reason: null, published: true, purge_after: "2026-11-24T09:00:00Z", days_left: 19 },
  { id: "t-d3", root: { type: "document" as const, id: "d3", slug: "old-onboarding-roadmap", title: "Old onboarding roadmap", kind: "roadmap" }, items: [], deleted_by: null, deleted_by_name: "Priya Shah", deleted_at: "2026-10-10T16:45:00Z", reason: null, published: false, purge_after: "2026-11-09T16:45:00Z", days_left: 4 },
];
