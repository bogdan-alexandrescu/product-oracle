// MOCK-HOOK mk-milestones: invented goal-ladder milestones for the Simple Roadmap mock-ups (never merged).
// Invented company, goals and items only. Dates are the mock's (today Nov 3, 2026).

export type MsMock = { // MOCK-HOOK
  id: string; // MOCK-HOOK
  code: string; // MOCK-HOOK
  name: string; // MOCK-HOOK
  date: string; // MOCK-HOOK
  goal: string; // MOCK-HOOK
  gates: string[]; // MOCK-HOOK
  rule: string; // MOCK-HOOK
  status: "On track" | "At risk" | "Not started" | "Met"; // MOCK-HOOK
  prd?: string; // MOCK-HOOK
}; // MOCK-HOOK

/** The roadmap's own milestones, on the goals' ladders. */ // MOCK-HOOK
export const MS_OWN: MsMock[] = [ // MOCK-HOOK
  { id: "m1", code: "M1", name: "Alerts live for 50 teams", date: "2026-11-20", goal: "Grow retention", gates: ["alert-rules"], rule: "Holds 7 days in a row", status: "On track" }, // MOCK-HOOK
  { id: "m2", code: "M2", name: "60% of teams active at day 90", date: "2026-12-22", goal: "Grow retention", gates: ["alert-digest", "alert-mobile"], rule: "Holds 14 days in a row on all teams", status: "At risk" }, // MOCK-HOOK
  { id: "a1", code: "M1", name: "First alert within a day", date: "2026-12-04", goal: "Faster activation", gates: ["setup-checklist", "setup-import"], rule: "Holds 7 days in a row", status: "On track" }, // MOCK-HOOK
]; // MOCK-HOOK

/** The one being added in the story (the first add), and the second added right after it. */ // MOCK-HOOK
export const MS_NEW: MsMock = { id: "m3", code: "M3", name: "Teams set 3 rules in week 1", date: "2027-01-20", goal: "Grow retention", gates: ["alert-mobile", "alert-sso"], rule: "Holds 7 days in a row on one live team", status: "Not started" }; // MOCK-HOOK
export const MS_SECOND: MsMock = { id: "m4", code: "M4", name: "Digest opened by 70%", date: "2027-02-17", goal: "Grow retention", gates: ["alert-digest"], rule: "Holds 4 weeks in a row", status: "Not started" }; // MOCK-HOOK
/** The hard case: a second goal's milestone on M2's own day. */ // MOCK-HOOK
export const MS_SAME_DAY: MsMock = { id: "a2", code: "M2", name: "Half of new teams invite a teammate", date: "2026-12-22", goal: "Faster activation", gates: ["setup-ideas"], rule: "Holds 14 days in a row", status: "Not started" }; // MOCK-HOOK

/** A PRD's own milestones ("Usage alerts", invented), drawn from the PRD. */ // MOCK-HOOK
export const MS_PRD: MsMock[] = [ // MOCK-HOOK
  { id: "p1", code: "M1", name: "Rules in beta", date: "2026-11-27", goal: "Grow retention", gates: ["alert-rules"], rule: "10 beta teams use it for a week", status: "On track", prd: "Usage alerts" }, // MOCK-HOOK
  { id: "p2", code: "M2", name: "Digest for all teams", date: "2026-12-15", goal: "Grow retention", gates: ["alert-digest"], rule: "Sent to every team 2 weeks in a row", status: "At risk", prd: "Usage alerts" }, // MOCK-HOOK
  { id: "p3", code: "M3", name: "Push on phones", date: "2027-01-12", goal: "Grow retention", gates: ["alert-mobile"], rule: "Live on both phone apps", status: "Not started", prd: "Usage alerts" }, // MOCK-HOOK
  { id: "p4", code: "M4", name: "Routing by team", date: "2027-03-01", goal: "Grow retention", gates: ["alert-sso"], rule: "Used by 20 teams", status: "Not started", prd: "Usage alerts" }, // MOCK-HOOK
]; // MOCK-HOOK
