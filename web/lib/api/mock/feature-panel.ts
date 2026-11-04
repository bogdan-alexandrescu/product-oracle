// MOCK-HOOK: this whole file is mock-up data for the feature panel proposals (FP1..FP3); invented people and text only.

export type FpDep = {
  title: string;
  /** Its own dates, month first, as the panel shows them. */
  dates: string;
  /** Where the link comes from: Oracle (from a PRD or an estimate) or a person. */
  from: "oracle" | "person";
  by?: string;
  /** Oracle's link that a person removed (shown struck, with Restore). */
  removed?: boolean;
  /** This link breaks the feature's dates. */
  conflict?: boolean;
};

export type FpFeature = {
  title: string;
  outcome: string;
  status: string;
  owner: string;
  confidence: "High" | "Medium" | "Low";
  notes: string;
  start: { date: string; from: string };
  end: { date: string; from: string; suggested?: string };
  goal: { title: string; measure: string; today: string; target: string; by: string; suggested?: boolean };
  milestone: { name: string; date: string };
  dependsOn: FpDep[];
  neededBy: FpDep[];
  /** A date that breaks a link, in words. */
  conflict?: { text: string; fixes: string[] };
};

export const FP_ME = "Leo Brandt"; // MOCK-HOOK

export const FP_DIGEST: FpFeature = {
  title: "Weekly alert digest",
  outcome: "Admins get every alert fired in the week in one email, so fewer alerts go unread.",
  status: "Planned",
  owner: "Maya Ortiz",
  confidence: "Medium",
  notes: "Send on Monday morning in the admin's time zone. Skip teams with no alerts that week.",
  start: { date: "Oct 31", from: "From the capacity plan" },
  end: { date: "Dec 10", from: "Engineering estimate", suggested: "Dec 10" },
  goal: { title: "Grow retention", measure: "Teams active after 90 days", today: "61%", target: "70%", by: "Jun 30, 2027", suggested: true },
  milestone: { name: "Beta", date: "Nov 30" },
  dependsOn: [{ title: "Alert rules engine", dates: "Oct 1 – Nov 10", from: "oracle", conflict: true }],
  neededBy: [
    { title: "Alert routing by team", dates: "Feb 21 – Aug 20, 2027", from: "person", by: "Maya Ortiz" },
    { title: "Alert history export", dates: "Jan 1 – Feb 20, 2027", from: "oracle", removed: true, by: "Leo Brandt" },
  ],
  conflict: { text: "Starts Oct 31, before Alert rules engine ends Nov 10. Ends Dec 10, after its milestone Beta (Nov 30).", fixes: ["Start after it: Nov 11 – Dec 21", "Keep the dates, mark it at risk", "Remove the link"] },
};

/** The new delivery a person sets over Oracle's estimate, and what it fixes. */
export const FP_NEW_END = "Nov 27";
export const FP_AFTER_SET = { text: "Starts Oct 31, before Alert rules engine ends Nov 10.", fixes: ["Start after it: Nov 11 – Dec 8", "Keep the dates, mark it at risk", "Remove the link"] };

/** The link added in the mock-ups' story, and the clash it brings. */
export const FP_ADDED: FpDep = { title: "Mobile alert push", dates: "Nov 11 – Dec 20", from: "person", by: FP_ME, conflict: true };
export const FP_ADDED_CONFLICT = {
  text: "Starts Oct 31, before Alert rules engine ends Nov 10 and before Mobile alert push ends Dec 20.",
  fixes: ["Start after both: Dec 21 – Jan 30, 2027", "Keep the dates, mark it at risk", "Remove the new link"],
};
export const FP_SEARCH = [
  { title: "Mobile alert push", dates: "Nov 11 – Dec 20", roadmap: "Alerts roadmap", note: "" },
  { title: "Alert rules engine", dates: "Oct 1 – Nov 10", roadmap: "Alerts roadmap", note: "Already linked" },
  { title: "Alert routing by team", dates: "Feb 21 – Aug 20, 2027", roadmap: "Alerts roadmap", note: "Needs this one: it would make a loop" },
];
export const FP_QUERY = "push";

/** The hard case: a long title, 8 links it depends on, a date that clashes with one of them. */
export const FP_BIG: FpFeature = {
  title: "Let workspace admins route, mute and schedule alerts per team, region and on-call rotation across every connected tool",
  outcome: "Each alert reaches the one person on call for it, and nobody else, in every tool a team uses.",
  status: "Planned",
  owner: "Ana Silva",
  confidence: "Low",
  notes: "Needs the new team model first. Regions come from the billing address until admins set them.",
  start: { date: "Jan 18, 2027", from: "Set by Ana Silva" },
  end: { date: "Mar 3, 2027", from: "Commitment to the board", suggested: "Apr 21, 2027" },
  goal: { title: "Cut time to first response", measure: "Median minutes from alert to first reply", today: "38 min", target: "15 min", by: "Sep 30, 2027" },
  milestone: { name: "General release", date: "Mar 15, 2027" },
  dependsOn: [
    { title: "Alert rules engine", dates: "Oct 5 – Nov 27", from: "oracle" },
    { title: "Team model with nested teams and shared owners", dates: "Nov 2 – Jan 15, 2027", from: "oracle" },
    { title: "Single sign-on for admins", dates: "Jan 4 – Mar 20, 2027", from: "person", by: "Ana Silva", conflict: true },
    { title: "On-call calendar import", dates: "Dec 7 – Jan 29, 2027", from: "oracle" },
    { title: "Region field on workspaces", dates: "Nov 9 – Dec 18", from: "person", by: "Sam Okafor" },
    { title: "Chat tool connector", dates: "Oct 19 – Dec 11", from: "oracle" },
    { title: "Pager tool connector", dates: "Nov 30 – Jan 22, 2027", from: "oracle" },
    { title: "Quiet hours per person", dates: "Dec 14 – Feb 12, 2027", from: "person", by: "Ana Silva" },
  ],
  neededBy: [
    { title: "Alert routing by team", dates: "Feb 15 – Apr 9, 2027", from: "oracle" },
    { title: "Escalation rules", dates: "Mar 22 – May 14, 2027", from: "person", by: "Sam Okafor" },
  ],
  conflict: { text: "Ends Mar 3, before Single sign-on for admins ends Mar 20.", fixes: ["End after it: Apr 21, 2027", "Keep the dates, mark it at risk", "Remove the link"] },
};

export const FP_TALK = [
  { who: "Oracle", text: "Engineering estimates the digest ends Feb 12. The rules engine it needs ends Nov 27." },
  { who: "Maya Ortiz", text: "Can we have it before the Beta on Jan 29?" },
  { who: "Oracle", text: "Only if the email template is cut to one layout. That saves about three weeks." },
];
