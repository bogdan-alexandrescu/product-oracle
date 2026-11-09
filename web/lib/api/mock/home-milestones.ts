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
    prd: { slug, title },
  });
  rm.goal_milestones = [
    ...seedOwnMilestones().filter((m) => m.id !== stableUuid("simple-gm/m2")),
    pilot("a", "pilot-plan-a", "Pilot plan A", ["gm-f2", "gm-f4"]),
    pilot("b", "pilot-plan-b", "Pilot plan B", ["gm-f3", "gm-f5"]),
    { id: stableUuid("simple-gm/launch"), roadmap: "alerts-roadmap", code: "M2", name: "[Launch (beta)]", date: null, goal: "grow-retention", gates: ["alert-digest"], counts_when: "", progress: "not_started" },
    { id: stableUuid("simple-gm/a3"), roadmap: "onboarding-roadmap", code: "M3", name: "", date: null, goal: "faster-activation", gates: ["setup-reminders"], counts_when: "", progress: "not_started" },
  ];
  TRACKS.pricing ??= "Pricing track";
  // Pilot plan A's own track (no item on it yet): its owner (server.ts) is the PRD's owner.
  TRACKS.pilot ??= "Pilot track";
  (rm as SimpleDb & { track_state?: Record<string, { status: string; prd: string }> }).track_state = { pilot: { status: "active", prd: "Pilot plan A" } };
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
 * rules engine, beside the track's "M3 · Rules ready" holding Mobile alert push.
 *
 * The reviews of PR 1439 (the PRDs' two "M2 · Pilot" left out, so every row fits Home's eight):
 * Usage report and Usage map (Keep alerts quiet, a goal with no M1, on the Alerts track) type "M1"
 * and "M1 Measured and mapped" on Onboarding, whose two other goals each have an M1; the
 * Onboarding track's "M1 · Measured" holds Health log. Alerts' own M2 "[Fleet pilot]" (Grow
 * retention, Nov 18, Alerts' only M2) holds Alert routing by team, beside the Alerts track's
 * "M2 · Launch (beta)"; Alert sound settings (Faster activation, no M2 of its own) types "M2".
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
    { ...own("gr2", "alerts-roadmap", "M2", "[Fleet pilot]", "grow-retention", ["alert-sso"]), date: "2026-11-18" },
  ];
  rm.items.push(
    { key: "partner-invites", title: "Partner invite links", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "alerts", confidence: "medium" },
    { key: "usage-report", title: "Usage report", horizon: "next", roadmap: "onboarding-roadmap", goal: "quiet-alerts", track: "alerts", confidence: "medium" },
    { key: "usage-map", title: "Usage map", horizon: "next", roadmap: "onboarding-roadmap", goal: "quiet-alerts", track: "alerts", confidence: "medium" },
    { key: "alert-sounds", title: "Alert sound settings", horizon: "next", roadmap: "alerts-roadmap", goal: "faster-activation", track: "alerts", confidence: "medium" },
  );
  for (const key of ["partner-invites", "usage-report", "usage-map", "alert-sounds"]) rm.ids[key] = stableUuid(`simple-item/${key}`);
  const place: Record<string, NonNullable<SimpleDb["items"][number]["milestone"]>> = {
    "setup-video": { name: "M1", day: null },
    "usage-report": { name: "M1", day: null },
    "usage-map": { name: "M1 Measured and mapped", day: null },
    "alert-sounds": { name: "M2", day: null },
  };
  const records: Record<string, string> = { "alert-export": "M2 · Launch (beta)", "partner-invites": "M2 · Launch (beta)", "alert-mobile": "M3 · Rules ready", "setup-health-log": "M1 · Measured" };
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
 *
 * The reviews of PR 1439 (the PRDs' two "M2 · Pilot" and the M1s left out, so every row fits
 * Home's eight): a third goal's M3 with no name on Pricing, Fewer refunds' (a goal no item
 * carries), holds Refund rules, so two look-alike M3 rows have no goal a loaded item names. The
 * Onboarding track's "M3" (no name) holds Health log (Onboarding) and Alert snooze (Alerts);
 * Onboarding's only M3 is "M3 · Guided tour" (Setup reminders), Alerts' only M3 "M3 · Quiet
 * hours" (Mobile alert push).
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
  const gone = ["a3", "m1", "a1"].map((k) => stableUuid(`simple-gm/${k}`));
  rm.goal_milestones = [
    ...(rm.goal_milestones ?? []).filter((m) => !m.prd && !gone.includes(m.id)),
    own("gr3", "grow-retention", ["price-seats"]),
    own("qa3", "quiet-alerts", ["price-discounts"]),
    own("fr3", "fewer-refunds", ["price-refunds"]),
    { ...own("tour", "faster-activation", ["setup-reminders"]), roadmap: "onboarding-roadmap", name: "Guided tour" },
    { ...own("quiet", "grow-retention", ["alert-mobile"]), roadmap: "alerts-roadmap", name: "Quiet hours" },
  ];
  rm.items.push(
    { key: "partner-invites", title: "Partner invite links", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "alerts", confidence: "medium", record: "M2 · Launch (beta)" },
    { key: "price-seats", title: "Seat bundles", horizon: "next", roadmap: "pricing-roadmap", goal: "grow-retention", confidence: "medium" },
    { key: "price-discounts", title: "Volume discounts", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium" },
    { key: "price-refunds", title: "Refund rules", horizon: "next", roadmap: "pricing-roadmap", confidence: "medium" },
    { key: "alert-snooze", title: "Alert snooze", horizon: "next", roadmap: "alerts-roadmap", goal: "grow-retention", track: "onboarding", confidence: "medium", record: "M3" },
  );
  for (const key of ["partner-invites", "price-seats", "price-discounts", "price-refunds", "alert-snooze"]) rm.ids[key] = stableUuid(`simple-item/${key}`);
  return rm;
}

export const HOME_MILESTONE_TWIN_TRACKS_SCENARIO = "home-milestones-twin-tracks";

/**
 * home-milestones-twin-tracks (review of PR 1453): two tracks share a code. The Guided setup
 * track's "M1 · Measured" (Health log, Onboarding; Alert snooze, Alerts) and the Welcome media
 * track's "M1 · Other" (Welcome tips, Onboarding; Alert sounds, Alerts) are on both roadmaps.
 * On Onboarding, Usage report (Usage alerts track, which has no M1) and Setup FAQ (no track)
 * type "M1", and Onboarding has no M1 of its own. On Alerts, Alert badges (Pricing track, no M1)
 * types "M1", and Alerts has its own M1 of no goal, "M1 · First alerts" (Alert rules engine).
 */
export function seedHomeMilestoneTwinTracks(): SimpleDb {
  const rm = seedSimpleRoadmap();
  TRACKS.pricing ??= "Pricing track";
  rm.goal_milestones = [
    { id: stableUuid("simple-gm/twin-first"), roadmap: "alerts-roadmap", code: "M1", name: "First alerts", date: null, goal: null, gates: ["alert-rules"], counts_when: "", progress: "not_started" },
  ];
  rm.items.push(
    { key: "welcome-tips", title: "Welcome tips", horizon: "next", roadmap: "onboarding-roadmap", track: "welcome", confidence: "medium", record: "M1 · Other" },
    { key: "usage-report", title: "Usage report", horizon: "next", roadmap: "onboarding-roadmap", track: "alerts", confidence: "medium", milestone: { name: "M1", day: null } },
    { key: "setup-faq", title: "Setup FAQ", horizon: "next", roadmap: "onboarding-roadmap", confidence: "medium", milestone: { name: "M1", day: null } },
    { key: "alert-snooze", title: "Alert snooze", horizon: "next", roadmap: "alerts-roadmap", track: "onboarding", confidence: "medium", record: "M1 · Measured" },
    { key: "alert-sounds", title: "Alert sounds", horizon: "next", roadmap: "alerts-roadmap", track: "welcome", confidence: "medium", record: "M1 · Other" },
    { key: "alert-badges", title: "Alert badges", horizon: "next", roadmap: "alerts-roadmap", track: "pricing", confidence: "medium", milestone: { name: "M1", day: null } },
  );
  for (const key of ["welcome-tips", "usage-report", "setup-faq", "alert-snooze", "alert-sounds", "alert-badges"]) rm.ids[key] = stableUuid(`simple-item/${key}`);
  rm.items = rm.items.map((s) => (s.key === "setup-health-log" ? { ...s, record: "M1 · Measured" } : s));
  return rm;
}

export const HOME_MILESTONE_FOLD_SCENARIO = "home-milestones-fold";

/**
 * home-milestones-fold (the owner's of Nov 9): Onboarding's own M1 of no goal, "M1 Measured and
 * mapped", holds Setup checklist and Sample data import, beside the Guided setup track's
 * "M1 · Measured" (Health log): one row, the track's name and date, the other name in its (i).
 * Grow retention's "M1 · Return pilot" (Welcome video) is a goal's milestone: its own row.
 */
export function seedHomeMilestoneFold(): SimpleDb {
  const rm = seedSimpleRoadmap();
  rm.goal_milestones = [
    { id: stableUuid("simple-gm/fold-mapped"), roadmap: "onboarding-roadmap", code: "M1", name: "M1 Measured and mapped", date: null, goal: null, gates: ["setup-checklist", "setup-import"], counts_when: "", progress: "not_started" },
    { id: stableUuid("simple-gm/fold-pilot"), roadmap: "onboarding-roadmap", code: "M1", name: "Return pilot", date: null, goal: "grow-retention", gates: ["setup-video"], counts_when: "", progress: "not_started" },
  ];
  rm.items = rm.items.map((s) => (s.key === "setup-health-log" ? { ...s, record: "M1 · Measured" } : s.key === "setup-video" ? { ...s, goal: "grow-retention" } : s));
  return rm;
}

export const HOME_MILESTONE_PRD_FOLD_SCENARIO = "home-milestones-prd-fold";

/**
 * home-milestones-prd-fold (the owner's "One M1 row, as after train AX"): the Setup guide PRD's
 * own dated M1 of no goal, "Measured" (Nov 20), holds Setup checklist and Sample data import,
 * beside the Guided setup track's undated "M1 · Measured and mapped" (Health log): one row, the
 * track's name and the PRD's date, the PRD's name in its (i).
 */
export function seedHomeMilestonePrdFold(): SimpleDb {
  const rm = seedSimpleRoadmap();
  const prd = { slug: "setup-guide", title: "Setup guide" };
  rm.goal_milestones = [
    { id: stableUuid("simple-gm/prd-fold-measured"), roadmap: "onboarding-roadmap", code: "M1", name: "Measured", date: "2026-11-20", goal: null, gates: ["setup-checklist", "setup-import"], counts_when: "", progress: "not_started", prd },
  ];
  rm.items = rm.items.map((s) => (s.key === "setup-health-log" ? { ...s, record: "M1 · Measured and mapped" } : s));
  return rm;
}

export const HOME_MILESTONE_PRD_GOAL_FOLD_SCENARIO = "home-milestones-prd-goal-fold";

/**
 * home-milestones-prd-goal-fold (the owner's "One M1 row" and "Keep joining when names match"):
 * the Setup guide PRD's own M1 "Measured" under Faster activation (Nov 20) holds Setup checklist
 * and Sample data import, beside the Guided setup track's "M1 · Measured and mapped" (Health
 * log): its words lead the track's name, so one row, the PRD's name in its (i). Faster
 * activation's "M3 · Daily scoreboard" (Team digest) beside the track's "M3 · 200 replied
 * threads" (Reply tracker): names that do not match, two rows.
 */
export function seedHomeMilestonePrdGoalFold(): SimpleDb {
  const rm = seedSimpleRoadmap();
  const prd = { slug: "setup-guide", title: "Setup guide" };
  rm.goal_milestones = [
    { id: stableUuid("simple-gm/prd-goal-fold-measured"), roadmap: "onboarding-roadmap", code: "M1", name: "Measured", date: "2026-11-20", goal: "faster-activation", gates: ["setup-checklist", "setup-import"], counts_when: "", progress: "not_started", prd },
    { id: stableUuid("simple-gm/prd-goal-fold-scoreboard"), roadmap: "onboarding-roadmap", code: "M3", name: "Daily scoreboard", date: null, goal: "faster-activation", gates: ["setup-digest"], counts_when: "", progress: "not_started" },
  ];
  rm.items.push(
    { key: "setup-digest", title: "Team digest", horizon: "next", roadmap: "onboarding-roadmap", goal: "faster-activation", track: "onboarding", confidence: "medium" },
    { key: "setup-replies", title: "Reply tracker", horizon: "next", roadmap: "onboarding-roadmap", track: "onboarding", confidence: "medium", record: "M3 · 200 replied threads" },
  );
  for (const key of ["setup-digest", "setup-replies"]) rm.ids[key] = stableUuid(`simple-item/${key}`);
  rm.items = rm.items.map((s) => (s.key === "setup-health-log" ? { ...s, record: "M1 · Measured and mapped" } : s));
  return rm;
}

export const HOME_MILESTONE_PRDS_FOLD_SCENARIO = "home-milestones-prds-fold";

/**
 * home-milestones-prds-fold (review of PR 1489): two PRDs' own M1 of no goal on Onboarding, Setup
 * guide's "Measured" (Nov 20, Setup checklist) and Import guide's "Mapped" (Nov 12, Sample data
 * import), beside the Guided setup track's undated "M1 · Measured and mapped" (Health log): one
 * row, the track's name, the earliest date (Nov 12), both other names in its (i).
 */
export function seedHomeMilestonePrdsFold(): SimpleDb {
  const rm = seedSimpleRoadmap();
  const plain = (id: string, name: string, date: string, gate: string, slug: string, title: string): MockMilestone => ({
    id: stableUuid(`simple-gm/prds-fold-${id}`),
    roadmap: "onboarding-roadmap",
    code: "M1",
    name,
    date,
    goal: null,
    gates: [gate],
    counts_when: "",
    progress: "not_started",
    prd: { slug, title },
  });
  rm.goal_milestones = [plain("measured", "Measured", "2026-11-20", "setup-checklist", "setup-guide", "Setup guide"), plain("mapped", "Mapped", "2026-11-12", "setup-import", "import-guide", "Import guide")];
  rm.items = rm.items.map((s) => (s.key === "setup-health-log" ? { ...s, record: "M1 · Measured and mapped" } : s));
  return rm;
}

export const HOME_MILESTONE_PLAIN_FOLD_SCENARIO = "home-milestones-plain-fold";

/**
 * home-milestones-plain-fold (review of PR 1489): Onboarding's own M1 of no goal, "Measured"
 * (Setup checklist), and the Setup guide PRD's M1 of no goal, "Mapped" (Sample data import),
 * beside the Guided setup track's "M1 · Measured and mapped" (Health log): one row.
 */
export function seedHomeMilestonePlainFold(): SimpleDb {
  const rm = seedHomeMilestonePrdsFold();
  rm.goal_milestones = rm.goal_milestones!.map((m, k) => (k === 0 ? { ...m, prd: null } : m));
  return rm;
}

export const HOME_MILESTONE_GOALS_FOLD_SCENARIO = "home-milestones-goals-fold";

/**
 * home-milestones-goals-fold (the owner's "Join whenever names match"): the Setup guide PRD's own
 * M1 "Measured" under Faster activation (Setup checklist, Sample data import) and Grow
 * retention's ladder "M1 · First wins" (Welcome video), beside the Guided setup track's "M1 ·
 * Measured and mapped" (Health log): the PRD's joins the track's row (names match), the other
 * goal's keeps its own; two M1 rows.
 */
export function seedHomeMilestoneGoalsFold(): SimpleDb {
  const rm = seedSimpleRoadmap();
  const prd = { slug: "setup-guide", title: "Setup guide" };
  rm.goal_milestones = [
    { id: stableUuid("simple-gm/goals-fold-measured"), roadmap: "onboarding-roadmap", code: "M1", name: "Measured", date: "2026-11-20", goal: "faster-activation", gates: ["setup-checklist", "setup-import"], counts_when: "", progress: "not_started", prd },
    { id: stableUuid("simple-gm/goals-fold-wins"), roadmap: "onboarding-roadmap", code: "M1", name: "First wins", date: null, goal: "grow-retention", gates: ["setup-video"], counts_when: "", progress: "not_started" },
  ];
  rm.items = rm.items.map((s) => (s.key === "setup-health-log" ? { ...s, record: "M1 · Measured and mapped" } : s.key === "setup-video" ? { ...s, goal: "grow-retention" } : s));
  return rm;
}
