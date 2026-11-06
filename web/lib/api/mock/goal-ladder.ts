// MOCK-HOOK: whole file. Mock-up set mk-goal-ladder only (never merged): an invented company's
// goals, milestones (key results), features and dependencies at real volume, for the Goal ladder
// proposals. Invented people, goals and features only.

export type LdStatus = "met" | "on_track" | "at_risk" | "missed" | "not_measured" | "no_gate"; // MOCK-HOOK
export type LdWork = "done" | "in_progress" | "planning" | "backlog" | "not_on_board"; // MOCK-HOOK
export type LdRole = "owner" | "commenter" | "viewer"; // MOCK-HOOK

export interface LdGoal { id: string; name: string; line: string; draws: string[]; current: string; target: string; status: LdStatus; period: "now" | "next" } // MOCK-HOOK
export interface LdMilestone { id: string; goal: string; code: string; name: string; measure: string; reading: string; target: string; due: string | null; status: LdStatus; area: string; when: string } // MOCK-HOOK
export interface LdFeature { id: string; code: string; name: string; goal: string | null; milestones: string[]; area: string; status: LdWork; start: string | null; end: string | null; prd: string | null; depends: string[]; can_change: boolean; can_propose: boolean } // MOCK-HOOK
export interface Ladder { title: string; line: string; today: string; guardrail: { name: string; rule: string; held: number }; goals: LdGoal[]; milestones: LdMilestone[]; features: LdFeature[]; areas: string[]; periods: LdPeriod[] } // MOCK-HOOK
export interface LdPeriod { id: string; name: string; weeks: { n: number; from: string; mark?: string; today?: boolean }[] } // MOCK-HOOK

const GOALS: LdGoal[] = [ // MOCK-HOOK
  { id: "g1", name: "Teams stay past their first year", line: "Teams that renew see the value every week, not once a quarter.", draws: ["Reports", "Mobile", "Support"], current: "81%", target: "88%", status: "on_track", period: "now" },
  { id: "g2", name: "New teams set up in one day", line: "A new team runs its first real project on the day it signs up.", draws: ["Onboarding", "Platform"], current: "2.6 days", target: "1 day", status: "at_risk", period: "now" },
  { id: "g3", name: "Larger teams add paid seats", line: "Teams over 50 people grow seats without a sales call.", draws: ["Billing", "Platform", "Reports"], current: "+4%", target: "+12%", status: "not_measured", period: "next" },
  { id: "g4", name: "Half the support tickets per team", line: "People answer their own questions inside the product.", draws: ["Support", "Onboarding"], current: "3.1", target: "1.5", status: "no_gate", period: "next" },
];

const MS: LdMilestone[] = [ // MOCK-HOOK
  { id: "m1", goal: "g1", code: "M1", name: "Weekly active teams baseline set", measure: "Teams active each week", reading: "74%", target: "Baseline", due: "2026-11-13", status: "on_track", area: "Reports", when: "Measure now" },
  { id: "m2", goal: "g1", code: "M2", name: "Renewal rate at 85% for spring renewals", measure: "Teams that renew", reading: "81%", target: "85%", due: "2027-02-26", status: "at_risk", area: "Support", when: "At risk" },
  { id: "m3", goal: "g1", code: "M3", name: "Mobile check-ins weekly for half of teams", measure: "Teams with a mobile check-in", reading: "—", target: "50%", due: "2027-03-26", status: "not_measured", area: "Mobile", when: "Too early" },
  { id: "m4", goal: "g2", code: "M4", name: "Setup time under two days", measure: "Days from sign-up to first project", reading: "2.6", target: "2", due: "2026-11-13", status: "at_risk", area: "Onboarding", when: "Due next week" },
  { id: "m5", goal: "g2", code: "M5", name: "Imports finish without help", measure: "Imports done without a ticket", reading: "68%", target: "90%", due: "2026-12-18", status: "on_track", area: "Platform", when: "On track" },
  { id: "m6", goal: "g2", code: "M6", name: "Setup time one day for new teams", measure: "Days from sign-up to first project", reading: "—", target: "1", due: "2027-01-29", status: "not_measured", area: "Onboarding", when: "Too early" },
  { id: "m7", goal: "g3", code: "M7", name: "Seat growth baseline for large teams", measure: "Seats added each month", reading: "+4%", target: "Baseline", due: "2026-12-04", status: "met", area: "Billing", when: "Met" },
  { id: "m8", goal: "g3", code: "M8", name: "Self-serve seat changes for every plan", measure: "Seat changes without sales", reading: "—", target: "100%", due: null, status: "no_gate", area: "Billing", when: "No dates yet" },
  { id: "m9", goal: "g3", code: "M9", name: "Seat growth at 12% a quarter", measure: "Seats added each quarter", reading: "—", target: "+12%", due: "2027-03-19", status: "not_measured", area: "Reports", when: "Not started" },
  { id: "m10", goal: "g4", code: "M10", name: "Ticket baseline by topic", measure: "Tickets per team each month", reading: "3.1", target: "Baseline", due: "2026-11-27", status: "missed", area: "Support", when: "Missed" },
  { id: "m11", goal: "g4", code: "M11", name: "Help answers inside every screen", measure: "Screens with help answers", reading: "40%", target: "100%", due: "2027-01-15", status: "on_track", area: "Support", when: "On track" },
  { id: "m12", goal: "g4", code: "M12", name: "Tickets per team down to 1.5", measure: "Tickets per team each month", reading: "—", target: "1.5", due: "2027-03-12", status: "no_gate", area: "Onboarding", when: "No dates yet" },
];

// [name, goal, milestone(s), area, status, start, end, depends (codes)] MOCK-HOOK
type Row = [string, string | null, string, string, LdWork, string | null, string | null, number[]]; // MOCK-HOOK
const ROWS: Row[] = [ // MOCK-HOOK
  ["Weekly team activity report with trends by project and member", "g1", "m1", "Reports", "done", "2026-09-14", "2026-10-23", []],
  ["Activity events pipeline with daily rollups for every workspace", "g1", "m1", "Platform", "done", "2026-08-31", "2026-10-09", []],
  ["Renewal health score shown to account owners each Monday", "g1", "m1", "Reports", "in_progress", "2026-10-19", "2026-11-20", [2]],
  ["Saved views that follow a person across projects and devices", "g1", "m2", "Reports", "in_progress", "2026-10-26", "2026-12-11", [2]],
  ["Renewal reminders with a plain summary of the year's work", "g1", "m2", "Support", "planning", "2026-12-07", "2027-01-22", [3]],
  ["Year in review page each team can share with its leaders", "g1", "m2", "Reports", "planning", "2027-01-11", "2027-02-19", [1, 5]],
  ["Priority support line for teams close to renewal", "g1", "m2", "Support", "backlog", null, null, [3]],
  ["Win-back offer for teams that pause their plan", "g1", "m2", "Billing", "not_on_board", null, null, [42]],
  ["Mobile daily check-in with one tap status for each task", "g1", "m3", "Mobile", "in_progress", "2026-11-02", "2027-01-15", [13]],
  ["Mobile push digest of what changed while you were away", "g1", "m3", "Mobile", "planning", "2027-01-04", "2027-02-26", [9]],
  ["Offline edits on mobile that sync without conflicts", "g1", "m3", "Mobile", "backlog", "2027-01-18", "2027-03-19", [9]],
  ["Mobile widgets for today's tasks on the home screen", "g1", "m3", "Mobile", "not_on_board", null, null, [9]],
  ["Shared sign-in for web and mobile with one session", "g2", "m4", "Platform", "done", "2026-09-07", "2026-10-16", []],
  ["Guided first project that fills itself from a template", "g2", "m4", "Onboarding", "in_progress", "2026-10-12", "2026-11-13", [13]],
  ["Invite the whole team from a pasted list of emails", "g2", "m4", "Onboarding", "in_progress", "2026-10-19", "2026-11-13", [13]],
  ["Setup checklist that shows each team what is left to do", "g2", "m4", "Onboarding", "done", "2026-09-28", "2026-10-30", []],
  ["Welcome call booking for teams stuck after two days", "g2", "m4", "Support", "planning", "2026-11-16", "2026-12-04", [16]],
  ["Import projects from spreadsheets with column matching", "g2", "m5", "Platform", "in_progress", "2026-10-26", "2026-12-04", [13]],
  ["Import from other task tools with people and comments kept", "g2", "m5", "Platform", "planning", "2026-11-23", "2026-12-18", [18]],
  ["Import progress page with a clear list of rows that failed", "g2", "m5", "Platform", "planning", "2026-11-30", "2026-12-18", [18, 19]],
  ["Undo a whole import in one step within seven days", "g2", "m5", "Platform", "backlog", null, null, [18]],
  ["Sample workspace with realistic projects to explore first", "g2", "m6", "Onboarding", "backlog", "2027-01-04", "2027-01-22", [14]],
  ["Team roles picked during setup with sensible defaults", "g2", "m6", "Onboarding", "planning", "2026-12-07", "2027-01-08", [15]],
  ["One day setup report for every new team's owner", "g2", "m6", "Reports", "not_on_board", null, null, [16]],
  ["Single sign-on setup wizard for company admins", "g2", "m6", "Platform", "in_progress", "2026-11-02", "2026-12-11", [13]],
  ["Seat usage dashboard for admins of large teams", "g3", "m7", "Billing", "done", "2026-09-21", "2026-11-06", []],
  ["Monthly seat growth export for finance contacts", "g3", "m7", "Reports", "done", "2026-10-05", "2026-11-06", [26]],
  ["Add seats from the invite screen without leaving it", "g3", "m8", "Billing", "in_progress", "2026-11-02", "2026-12-18", [26, 15]],
  ["Plan change page with prices shown before you confirm", "g3", "m8", "Billing", "planning", "2026-12-07", "2027-01-29", [28]],
  ["Seat requests that a member sends to their admin", "g3", "m8", "Billing", "planning", "2027-01-04", "2027-02-05", [28]],
  ["Invoices split by department for larger companies", "g3", "m8", "Billing", "backlog", null, null, [29]],
  ["Usage alerts when a team is close to its seat limit", "g3", "m8", "Billing", "not_on_board", null, null, [26]],
  ["Department spaces with their own owners and settings", "g3", "m9", "Platform", "planning", "2027-01-11", "2027-03-05", [25]],
  ["Cross-team reports for leaders of many departments", "g3", "m9", "Reports", "backlog", "2027-02-01", "2027-03-19", [33]],
  ["Admin audit trail for seat and role changes", "g3", "m9", "Platform", "backlog", null, null, [33]],
  ["Volume pricing shown in the product for teams over 50", "g3", "m9", "Billing", "not_on_board", null, null, [29]],
  ["Ticket topics tagged by the help desk each day", "g4", "m10", "Support", "done", "2026-09-14", "2026-10-30", []],
  ["Ticket baseline report by topic and team size", "g4", "m10", "Reports", "in_progress", "2026-11-02", "2026-11-27", [37, 2]],
  ["Help panel that opens beside the screen you are on", "g4", "m11", "Support", "in_progress", "2026-10-26", "2026-12-18", [37]],
  ["Answers written for the twenty most asked questions", "g4", "m11", "Support", "planning", "2026-11-16", "2027-01-08", [37]],
  ["Search across help answers, projects and comments", "g4", "m11", "Support", "planning", "2026-12-07", "2027-01-15", [39]],
  ["Contact form that suggests answers before sending", "g4", "m11", "Support", "backlog", "2027-01-04", "2027-01-29", [40, 41]],
  ["Status page linked from every error message", "g4", "m12", "Platform", "not_on_board", null, null, []],
  ["Clearer error messages with the next step to take", "g4", "m12", "Platform", "planning", "2027-01-11", "2027-02-19", [43]],
  ["Short videos in the setup checklist for each step", "g4", "m12", "Onboarding", "backlog", "2027-02-01", "2027-03-05", [16]],
  ["Community answers ranked by how often they helped", "g4", "m12", "Support", "backlog", null, null, [41]],
  ["Comment threads that stay readable past a hundred replies", "g1", "m2", "Reports", "backlog", null, null, []],
  ["Recurring tasks that skip holidays and weekends", "g1", "m2", "Reports", "in_progress", "2026-10-26", "2026-11-27", []],
  ["Calendar view that shows every project's key dates", "g1", "m3", "Mobile", "planning", "2026-12-14", "2027-02-05", [48]],
  ["Faster board loading for projects with thousands of tasks", "g1", "m2", "Platform", "in_progress", "2026-10-19", "2026-12-04", [2]],
  ["Templates library shared across the whole company", "g2", "m6", "Onboarding", "backlog", null, null, [14]],
  ["Bulk edit for tasks across many projects at once", "g3", "m9", "Platform", "backlog", null, null, []],
  ["Time off calendar that warns before tasks fall due", "g1", "m3", "Mobile", "not_on_board", null, null, [49]],
  ["Approval steps on tasks with a named approver", "g3", "m9", "Platform", "planning", "2027-01-18", "2027-03-12", [33]],
  ["Guest access for clients with view-only projects", "g3", "m8", "Billing", "planning", "2026-12-07", "2027-01-22", [28]],
  ["Workload view showing who is over their hours", "g1", "m2", "Reports", "planning", "2026-12-14", "2027-02-12", [4]],
  ["Email replies that land as comments on the right task", "g4", "m11", "Support", "in_progress", "2026-11-02", "2026-12-11", []],
  ["Keyboard shortcuts sheet for every screen", "g4", "m12", "Support", "backlog", null, null, []],
  ["Dark theme across web and mobile", "g1", "m3", "Mobile", "done", "2026-09-07", "2026-10-23", []],
  ["Project health colours explained in one place", "g4", "m11", "Support", "planning", "2026-12-14", "2027-01-15", [39]],
  ["Faster sign-up with work email check", "g2", "m4", "Onboarding", "done", "2026-09-14", "2026-10-16", []],
  ["Data retention settings for company admins", "g3", "m9", "Platform", "not_on_board", null, null, [35]],
  ["Weekly summary email every owner can tune", "g1", "m1", "Reports", "planning", "2026-11-16", "2026-12-18", [3]],
  ["Accessibility pass on boards, lists and forms", null, "", "Platform", "planning", "2026-11-23", "2027-01-15", []],
  ["Year-end export of all projects for records", null, "", "Platform", "backlog", null, null, [2]],
];

const ALSO: Record<number, string> = { 3: "m10" }; // MOCK-HOOK: F-03 also serves M10 (two milestones, two goals)
const PRD: Record<string, string> = { g1: "Team retention PRD", g2: "One day setup PRD", g3: "Seat growth PRD", g4: "Self-help PRD" }; // MOCK-HOOK

const pad = (n: number) => String(n).padStart(2, "0"); // MOCK-HOOK

/** The ladder for the role a frame shows (MOCK-HOOK: ?as=viewer|commenter); can_* fields carry it. */
export function mockLadder(role: LdRole): Ladder { // MOCK-HOOK
  const features: LdFeature[] = ROWS.map(([name, goal, m, area, status, start, end, deps], i) => ({ // MOCK-HOOK
    id: `f${i + 1}`, code: `F-${pad(i + 1)}`, name, goal, milestones: m ? [m, ...(ALSO[i + 1] ? [ALSO[i + 1]] : [])] : [], area, status, start, end, // MOCK-HOOK
    prd: goal ? PRD[goal] : null, depends: deps.map((d) => `f${d}`), can_change: role === "owner", can_propose: role === "commenter", // MOCK-HOOK
  })); // MOCK-HOOK
  const marks: Record<string, string> = {}; // MOCK-HOOK
  for (const m of MS) if (m.due) marks[m.due] = marks[m.due] ? `${marks[m.due]} · ${m.code}` : `${m.code} ${short(m.name)}`; // MOCK-HOOK
  const weeks = (from: string, n: number) => Array.from({ length: n }, (_, i) => { // MOCK-HOOK
    const d0 = Date.parse(`${from}T00:00:00Z`) + i * 7 * 86_400_000; // MOCK-HOOK
    const days = Array.from({ length: 7 }, (_, k) => new Date(d0 + k * 86_400_000).toISOString().slice(0, 10)); // MOCK-HOOK
    const hit = days.map((d) => marks[d]).filter(Boolean).join(" · "); // MOCK-HOOK
    return { n: i + 1, from: days[0], mark: hit || undefined, today: days.includes("2026-11-06") }; // MOCK-HOOK
  }); // MOCK-HOOK
  return { // MOCK-HOOK
    title: "2027 goal ladder", line: "Four goals, twelve milestones and the work behind them.", today: "2026-11-06", // MOCK-HOOK
    guardrail: { name: "Pages load in under 2 seconds", rule: "for 95% of views", held: 6 }, // MOCK-HOOK
    goals: GOALS, milestones: MS, features, areas: ["Onboarding", "Billing", "Reports", "Mobile", "Platform", "Support"], // MOCK-HOOK
    periods: [{ id: "now", name: "Rest of 2026", weeks: weeks("2026-11-02", 9) }, { id: "next", name: "Q1 2027", weeks: weeks("2027-01-04", 13) }], // MOCK-HOOK
  }; // MOCK-HOOK
} // MOCK-HOOK

function short(name: string): string { // MOCK-HOOK
  return name.split(" ").slice(0, 3).join(" "); // MOCK-HOOK
} // MOCK-HOOK
