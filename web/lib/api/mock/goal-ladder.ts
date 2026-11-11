/**
 * goal-ladder: the "goal-ladder" scenario (LADDER_SCENARIO), the Goal map drawn as the Goal
 * ladder at real volume: four goals in priority order and a guardrail, twelve milestones, 63
 * features under them (one serving two milestones, in two goals), one more with no roadmap item, two Simple roadmap
 * features with no goal and four serving a goal but no milestone (the map's unplaced) and about 40 dependencies, some across goals. Each feature
 * is its own Simple roadmap item ("gm-f1", ...; code F-01, ...) with its status, dates and
 * what it waits on, as the API reads them. Invented company, people and products only.
 */
import type { Schemas } from "@/lib/api/client";

type GoalMap = Schemas["GoalMapOut"];
type GmGoal = Schemas["GmGoal"];
type GmMilestone = Schemas["GmMilestone"];
type GmFeature = Schemas["GmFeature"];
type Status = GmMilestone["status"];

export const LADDER_SCENARIO = "goal-ladder";
/** The scenario's names, for its specs. */
export const LADDER = { today: "2026-11-03" } as const;
/** The feature with no roadmap item. */
export const BARE = "Pause a plan from the mobile app";
/**
 * kr-in-goal-map: the ladder with key results (subgoals: goals with a parent goal). Each of the
 * four goals has one or two, measured, so the API reads them as goals of the map too (after the
 * four, as the one goal order puts them); "Mobile check-ins weekly for half of teams" is a
 * milestone of a key result, with its work.
 */
export const LADDER_KR_SCENARIO = "goal-ladder-key-results";

const goal = (id: string, name: string, math: string, current: number | null, target: number, unit: string, status: Status, position: number): GmGoal & { position: number } => ({
  id, name, measure: name.toLowerCase(), target, current, unit, status, math, builds_on: [], history: [], metric: { id: `metric-${id}`, title: name }, missing: null, choices: [], read_on: "Nov 1", position,
});

const GOALS = [
  goal("lg1", "Teams stay past their first year", "Teams that renew see the value every week, not once a quarter.", 81, 88, "%", "on_track", 1),
  goal("lg2", "New teams set up in one day", "A new team runs its first real project on the day it signs up.", 2.6, 1, "days", "at_risk", 2),
  goal("lg3", "Larger teams add paid seats", "Teams over 50 people grow seat revenue without a sales call.", 11200, 20000, "$", "not_measured", 3),
  goal("lg4", "Half the support tickets per team", "People answer their own questions inside the product.", 3.1, 1.5, "", "no_gate", 4),
];

/** kr-in-goal-map: each key result (a goal) and its parent goal. */
const KRS: [GmGoal & { position: number }, string][] = [
  [goal("lk11", "Weekly active teams at 80%", "Teams active in each of the last four weeks.", 74, 80, "%", "on_track", 0), "lg1"],
  [goal("lk12", "Half of teams check in from mobile", "Teams with a mobile check-in each week.", null, 50, "%", "not_measured", 0), "lg1"],
  [goal("lk21", "Imports done with no ticket", "Imports done with no support ticket.", 68, 90, "%", "on_track", 0), "lg2"],
  [goal("lk31", "Seat changes without a sales call", "Seat changes made in the product.", 40, 80, "%", "at_risk", 0), "lg3"],
  [goal("lk41", "Tickets answered in the product", "Questions answered by the help panel.", 20, 50, "%", "at_risk", 0), "lg4"],
];
/**
 * kr-in-goal-map: the key results' codes ("goal-ladder-key-result-codes", the key-result ladder
 * and more): Goal 2 carries the code G-B; "Imports done with no ticket" (G-B.1, older) and "Teams
 * finish setup on the first day" (G-B.2) each hold one of its milestones, M5 and M6. Under G-B.1
 * a proposed key result is older than the confirmed "Imports finished in under an hour", which so
 * reads G-B.1.2. F-21 is on both milestones, G-B.2's listed first; F-01, on Goal 1's M1, serves G-B.1.
 */
export const LADDER_KR_CODES_SCENARIO = "goal-ladder-key-result-codes";
const CODE_KRS: [GmGoal & { position: number }, string, string, "confirmed" | "proposed"][] = [
  [goal("lk22", "Teams finish setup on the first day", "Teams done with setup on the day they sign up.", 35, 60, "%", "at_risk", 0), "lg2", "2026-09-02T09:00:00Z", "confirmed"],
  [goal("lk211", "Imports matched with no manual fix", "Imports whose columns all match on their own.", null, 80, "%", "not_measured", 0), "lk21", "2026-09-03T09:00:00Z", "proposed"],
  [goal("lk212", "Imports finished in under an hour", "Imports done within an hour of starting.", 55, 75, "%", "on_track", 0), "lk21", "2026-09-04T09:00:00Z", "confirmed"],
];
/** The codes scenario's own created dates: G-B.1 older than G-B.2. */
const CODE_BORN: Record<string, string> = { lk21: "2026-09-01T09:00:00Z", ...Object.fromEntries(CODE_KRS.map(([k, , at]) => [k.id, at])) };
/** The codes scenario's names, for the spec. */
export const LADDER_KR_CODES = {
  goal: "New teams set up in one day",
  first: "Imports done with no ticket",
  second: "Teams finish setup on the first day",
  deeper: "Imports finished in under an hour",
  proposed: "Imports matched with no manual fix",
  /** F-21: on both key results' milestones; F-01: on Goal 1's M1, its item serving G-B.1. */
  both: "F-21",
  serving: "F-01",
} as const;

/** QA goal map codes: the feature whose stored title leads with its own code, for the spec. */
export const LADDER_CODED = { code: "F-16", name: "Setup checklist that shows each team what is left to do" } as const;

/** The key results' names by parent goal, and the milestone a key result holds, for the spec. */
export const LADDER_KRS = {
  goals: GOALS.map((g) => g.name),
  of: (goalName: string) => KRS.filter(([, p]) => GOALS.find((g) => g.id === p)!.name === goalName).map(([k]) => k.name),
  milestone: "Mobile check-ins weekly for half of teams",
} as const;

const AREAS = ["Onboarding", "Billing", "Reports", "Mobile", "Platform", "Support"];
const area = (name: string) => `la-${name.toLowerCase()}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const words = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

function ms(id: string, g: string, name: string, threshold: number | null, current: number | null, due: string | null, status: Status, areaName: string): GmMilestone {
  const gl = GOALS.find((x) => x.id === g)!;
  return {
    id, name, goal: g, measure: gl.measure, threshold, unit: gl.unit, current, status, areas: [area(areaName)], depends: [],
    month: due ? MONTHS[Number(due.slice(5, 7)) - 1] : "Nov", due: due ? words(due) : null, due_on: due, days: Array.from({ length: 7 }, () => current),
    confirmed: status === "met" ? "Dana Example" : null, confirmed_on: status === "met" ? "Nov 2" : null, proposed: false, can_change: false,
  };
}

const MILESTONES: GmMilestone[] = [
  ms("lm1", "lg1", "Weekly active teams first measured", 74, 74, "2026-11-13", "on_track", "Reports"),
  ms("lm2", "lg1", "Renewal rate at 85% for spring renewals", 85, 81, "2027-02-26", "at_risk", "Support"),
  ms("lm3", "lg1", "Mobile check-ins weekly for half of teams", 50, null, "2027-03-26", "not_measured", "Mobile"),
  ms("lm4", "lg2", "Setup time under two days", 2, 2.6, "2026-11-13", "at_risk", "Onboarding"),
  ms("lm5", "lg2", "Imports finish without help", 90, 68, "2026-12-18", "on_track", "Platform"),
  ms("lm6", "lg2", "Setup time one day for new teams", 1, null, "2027-01-29", "not_measured", "Onboarding"),
  ms("lm7", "lg3", "Seat revenue first measured for large teams", 10000, 10000, "2026-12-04", "met", "Billing"),
  ms("lm8", "lg3", "Self-serve seat changes for every plan", null, null, null, "no_gate", "Billing"),
  ms("lm9", "lg3", "Seat revenue of $20,000 per month", 20000, null, "2027-03-19", "not_measured", "Reports"),
  ms("lm10", "lg4", "Ticket volume measured by topic", 3.1, 3.1, "2026-11-27", "missed", "Support"),
  ms("lm11", "lg4", "Help answers inside every screen", 100, 40, "2027-01-15", "on_track", "Support"),
  ms("lm12", "lg4", "Tickets per team down to 1.5", null, null, "2027-03-12", "no_gate", "Onboarding"),
];

// [name, goal, milestone, area, status, start, end, waits on (row numbers)]
type Row = [string, string | null, string, string, "done" | "in_progress" | "planned", string | null, string | null, number[]];
const ROWS: Row[] = [
  ["Weekly team activity report with trends by project and member", "g1", "m1", "Reports", "done", "2026-09-14", "2026-10-23", []],
  ["Activity events pipeline with daily rollups for every workspace", "g1", "m1", "Platform", "done", "2026-08-31", "2026-10-09", []],
  ["Renewal health score shown to account owners each Monday", "g1", "m1", "Reports", "in_progress", "2026-10-19", "2026-11-20", [2]],
  ["Saved views that follow a person across projects and devices", "g1", "m2", "Reports", "in_progress", "2026-10-26", "2026-12-11", [2]],
  ["Renewal reminders with a plain summary of the year's work", "g1", "m2", "Support", "planned", "2026-12-07", "2027-01-22", [3]],
  ["Year in review page each team can share with its leaders", "g1", "m2", "Reports", "planned", "2027-01-11", "2027-02-19", [1, 5]],
  ["Priority support line for teams close to renewal", "g1", "m2", "Support", "planned", null, null, [3]],
  ["Win-back offer for teams that pause their plan", "g1", "m2", "Billing", "planned", null, null, []],
  ["Mobile daily check-in with one tap status for each task", "g1", "m3", "Mobile", "in_progress", "2026-11-02", "2027-01-15", [13]],
  ["Mobile push digest of what changed while you were away", "g1", "m3", "Mobile", "planned", "2027-01-04", "2027-02-26", []],
  ["Offline edits on mobile that sync without conflicts", "g1", "m3", "Mobile", "planned", "2027-01-18", "2027-03-19", []],
  ["Mobile widgets for today's tasks on the home screen", "g1", "m3", "Mobile", "planned", null, null, []],
  ["Shared sign-in for web and mobile with one session", "g2", "m4", "Platform", "done", "2026-09-07", "2026-10-16", []],
  ["Guided first project that fills itself from a template", "g2", "m4", "Onboarding", "in_progress", "2026-10-12", "2026-11-13", [13]],
  ["Invite the whole team from a pasted list of emails", "g2", "m4", "Onboarding", "in_progress", "2026-10-19", "2026-11-13", [13]],
  // QA goal map codes: a title stored with its own code in front, as some are (the map and roadmap read it without).
  ["F-16 Setup checklist that shows each team what is left to do", "g2", "m4", "Onboarding", "done", "2026-09-28", "2026-10-30", []],
  ["Welcome call booking for teams stuck after two days", "g2", "m4", "Support", "planned", "2026-11-16", "2026-12-04", [16]],
  ["Import projects from spreadsheets with column matching", "g2", "m5", "Platform", "in_progress", "2026-10-26", "2026-12-04", [13]],
  ["Import from other task tools with people and comments kept", "g2", "m5", "Platform", "planned", "2026-11-23", "2026-12-18", [18]],
  ["Import progress page with a clear list of rows that failed", "g2", "m5", "Platform", "planned", "2026-11-30", "2026-12-18", [18, 19]],
  ["Undo a whole import in one step within seven days", "g2", "m5", "Platform", "planned", null, null, []],
  ["Sample workspace with realistic projects to explore first", "g2", "m6", "Onboarding", "planned", "2027-01-04", "2027-01-22", [14]],
  ["Team roles picked during setup with sensible defaults", "g2", "m6", "Onboarding", "planned", "2026-12-07", "2027-01-08", [15]],
  ["One day setup report for every new team's owner", "g2", "m6", "Reports", "planned", null, null, [16]],
  ["Single sign-on setup wizard for company admins", "g2", "m6", "Platform", "in_progress", "2026-11-02", "2026-12-11", [13]],
  ["Seat usage dashboard for admins of large teams", "g3", "m7", "Billing", "done", "2026-09-21", "2026-11-06", []],
  ["Monthly seat growth export for finance contacts", "g3", "m7", "Reports", "done", "2026-10-05", "2026-11-06", [26]],
  ["Add seats from the invite screen without leaving it", "g3", "m8", "Billing", "in_progress", "2026-11-02", "2026-12-18", [26, 15]],
  ["Plan change page with prices shown before you confirm", "g3", "m8", "Billing", "planned", "2026-12-07", "2027-01-29", [28]],
  ["Seat requests that a member sends to their admin", "g3", "m8", "Billing", "planned", "2027-01-04", "2027-02-05", [28]],
  ["Invoices split by department for larger companies", "g3", "m8", "Billing", "planned", null, null, []],
  ["Usage alerts when a team is close to its seat limit", "g3", "m8", "Billing", "planned", null, null, []],
  ["Department spaces with their own owners and settings", "g3", "m9", "Platform", "planned", "2027-01-11", "2027-03-05", [25]],
  ["Cross-team reports for leaders of many departments", "g3", "m9", "Reports", "planned", "2027-02-01", "2027-03-19", [33]],
  ["Admin audit trail for seat and role changes", "g3", "m9", "Platform", "planned", null, null, []],
  ["Volume pricing shown in the product for teams over 50", "g3", "m9", "Billing", "planned", null, null, []],
  ["Ticket topics tagged by the help desk each day", "g4", "m10", "Support", "done", "2026-09-14", "2026-10-30", []],
  ["Ticket volume report by topic and team size", "g4", "m10", "Reports", "in_progress", "2026-11-02", "2026-11-27", [37, 2]],
  ["Help panel that opens beside the screen you are on", "g4", "m11", "Support", "in_progress", "2026-10-26", "2026-12-18", [37]],
  ["Answers written for the twenty most asked questions", "g4", "m11", "Support", "planned", "2026-11-16", "2027-01-08", [37]],
  ["Search across help answers, projects and comments", "g4", "m11", "Support", "planned", "2026-12-07", "2027-01-15", [39]],
  ["Contact form that suggests answers before sending", "g4", "m11", "Support", "planned", "2027-01-04", "2027-01-29", [40, 41]],
  ["Status page linked from every error message", "g4", "m12", "Platform", "planned", null, null, []],
  ["Clearer error messages with the next step to take", "g4", "m12", "Platform", "planned", "2027-01-11", "2027-02-19", [43]],
  ["Short videos in the setup checklist for each step", "g4", "m12", "Onboarding", "planned", "2027-02-01", "2027-03-05", [16]],
  ["Community answers ranked by how often they helped", "g4", "m12", "Support", "planned", null, null, []],
  ["Comment threads that stay readable past a hundred replies", "g1", "m2", "Reports", "planned", null, null, []],
  ["Recurring tasks that skip holidays and weekends", "g1", "m2", "Reports", "in_progress", "2026-10-26", "2026-11-27", []],
  ["Calendar view that shows every project's key dates", "g1", "m3", "Mobile", "planned", "2026-12-14", "2027-02-05", []],
  ["Faster board loading for projects with thousands of tasks", "g1", "m2", "Platform", "in_progress", "2026-10-19", "2026-12-04", [2]],
  ["Templates library shared across the whole company", "g2", "m6", "Onboarding", "planned", null, null, [14]],
  ["Bulk edit for tasks across many projects at once", "g3", "m9", "Platform", "planned", null, null, []],
  ["Time off calendar that warns before tasks fall due", "g1", "m3", "Mobile", "planned", null, null, []],
  ["Approval steps on tasks with a named approver", "g3", "m9", "Platform", "planned", "2027-01-18", "2027-03-12", []],
  ["Guest access for clients with view-only projects", "g3", "m8", "Billing", "planned", "2026-12-07", "2027-01-22", [28]],
  ["Workload view showing who is over their hours", "g1", "m2", "Reports", "planned", "2026-12-14", "2027-02-12", [4]],
  ["Email replies that land as comments on the right task", "g4", "m11", "Support", "in_progress", "2026-11-02", "2026-12-11", []],
  ["Keyboard shortcuts sheet for every screen", "g4", "m12", "Support", "planned", null, null, []],
  ["Dark theme across web and mobile", "g1", "m3", "Mobile", "done", "2026-09-07", "2026-10-23", []],
  ["Project health colours explained in one place", "g4", "m11", "Support", "planned", "2026-12-14", "2027-01-15", [39]],
  ["Faster sign-up with work email check", "g2", "m4", "Onboarding", "done", "2026-09-14", "2026-10-16", []],
  ["Data retention settings for company admins", "g3", "m9", "Platform", "planned", null, null, []],
  ["Weekly summary email every owner can tune", "g1", "m1", "Reports", "planned", "2026-11-16", "2026-12-18", [3]],
  ["Accessibility pass on boards, lists and forms", null, "", "Platform", "planned", "2026-11-23", "2027-01-15", []],
  ["Year-end export of all projects for records", null, "", "Platform", "planned", null, null, []],
  // goal-map-editing: features that serve a goal but no milestone yet ("Not on a key result").
  ["Team templates gallery", "g1", "", "Reports", "planned", null, null, []],
  ["Usage tips in the weekly email", "g1", "", "Support", "planned", null, null, []],
  ["Bulk invite from a spreadsheet", "g2", "", "Onboarding", "planned", null, null, []],
  ["Seat usage chart for admins", "g3", "", "Billing", "planned", null, null, []],
];
/** F-03 also serves M10 (two milestones, two goals). */
const ALSO: Record<number, string> = { 3: "m10" };

const pad = (n: number) => String(n).padStart(2, "0");

/** The ladder's goal map (short ids: goal-map.ts gives them the API's UUIDs; features are "f1"...). */
export function ladderMap(keyResults = false, codes = false): GoalMap {
  const features: GmFeature[] = ROWS.flatMap(([name, g, m, a], i) => {
    if (!g || !m) return [];
    const milestones = (codes && i + 1 === 21 ? ["m6", m] : [m, ...(ALSO[i + 1] ? [ALSO[i + 1]] : [])]).map((x) => `l${x}`);
    const link = (milestone: string) => ({ milestone, expected: "", confidence: "Medium" as const, measured: null, lift: "not_measured" as const, shipped_on: null, before: null, after: null });
    return [{ id: `f${i + 1}`, name, code: "", area: area(a), milestones, lever: a, expected: "", confidence: "Medium" as const, released: false, measured: null, lift: "not_measured" as const, links: milestones.map(link) }];
  });
  // One feature with no roadmap item (no code, no key): a link onto it is refused, for a reason that is not a loop.
  const link = { milestone: "lm12", expected: "", confidence: "Medium" as const, measured: null, lift: "not_measured" as const, shipped_on: null, before: null, after: null };
  features.push({ id: "bare-feature", name: BARE, code: "", area: area("Mobile"), milestones: ["lm12"], lever: "Mobile", expected: "", confidence: "Medium", released: false, measured: null, lift: "not_measured", links: [link] });
  return {
    goals: [...GOALS, ...(keyResults ? KRS.map(([k]) => k) : []), ...(codes ? CODE_KRS.filter(([, , , s]) => s === "confirmed").map(([k]) => k) : [])].map(({ position, ...g }) => (void position, { ...g })),
    areas: AREAS.map((a) => ({ id: area(a), name: a, lever: a })),
    guardrail: { name: "Pages load in under 2 seconds", rule: "for 95% of views", current: 0, days: [0, 0, 0, 0, 0, 0, 0], held: true },
    // kr-in-goal-map: M3 is a milestone of the key result "Half of teams check in from mobile".
    milestones: MILESTONES.map((m) => ({ ...m, ...(keyResults && m.id === "lm3" ? { goal: "lk12" } : {}), ...(codes && m.id === "lm5" ? { goal: "lk21" } : {}), ...(codes && m.id === "lm6" ? { goal: "lk22" } : {}) })),
    features,
    gaps: [],
    unplaced: [],
    off_map: [],
    today: "Nov 3",
    today_on: LADDER.today,
    reps: null,
    approver: "Dana Example",
    can_edit: true,
    places: [],
  };
}

/** The ladder's goals as Baseline goals (one store, the same ids), in priority order. */
export function ladderGoals(idOf: (k: string) => string, keyResults = false, codes = false): { id: string; key: string; title: string; status: "confirmed" | "proposed"; parent_id: string | null; attrs: Record<string, unknown>; created_at?: string }[] {
  const of = (g: GmGoal & { position: number }, parent: string | null, status: "confirmed" | "proposed" = "confirmed") => ({
    id: idOf(g.id), key: codes && g.id === "lg2" ? "G-B" : `g.${g.id}`, title: g.name, status, parent_id: parent && idOf(parent),
    attrs: { metric: g.measure, target: g.target, unit: g.unit, math: g.math, ...(g.position ? { position: g.position } : {}) },
    ...(codes && CODE_BORN[g.id] ? { created_at: CODE_BORN[g.id] } : {}),
  });
  return [...GOALS.map((g) => of(g, null)), ...(keyResults ? KRS.map(([k, p]) => of(k, p)) : []), ...(codes ? CODE_KRS.map(([k, p, , s]) => of(k, p, s)) : [])];
}

/**
 * Each feature as its Simple roadmap item: key, title, code's section, status, dates and what it
 * waits on; one on no milestone names its goal itself (`goal`, the ladder's short id: "lg1").
 */
export function ladderItems(codes = false): { key: string; title: string; section: string; status: "done" | "in_progress" | "planned"; dates?: { start: string | null; end: string; source: "engineering" }; depends: string[]; goal?: string }[] {
  return ROWS.map(([title, g, m, , status, start, end, deps], i) => ({
    key: `gm-f${i + 1}`, title, section: `f-${pad(i + 1)}`, status, ...(end ? { dates: { start, end, source: "engineering" as const } } : {}), depends: deps.map((d) => `gm-f${d}`),
    ...(g && !m ? { goal: `l${g}` } : {}),
    ...(codes && i === 0 ? { goal: "lk21" } : {}),
  }));
}
