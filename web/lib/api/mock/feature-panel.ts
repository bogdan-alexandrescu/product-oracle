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
  /** The feature's own talk with Oracle (FP1 B shows it beside the details). */
  talk: { who: string; text: string }[];
};

export const FP_ME = "Leo Brandt"; // MOCK-HOOK

/** A clash's fixes, in the words of the roadmap's broken links banner (its buttons open the panel at the clash). */
const FIXES = (moved: string, dependency = "Move the dependency") => [`Move the dependents: ${moved}`, dependency, "Accept as risk"];

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
  conflict: { text: "Starts Oct 31, before Alert rules engine ends Nov 10. Ends Dec 10, after its milestone Beta (Nov 30).", fixes: FIXES("Nov 11 – Dec 21") },
  talk: [
    { who: "Oracle", text: "Engineering estimates the digest ends Dec 10. It starts Oct 31, but Alert rules engine, which it needs, ends Nov 10." },
    { who: "Maya Ortiz", text: "Can we have it before the Beta on Nov 30?" },
    { who: "Oracle", text: "Only if the email template is cut to one layout. That saves about two weeks, so it could end Nov 27." },
  ],
};

/** The new delivery a person sets over Oracle's estimate, and what it fixes. */
export const FP_NEW_END = "Nov 27";
export const FP_AFTER_SET = { text: "Starts Oct 31, before Alert rules engine ends Nov 10.", fixes: FIXES("Nov 11 – Dec 8") };

/** The link added in the mock-ups' story, and the clash it brings. */
export const FP_ADDED: FpDep = { title: "Mobile alert push", dates: "Nov 11 – Dec 20", from: "person", by: FP_ME, conflict: true };
export const FP_ADDED_CONFLICT = {
  text: "Starts Oct 31, before Alert rules engine ends Nov 10 and before Mobile alert push ends Dec 20.",
  fixes: [...FIXES("Dec 21 – Jan 17, 2027", "Move the dependencies"), "Remove the new link"],
};
export const FP_SEARCH = [
  { title: "Mobile alert push", dates: "Nov 11 – Dec 20", roadmap: "Alerts roadmap", note: "" },
  { title: "Alert rules engine", dates: "Oct 1 – Nov 10", roadmap: "Alerts roadmap", note: "Already linked" },
  { title: "Alert routing by team", dates: "Feb 21 – Aug 20, 2027", roadmap: "Alerts roadmap", note: "Needs this one: it would make a loop" },
];
export const FP_QUERY = "push";

/** The hard case: a long title, 8 links it depends on, a start that clashes with 4 of them. */
export const FP_BIG: FpFeature = {
  title: "Let workspace admins route, mute and schedule alerts per team, region and on-call rotation across every connected tool",
  outcome: "Each alert reaches the one person on call for it, and nobody else, in every tool a team uses.",
  status: "Planned",
  owner: "Ana Silva",
  confidence: "Low",
  notes: "Needs the new team model first. Regions come from the billing address until admins set them.",
  start: { date: "Jan 18, 2027", from: "Set by Ana Silva" },
  end: { date: "Mar 3, 2027", from: "Oracle suggested Apr 21, 2027; set to Mar 3, 2027 by Ana Silva, the date promised to the board", suggested: "Apr 21, 2027" },
  goal: { title: "Cut time to first response", measure: "Median minutes from alert to first reply", today: "38 min", target: "15 min", by: "Sep 30, 2027" },
  milestone: { name: "General release", date: "Mar 15, 2027" },
  dependsOn: [
    { title: "Alert rules engine", dates: "Oct 1 – Nov 10", from: "oracle" },
    { title: "Team model with nested teams and shared owners", dates: "Nov 2 – Jan 15, 2027", from: "oracle" },
    { title: "Single sign-on for admins", dates: "Jan 4 – Mar 20, 2027", from: "person", by: "Ana Silva", conflict: true },
    { title: "On-call calendar import", dates: "Dec 7 – Jan 29, 2027", from: "oracle", conflict: true },
    { title: "Region field on workspaces", dates: "Nov 9 – Dec 18", from: "person", by: "Sam Okafor" },
    { title: "Chat tool connector", dates: "Oct 19 – Dec 11", from: "oracle" },
    { title: "Pager tool connector", dates: "Nov 30 – Jan 22, 2027", from: "oracle", conflict: true },
    { title: "Quiet hours per person", dates: "Dec 14 – Feb 12, 2027", from: "person", by: "Ana Silva", conflict: true },
  ],
  neededBy: [
    { title: "Alert reports per team", dates: "Apr 5 – May 28, 2027", from: "oracle" },
    { title: "Escalation rules", dates: "Mar 22 – May 14, 2027", from: "person", by: "Sam Okafor" },
  ],
  conflict: {
    text: "Starts Jan 18, 2027, before Single sign-on for admins and 3 more end: On-call calendar import, Pager tool connector and Quiet hours per person. The last ends Mar 20, 2027.",
    fixes: ["Move the dependents: Mar 21 – May 4, 2027", "Move the dependencies", "Accept as risk"],
  },
  talk: [
    { who: "Oracle", text: "This is due Mar 3, 2027, the date promised to the board. Engineering estimates Apr 21, 2027." },
    { who: "Ana Silva", text: "What makes it late?" },
    { who: "Oracle", text: "Single sign-on for admins ends Mar 20, 2027, after this is due. Admins can't route alerts before they can sign in." },
  ],
};
