// home-milestones-current: Home's plan groups by the roadmap's current milestones (invented data).
import { stableUuid } from "./ids";
import { seedOwnMilestones, type MockMilestone } from "./simple-milestones";
import { seedSimpleRoadmap, TRACKS, type SimpleDb } from "./simple-roadmap";

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
 *
 * The review of PR 1424: Alerts' own M2 is back as "[Launch (beta)]" (its name in brackets) and
 * holds Weekly alert digest, beside the track's "M2 · Launch (beta)": one milestone, one row.
 * Onboarding's own M3 has no name and holds Setup reminders, beside the track's "M3": one row,
 * "M3". The Pricing track's "M3 · Prices live" holds Usage meter, and Annual billing (Pricing, no
 * track) types a bare "M3": Pricing's, never Onboarding's (the first "M3" found).
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
    { id: stableUuid("simple-gm/launch"), roadmap: "alerts-roadmap", code: "M2", name: "[Launch (beta)]", date: null, goal: "grow-retention", gates: ["alert-digest"], counts_when: "", progress: "not_started" },
    { id: stableUuid("simple-gm/a3"), roadmap: "onboarding-roadmap", code: "M3", name: "", date: null, goal: "faster-activation", gates: ["setup-reminders"], counts_when: "", progress: "not_started" },
  ];
  TRACKS.pricing ??= "Pricing track";
  rm.items.push(
    { key: "setup-reminders", title: "Setup reminders", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "medium" },
    { key: "price-meter", title: "Usage meter", horizon: "next", roadmap: "pricing-roadmap", track: "pricing", confidence: "medium", record: "M3 · Prices live" },
    { key: "price-annual", title: "Annual billing", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium", milestone: { name: "M3", day: null } },
  );
  for (const key of ["setup-reminders", "price-meter", "price-annual"]) rm.ids[key] = stableUuid(`simple-item/${key}`);
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

export const HOME_MILESTONE_GOALS_SCENARIO = "home-milestones-goals";

/**
 * home-milestones-goals (review of PR 1439): codes are numbered per goal, so Onboarding has two
 * goals' M1: Faster activation's "M1 · First run in a day" (Setup checklist) and Grow retention's
 * "M1 · Return pilot" (Sample data import); Welcome video, now Grow retention's, types a bare "M1".
 * The Alerts track's "M2 · Launch (beta)" (tracks are company-wide) holds Alert history export
 * (Alerts) and Partner invite links (Onboarding). Alerts' own M3 has no name and holds Alert
 * rules engine, beside the track's "M3 · Rules ready" holding Mobile alert push. Two PRDs each
 * have an Onboarding "M2 · Pilot" on the same day.
 */
export function seedHomeMilestoneGoals(): SimpleDb {
  const rm = seedHomeMilestones();
  const own = (id: string, roadmap: string, code: string, name: string, goal: string, gates: string[]): MockMilestone => ({
    id: stableUuid(`simple-gm/goals-${id}`),
    roadmap,
    code,
    name,
    date: null,
    goal,
    gates,
    counts_when: "",
    progress: "not_started",
  });
  rm.goal_milestones = [
    own("fa1", "onboarding-roadmap", "M1", "First run in a day", "faster-activation", ["setup-checklist"]),
    own("gr1", "onboarding-roadmap", "M1", "Return pilot", "grow-retention", ["setup-import"]),
    own("a3", "alerts-roadmap", "M3", "", "grow-retention", ["alert-rules"]),
    ...(rm.goal_milestones ?? []).filter((m) => m.prd),
  ];
  rm.items.push({ key: "partner-invites", title: "Partner invite links", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "alerts", confidence: "medium" });
  rm.ids["partner-invites"] = stableUuid("simple-item/partner-invites");
  const place: Record<string, NonNullable<SimpleDb["items"][number]["milestone"]>> = { "setup-video": { name: "M1", day: null } };
  const records: Record<string, string> = { "alert-export": "M2 · Launch (beta)", "partner-invites": "M2 · Launch (beta)", "alert-mobile": "M3 · Rules ready" };
  rm.items = rm.items.map((s) => {
    const rest = { ...s };
    delete rest.milestone;
    delete rest.record;
    return { ...rest, ...(place[s.key] ? { milestone: place[s.key] } : {}), ...(records[s.key] ? { record: records[s.key] } : {}), ...(s.key === "setup-video" ? { goal: "grow-retention" } : {}) };
  });
  rm.record_dropped = [];
  return rm;
}

export const HOME_MILESTONE_TRACKS_SCENARIO = "home-milestones-tracks";

/**
 * home-milestones-tracks (re-review of PR 1439): the "home-milestones-current" roadmaps, Alerts'
 * own M2 "[Launch (beta)]" kept, and Partner invite links (Onboarding, Faster activation) placed
 * in the Alerts track's "M2 · Launch (beta)" too: a track milestone is one row wherever its items
 * sit. On Pricing, two goals each have their own M3 with no name: Grow retention's holds Seat
 * bundles, Keep alerts quiet's (a goal no item carries) holds Volume discounts (no goal), beside
 * the Pricing track's "M3 · Prices live" (Usage meter); Annual billing (no goal) types a bare "M3".
 */
export function seedHomeMilestoneTracks(): SimpleDb {
  const rm = seedHomeMilestones();
  const own = (id: string, goal: string, gates: string[]): MockMilestone => ({
    id: stableUuid(`simple-gm/tracks-${id}`),
    roadmap: "pricing-roadmap",
    code: "M3",
    name: "",
    date: null,
    goal,
    gates,
    counts_when: "",
    progress: "not_started",
  });
  rm.goal_milestones = [...(rm.goal_milestones ?? []), own("gr3", "grow-retention", ["price-seats"]), own("qa3", "quiet-alerts", ["price-discounts"])];
  rm.items.push(
    { key: "partner-invites", title: "Partner invite links", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "alerts", confidence: "medium", record: "M2 · Launch (beta)" },
    { key: "price-seats", title: "Seat bundles", horizon: "next", roadmap: "pricing-roadmap", goal: "grow-retention", confidence: "medium" },
    { key: "price-discounts", title: "Volume discounts", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium" },
  );
  for (const key of ["partner-invites", "price-seats", "price-discounts"]) rm.ids[key] = stableUuid(`simple-item/${key}`);
  return rm;
}
