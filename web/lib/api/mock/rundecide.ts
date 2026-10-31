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

// MOCK-HOOK: how many of RD3 a's items were decided on this page (Home's count goes down).
export const RD_STATE = { decided: 0 };

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

// MOCK-HOOK: the Usage alerts PRD's own body (version 3), so the run, its stops and its
// decisions needed sit on a PRD that says the same things.
type OnePagerLike = { sections: { key: string; heading: string; body: string }[]; blocks: { key: string; title: string; rules: string; kind: string; lines: unknown[] }[] };
export function rdAlertsOnePager<T extends OnePagerLike>(base: T): T {
  const line = (id: string, text: string, keys: string[]) => ({ id, text, keys });
  const sections = [
    { key: "problem", heading: "Problem", body: "Workspace admins hit a plan limit without warning, and their team is blocked mid-task." },
    { key: "who", heading: "Who has it", body: "Admins of paid workspaces with ten or more people." },
    { key: "build", heading: "What we will build", body: "- An alert at 80% and 100% of each limit, by email and in the app\n- A weekly alert digest for admins\n- Quiet hours that follow each workspace's time zone" },
    { key: "outcomes", heading: "Outcomes", body: "- Tickets about surprise limits from 120 to 40 a month\n- Admins who raise a limit before hitting it from 12% to 35%" },
    { key: "not-doing", heading: "Not doing", body: "- Text messages\n- Alerts for single users" },
    { key: "risks", heading: "Risks and open decisions", body: "- Too many alerts and admins mute them all\n- Decide the daily alert limit per workspace" },
  ];
  const blocks = [
    { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", lines: [line("problem-1", "Workspace admins hit a plan limit without warning, and their team is blocked mid-task.", ["problem", "who"])] },
    { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: [
      line("bets-1", "An alert at 80% and 100% of each limit, by email and in the app", ["build"]),
      line("bets-2", "A weekly alert digest for admins", ["build"]),
      line("bets-3", "Quiet hours that follow each workspace's time zone", ["build"]),
    ] },
    { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: [
      { ...line("outcomes-1", "Tickets about surprise limits from 120 to 40 a month", ["outcomes"]), metric: { name: "Tickets about surprise limits", from: "120 a month", to: "40 a month" } },
      { ...line("outcomes-2", "Admins who raise a limit before hitting it from 12% to 35%", ["outcomes"]), metric: { name: "Admins who raise a limit before hitting it", from: "12%", to: "35%" } },
    ] },
    { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: [line("not_doing-1", "Text messages", ["not-doing"]), line("not_doing-2", "Alerts for single users", ["not-doing"])] },
    { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: [
      line("risks-1", "Too many alerts and admins mute them all", ["risks"]),
      line("risks-2", "Decide the daily alert limit per workspace", ["risks"]),
    ] },
    ...base.blocks.filter((b) => b.key === "timeline"),
  ];
  const item = (title: string, horizon: string, start: string, end: string, milestone: [string, string] | null) => ({ title, horizon, start, end, estimated: false, milestone });
  const slice = [
    item("Alert at 80% and 100%", "now", "2026-11-02", "2026-11-20", ["M1", "2026-11-20"]),
    item("Alert emails", "now", "2026-11-02", "2026-11-20", ["M1", "2026-11-20"]),
    item("Quiet hours by time zone", "now", "2026-11-09", "2026-11-27", ["M1", "2026-11-20"]),
    item("Weekly alert digest", "next", "2026-11-23", "2026-12-04", ["M2", "2026-12-04"]),
    item("Alert history", "later", "2026-12-07", "2027-01-15", null),
  ];
  return { ...base, sections, blocks, slice } as T;
}

// MOCK-HOOK: other PRDs' decisions needed, for RD3 c's heavy case (&many=1).
export const NEEDED_MORE: { prd: string; slug: string; list: Needed[] }[] = [
  { prd: "Team billing PRD", slug: "team-billing", list: [
    { code: "N1", title: "Bill seats monthly or yearly first?", owner: "Jonas Berg", due: "2026-11-05", mine: false, rec: "Monthly first" },
    { code: "N2", title: "Who gets the invoice email", owner: "Admin", due: "2026-11-09", mine: true, rec: "Workspace admins and billing contacts" },
    { code: "N3", title: "Refunds for removed seats?", owner: "Jonas Berg", due: "2026-11-16", mine: false },
    { code: "N4", title: "Tax ID on invoices", owner: "Ama Owusu", due: "2026-11-20", mine: false, rec: "Optional field" },
  ] },
  { prd: "Status page PRD", slug: "status-page", list: [
    { code: "N1", title: "Public or signed-in only?", owner: "Admin", due: "2026-11-06", mine: true, rec: "Signed-in only" },
    { code: "N2", title: "How often the page checks each service", owner: "Marco Ruiz", due: "2026-11-13", mine: false, rec: "Every minute" },
    { code: "N3", title: "Email people when a service is down?", owner: "Ama Owusu", due: "2026-11-24", mine: false },
  ] },
];
