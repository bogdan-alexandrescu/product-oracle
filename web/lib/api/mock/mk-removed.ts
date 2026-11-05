// MOCK-HOOK mk-edit-tasks-restore: the "mk-edit-tasks" scenario's invented data: tasks under
// "Weekly alert digest", cut features, an archived goal and removed goal milestones. Mock-ups only.
import type { seedSimpleRoadmap } from "./simple-roadmap"; // MOCK-HOOK
type SimpleDb = ReturnType<typeof seedSimpleRoadmap>; // MOCK-HOOK

export const MK_SCENARIO = "mk-edit-tasks"; // MOCK-HOOK

/** MOCK-HOOK: what was removed, by whom and when (the API's change log would say it). */
export type MkRemoved = { id: string; kind: "feature" | "goal" | "milestone"; key: string; title: string; where: string; by: string; at: string; how: "cut" | "archived" | "removed" | "deleted"; days_left?: number }; // MOCK-HOOK
export const MK_REMOVED: MkRemoved[] = [
  { id: "r1", kind: "feature", key: "alert-sso", title: "Alert routing by team", where: "Alerts roadmap", by: "Priya Raman", at: "2026-10-21T16:12:00Z", how: "cut" },
  { id: "r2", kind: "feature", key: "setup-tour", title: "In-app tour", where: "Onboarding roadmap", by: "Avery Stone", at: "2026-10-14T10:05:00Z", how: "cut" },
  { id: "r3", kind: "feature", key: "setup-video", title: "Welcome video", where: "Onboarding roadmap", by: "Avery Stone", at: "2026-10-08T09:40:00Z", how: "cut" },
  { id: "r4", kind: "goal", key: "g-quiet", title: "Fewer support tickets about billing", where: "Goals", by: "Priya Raman", at: "2026-10-19T14:30:00Z", how: "archived" },
  { id: "r5", kind: "milestone", key: "m-beta", title: "Private beta for 20 teams", where: "Grow retention", by: "Avery Stone", at: "2026-10-20T11:20:00Z", how: "removed" },
  { id: "r6", kind: "milestone", key: "m-pilot", title: "Pilot with the first five teams in Europe and the Americas", where: "Faster activation", by: "Priya Raman", at: "2026-10-16T17:45:00Z", how: "removed" },
  { id: "r7", kind: "feature", key: "price-annual", title: "Annual billing toggle", where: "Pricing roadmap", by: "Avery Stone", at: "2026-10-05T08:15:00Z", how: "deleted", days_left: 14 },
]; // MOCK-HOOK

/** MOCK-HOOK: the scenario's roadmap: the cut features cut, and eight tasks under the digest. */
export function mkSeed(db: SimpleDb, people: { id: string; name?: string | null }[]): SimpleDb {
  for (const r of MK_REMOVED) if (r.kind === "feature" && r.how === "cut") {
    const s = db.items.find((x) => x.key === r.key);
    if (s) (s as { status?: string }).status = "cut";
  }
  const item_id = db.ids["alert-digest"];
  const tasks: [string, string, string | null, string | null, string | null][] = [
    ["Write the digest email copy", "done", "Priya Raman", "2026-10-15", "t1"],
    ["Pick which alerts make the digest", "done", "Avery Stone", "2026-10-20", "t2"],
    ["Build the weekly send job", "doing", "Theo Brandt", "2026-10-27", "t3"],
    ["Add an unsubscribe link to each digest", "doing", null, "2026-10-30", "t4"],
    ["Test the digest with three pilot teams across two time zones and both plans", "todo", "Priya Raman", "2026-11-04", "t5"],
    ["Check how it reads on a phone", "todo", null, null, "t6"],
    ["Ask support what teams ask about most", "todo", "Lena Ortiz", "2026-11-06", "t7"],
    ["Write the help page", "todo", null, "2026-11-12", "t8"],
  ];
  db.targets ??= {};
  tasks.forEach(([title, status, owner, due, id], i) => {
    db.targets![`mk-task-${id}`] = { kind: "item_task", item_id, title, status, owner_id: owner ? (people.find((p) => p.name === owner)?.id ?? null) : null, owner_name: owner, due_date: due, at: `2026-10-0${i + 1}T09:00:00Z` };
  });
  return db;
}
