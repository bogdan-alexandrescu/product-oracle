// home-milestones-current: Home's plan groups by the roadmap's current milestones (invented data).
import { stableUuid } from "./ids";
import { seedOwnMilestones, type MockMilestone } from "./simple-milestones";
import { seedSimpleRoadmap, type SimpleDb } from "./simple-roadmap";

export const HOME_MILESTONES_SCENARIO = "home-milestones-current";

/**
 * The default roadmaps after their milestones changed: Alerts' M1 was renamed ("Alerts for 20
 * teams" is now "Alerts live for 50 teams") and its M2 removed; Alert rules engine was placed in
 * M1 and Mobile alert push in M2 before that, so each still holds the words it was placed with
 * ("M1 · Alerts for 20 teams", a bare "M2"), as the API keeps a removed milestone's. Sample data
 * import keeps an old typed milestone ("M1 · Import first"), Onboarding's M1 by its code; Welcome
 * video types Onboarding's M1 by its name ("First alert within a day"); New plan tiers types an
 * "M4 · Old launch" no roadmap has.
 *
 * Track milestones: Alerts' undated "M2 · Launch (beta)" holds Alert history export and Alert
 * routing by team; Onboarding's "M3" (a code, no name) holds Health log; a dropped "Old pilot" (dated
 * Nov 25) holds Team invite nudges. Two PRDs each have an Onboarding "M2 · Pilot" on the same day, with
 * two goal-map features each. Eleven items are in no current milestone (QA saw "Not in a
 * milestone · 11 i…" cut at 1024).
 */
export function seedHomeMilestones(): SimpleDb {
  const rm = seedSimpleRoadmap();
  const pilot = (n: string, slug: string, title: string, gates: string[]): MockMilestone => ({
    id: stableUuid(`simple-gm/pilot-${n}`),
    roadmap: "onboarding-roadmap",
    code: "M2",
    name: "Pilot",
    date: "2026-12-11",
    goal: "faster-activation",
    gates,
    counts_when: "",
    progress: "not_started",
    prd: { slug, title, owner: "Nora Vance" },
  });
  rm.goal_milestones = [
    ...seedOwnMilestones().filter((m) => m.id !== stableUuid("simple-gm/m2")),
    pilot("a", "pilot-plan-a", "Pilot plan A", ["gm-f2", "gm-f4"]),
    pilot("b", "pilot-plan-b", "Pilot plan B", ["gm-f3", "gm-f5"]),
  ];
  const place: Record<string, NonNullable<SimpleDb["items"][number]["milestone"]>> = {
    "alert-rules": { id: stableUuid("simple-gm/m1"), name: "M1 · Alerts for 20 teams", day: null },
    "alert-mobile": { id: stableUuid("simple-gm/m2"), name: "M2", day: null },
    "setup-import": { name: "M1 · Import first", day: null },
    "setup-video": { name: "First alert within a day", day: null },
    "price-tiers": { name: "M4 · Old launch", day: null },
  };
  const records: Record<string, string> = { "alert-export": "M2 · Launch (beta)", "alert-sso": "M2 · Launch (beta)", "setup-health-log": "M3", "setup-ideas": "Old pilot" };
  rm.items = rm.items.map((s) => ({ ...s, ...(place[s.key] ? { milestone: place[s.key] } : {}), ...(records[s.key] ? { record: records[s.key] } : {}) }));
  rm.record_dropped = ["Old pilot"];
  rm.record_dates = { ...rm.record_dates, "Old pilot": "2026-11-25" };
  return rm;
}
