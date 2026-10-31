// MOCK-HOOK: mk-rundecide mock-ups only (never merged). Invented people, runs and PRD text.

export type RunStop = {
  id: string;
  stop: string;
  outcome: string;
  who: string;
  role: string;
  day: string; // ISO day the stop was decided
  note?: string;
  trail?: { what: string; who: string; day: string; note?: string }[];
};
export type MockRun = { id: string; name: string; prd: string; prdSlug: string; stops: RunStop[] };

// MOCK-HOOK: the run the task describes, on the Usage alerts PRD.
export const RUN_MAIN: MockRun = {
  id: "run-usage-alerts",
  name: "Usage alerts plan",
  prd: "Usage alerts PRD",
  prdSlug: "usage-alerts",
  stops: [
    { id: "r1", stop: "Feature set", outcome: "Approved", who: "Priya Shah", role: "owner", day: "2026-10-20", note: "Keep the weekly digest; leave text messages for later." },
    {
      id: "r2",
      stop: "Engineering check",
      outcome: "Approved after a change",
      who: "Marco Ruiz",
      role: "engineering lead",
      day: "2026-10-22",
      note: "Quiet hours now follow each workspace's time zone.",
      trail: [
        { what: "Sent back", who: "Marco Ruiz", day: "2026-10-21", note: "Quiet hours need a time zone per workspace, not one for the company." },
        { what: "Approved", who: "Marco Ruiz", day: "2026-10-22", note: "Quiet hours now follow each workspace's time zone." },
      ],
    },
    { id: "r3", stop: "Order", outcome: "Approved", who: "Priya Shah", role: "owner", day: "2026-10-22" },
    { id: "r4", stop: "PRD review", outcome: "Approved", who: "Lena Ford", role: "approver", day: "2026-10-26", note: "Good to build from version 3." },
    { id: "r5", stop: "Dates", outcome: "Approved with one date changed", who: "Priya Shah", role: "owner", day: "2026-10-27", note: "Weekly alert digest moved from Nov 20 to Dec 4." },
  ],
};

// MOCK-HOOK: more runs for the heavy case (&many=1).
export const RUNS_MORE: MockRun[] = [
  {
    id: "run-guided-setup",
    name: "Guided setup plan",
    prd: "Guided setup PRD",
    prdSlug: "guided-setup",
    stops: [
      { id: "g1", stop: "Feature set", outcome: "Approved", who: "Priya Shah", role: "owner", day: "2026-10-12", note: "Checklist first, sample project second." },
      { id: "g2", stop: "Engineering check", outcome: "Approved", who: "Marco Ruiz", role: "engineering lead", day: "2026-10-13" },
      { id: "g3", stop: "Order", outcome: "Approved", who: "Priya Shah", role: "owner", day: "2026-10-14" },
      { id: "g4", stop: "PRD review", outcome: "Approved", who: "Lena Ford", role: "approver", day: "2026-10-16" },
      { id: "g5", stop: "Dates", outcome: "Approved", who: "Priya Shah", role: "owner", day: "2026-10-17" },
    ],
  },
  {
    id: "run-team-billing",
    name: "Team billing plan",
    prd: "Team billing PRD",
    prdSlug: "team-billing",
    stops: [
      { id: "t1", stop: "Feature set", outcome: "Approved", who: "Jonas Berg", role: "owner", day: "2026-10-24", note: "Seats only; no usage pricing this quarter." },
      {
        id: "t2",
        stop: "Engineering check",
        outcome: "Approved after a change",
        who: "Marco Ruiz",
        role: "engineering lead",
        day: "2026-10-28",
        trail: [
          { what: "Sent back", who: "Marco Ruiz", day: "2026-10-25", note: "Proration needs the new invoice service first." },
          { what: "Approved", who: "Marco Ruiz", day: "2026-10-28" },
        ],
      },
      { id: "t3", stop: "Order", outcome: "Approved", who: "Jonas Berg", role: "owner", day: "2026-10-29" },
    ],
  },
  {
    id: "run-status-page",
    name: "Status page plan",
    prd: "Status page PRD",
    prdSlug: "status-page",
    stops: [
      { id: "s1", stop: "Feature set", outcome: "Approved", who: "Ama Owusu", role: "owner", day: "2026-10-27" },
      { id: "s2", stop: "Engineering check", outcome: "Approved", who: "Marco Ruiz", role: "engineering lead", day: "2026-10-28", note: "Host it ourselves, behind the same sign-in." },
      { id: "s3", stop: "Order", outcome: "Approved", who: "Ama Owusu", role: "owner", day: "2026-10-29" },
      { id: "s4", stop: "PRD review", outcome: "Approved", who: "Lena Ford", role: "approver", day: "2026-10-30" },
    ],
  },
];

// MOCK-HOOK: the Usage alerts PRD's own "Decisions needed" (each with an owner and a due day).
export type Needed = { code: string; title: string; owner: string; due: string; mine: boolean; rec?: string };
export const NEEDED: Needed[] = [
  { code: "N1", title: "Text messages in the first release?", owner: "Admin", due: "2026-11-03", mine: true, rec: "Not in the first release" },
  { code: "N2", title: "Quiet hours on by default?", owner: "Lena Ford", due: "2026-11-04", mine: false, rec: "On, 10 PM to 7 AM" },
  { code: "N3", title: "Alert limit per workspace", owner: "Priya Shah", due: "2026-11-06", mine: false, rec: "50 a day" },
  { code: "N4", title: "Who can mute a teammate's alerts", owner: "Admin", due: "2026-11-10", mine: true, rec: "Workspace admins only" },
  { code: "N5", title: "Day the weekly digest goes out", owner: "Marco Ruiz", due: "2026-11-12", mine: false },
  { code: "N6", title: "How long alert history is kept", owner: "Admin", due: "2026-11-18", mine: true, rec: "90 days" },
  { code: "N7", title: "Alert sound on phones", owner: "Ama Owusu", due: "2026-12-02", mine: false },
];
