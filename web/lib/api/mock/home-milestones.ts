// home-milestones-current: Home's plan groups by the roadmap's current milestones (invented data).
import { stableUuid } from "./ids";
import { seedOwnMilestones } from "./simple-milestones";
import { seedSimpleRoadmap, type SimpleDb } from "./simple-roadmap";

export const HOME_MILESTONES_SCENARIO = "home-milestones-current";

/**
 * The default roadmaps after their milestones changed: Alerts' M1 was renamed ("Alerts for 20
 * teams" is now "Alerts live for 50 teams") and its M2 removed; Alert rules engine was placed in
 * M1 and Mobile alert push in M2 before that, so each still holds the words it was placed with
 * ("M1 · Alerts for 20 teams", a bare "M2"), as the API keeps a removed milestone's. Sample data
 * import keeps an old typed milestone ("M1 · Import first") no roadmap has any more.
 */
export function seedHomeMilestones(): SimpleDb {
  const rm = seedSimpleRoadmap();
  rm.goal_milestones = seedOwnMilestones().filter((m) => m.id !== stableUuid("simple-gm/m2"));
  const place: Record<string, NonNullable<SimpleDb["items"][number]["milestone"]>> = {
    "alert-rules": { id: stableUuid("simple-gm/m1"), name: "M1 · Alerts for 20 teams", day: null },
    "alert-mobile": { id: stableUuid("simple-gm/m2"), name: "M2", day: null },
    "setup-import": { name: "M1 · Import first", day: null },
  };
  rm.items = rm.items.map((s) => (place[s.key] ? { ...s, milestone: place[s.key] } : s));
  return rm;
}
