// MOCK-HOOK: the whole file is mock-up data for "bring this date in" (mk-fitdate, FD1..FD3).
// Invented company (Larkspur Help Desk), goals, items and engineers only.

export type FitLever =
  "move" | "slice" | "ungate" | "split" | "overlap" | "capacity" | "next_prd"; // MOCK-HOOK

export type FitRec = {
  // MOCK-HOOK
  id: string;
  lever: FitLever;
  title: string;
  item: string;
  effect: string;
  pwSaved: number;
  days: number;
  moves: { what: string; before: string; after: string }[];
  cost: string;
  costKind: "goal" | "gate" | "guard" | "none" | "risk" | "must";
  pick: boolean;
};

export type FitItem = {
  id: string;
  title: string;
  pw: number;
  owner: string;
  start: string;
  end: string;
  milestone: string;
  gate: boolean;
  guard?: string;
  must?: boolean;
}; // MOCK-HOOK

export const FIT_TEAM = {
  engineers: 4,
  focus: 0.7,
  names: ["Rina Vale", "Tomas Brook", "Lena Hart", "Owen Pike"],
}; // MOCK-HOOK

export const FIT_GOAL = {
  // MOCK-HOOK
  title: "40 replied threads per agent per day",
  now: "26 replied threads per agent today",
  prd: "Reply faster in the shared inbox",
  prdVersion: 3,
  roadmapVersion: 6,
  milestone: "M2 Agent reply flow",
  target: "Jan 29",
  projected: "Mar 12",
  late: "6 weeks late",
  hardTarget: "Jan 8",
};

export const FIT_ITEMS: FitItem[] = [
  // MOCK-HOOK
  {
    id: "drafts",
    title: "Reply drafts in the inbox",
    pw: 6,
    owner: "Rina Vale",
    start: "Nov 16",
    end: "Dec 18",
    milestone: "M2",
    gate: true,
    must: true,
  },
  {
    id: "guard",
    title: "Send check before a draft goes out",
    pw: 3,
    owner: "Lena Hart",
    start: "Dec 7",
    end: "Dec 30",
    milestone: "M2",
    gate: true,
    guard: "Guardrail: no draft is sent without an agent reading it",
  },
  {
    id: "summary",
    title: "Thread summary card",
    pw: 4,
    owner: "Tomas Brook",
    start: "Dec 21",
    end: "Jan 22",
    milestone: "M2",
    gate: true,
  },
  {
    id: "bulk",
    title: "Reply to similar threads at once",
    pw: 5,
    owner: "Owen Pike",
    start: "Jan 4",
    end: "Feb 12",
    milestone: "M2",
    gate: true,
  },
  {
    id: "analytics",
    title: "Reply time chart",
    pw: 4,
    owner: "Lena Hart",
    start: "Jan 11",
    end: "Feb 19",
    milestone: "M2",
    gate: true,
  },
  {
    id: "tone",
    title: "Tone presets",
    pw: 3,
    owner: "Tomas Brook",
    start: "Jan 25",
    end: "Feb 26",
    milestone: "M2",
    gate: true,
  },
  {
    id: "snippets",
    title: "Import saved snippets",
    pw: 2,
    owner: "Rina Vale",
    start: "Feb 8",
    end: "Mar 5",
    milestone: "M2",
    gate: true,
  },
  {
    id: "redact",
    title: "Hide card numbers in drafts",
    pw: 2,
    owner: "Owen Pike",
    start: "Feb 15",
    end: "Mar 12",
    milestone: "M2",
    gate: true,
    guard: "Safety: card numbers never reach a draft or a log",
  },
];

export const FIT_RECS: FitRec[] = [
  // MOCK-HOOK
  {
    id: "bulk",
    lever: "move",
    title: "Move after the date",
    item: "Reply to similar threads at once",
    effect: "Moves to M3 Team inbox: lands Mar 19, M3 on Apr 9",
    pwSaved: 5,
    days: 16,
    moves: [
      { what: "M2 Agent reply flow", before: "Mar 12", after: "Feb 24" },
      { what: "M3 Team inbox", before: "Apr 2", after: "Apr 9" },
    ],
    cost: "The goal starts lower: about 34 of 40 replied threads at launch, 40 after M3.",
    costKind: "goal",
    pick: true,
  },
  {
    id: "analytics",
    lever: "ungate",
    title: "Take off the gate, keep on the roadmap",
    item: "Reply time chart",
    effect: "Still built, lands Mar 5; M2 no longer waits for it",
    pwSaved: 4,
    days: 10,
    moves: [{ what: "M2 Agent reply flow", before: "Feb 24", after: "Feb 14" }],
    cost: "For three weeks after launch nobody sees reply times on a chart; the weekly export still has them.",
    costKind: "gate",
    pick: true,
  },
  {
    id: "hold",
    lever: "overlap",
    title: "Overlap a calendar-only wait",
    item: "M1 7-day hold",
    effect: "M2 work starts during M1's hold, not after it",
    pwSaved: 0,
    days: 7,
    moves: [{ what: "M2 Agent reply flow", before: "Feb 14", after: "Feb 7" }],
    cost: "A bug found in M1's hold pulls Rina Vale back for up to a week.",
    costKind: "risk",
    pick: true,
  },
  {
    id: "summary",
    lever: "slice",
    title: "Ship only the slice M2 needs",
    item: "Thread summary card",
    effect: "4 person-weeks down to 2: read-only summary, no edit",
    pwSaved: 2,
    days: 5,
    moves: [
      { what: "M2 Agent reply flow", before: "Feb 7", after: "Feb 2" },
      { what: "Thread summary card", before: "Jan 22", after: "Jan 8" },
    ],
    cost: "Agents cannot fix a wrong summary until the rest ships in M3.",
    costKind: "none",
    pick: false,
  },
  {
    id: "tone",
    lever: "next_prd",
    title: "Move to the next PRD",
    item: "Tone presets",
    effect: "Leaves this PRD; waits for the next one",
    pwSaved: 3,
    days: 8,
    moves: [{ what: "M2 Agent reply flow", before: "Feb 2", after: "Jan 25" }],
    cost: "Asked for in 6 requests; those people hear it moved.",
    costKind: "none",
    pick: false,
  },
  {
    id: "snippets",
    lever: "split",
    title: "Split so a first slice lands early",
    item: "Import saved snippets",
    effect: "Slice 1 (plain text) lands Jan 14; slice 2 after M2",
    pwSaved: 1,
    days: 3,
    moves: [{ what: "M2 Agent reply flow", before: "Jan 25", after: "Jan 22" }],
    cost: "Snippets with pictures wait for slice 2.",
    costKind: "none",
    pick: false,
  },
  {
    id: "focus",
    lever: "capacity",
    title: "Raise focus time",
    item: "Team focus 70% to 80%",
    effect: "Fewer support shifts for the four engineers",
    pwSaved: 0,
    days: 6,
    moves: [{ what: "M2 Agent reply flow", before: "Jan 22", after: "Jan 16" }],
    cost: "Support shifts move to two people outside the team for 10 weeks.",
    costKind: "risk",
    pick: false,
  },
  {
    id: "drafts",
    lever: "move",
    title: "Move after the date",
    item: "Reply drafts in the inbox",
    effect: "Must-include for this goal",
    pwSaved: 6,
    days: 18,
    moves: [{ what: "M2 Agent reply flow", before: "—", after: "—" }],
    cost: "The goal cannot move without drafts, so Oracle ranks it last and will not tick it.",
    costKind: "must",
    pick: false,
  },
];

/** What Oracle will not cut, and why (the guardrail and safety layers). */
export const FIT_LOCKED = [
  // MOCK-HOOK
  {
    item: "Send check before a draft goes out",
    pw: 3,
    why: "Guardrail: no draft is sent without an agent reading it.",
  },
  {
    item: "Hide card numbers in drafts",
    pw: 2,
    why: "Safety: card numbers never reach a draft or a log.",
  },
];

/** Three packages, least to most cut (FD2 b). */
export const FIT_PACKAGES = [
  // MOCK-HOOK
  {
    id: "light",
    name: "Light trim",
    recs: ["hold", "summary", "snippets"],
    date: "Feb 27",
    reach: false,
    gives:
      "Keeps every feature; one wait overlaps and two items ship a first slice.",
    hardGives: "Keeps every feature, and lands far after the date.",
  },
  {
    id: "fit",
    name: "Fits the date",
    recs: ["bulk", "analytics", "hold", "summary", "tone"],
    date: "Jan 25",
    reach: true,
    gives: "The goal starts at 34 of 40.",
    hardGives: "It fits Jan 29, not Jan 8. The goal starts at 34 of 40.",
  },
  {
    id: "deep",
    name: "Deep cut",
    recs: ["bulk", "analytics", "hold", "summary", "tone", "snippets", "focus"],
    date: "Jan 16",
    reach: true,
    gives: "Two weeks of room; support shifts move outside the team.",
    hardGives:
      "Still misses it. Gives up the most: support shifts move outside the team and snippets with pictures wait.",
  },
];

export const FIT_DIFF = {
  // MOCK-HOOK
  prd: [
    { change: "Moved to M3", item: "Reply to similar threads at once" },
    { change: "No longer holds M2; still built, lands Mar 5", item: "Reply time chart" },
    {
      change: "First slice only in M2",
      item: "Thread summary card (4 to 2 person-weeks)",
    },
    { change: "Moved to the next PRD", item: "Tone presets" },
    { change: "34 of 40 replied threads at launch; 40 after M3", item: "The goal" },
  ],
  dates: [
    { what: "M2 Agent reply flow", before: "Mar 12", after: "Jan 25", kind: "in" },
    {
      what: "Goal: 40 replied threads per agent per day",
      before: "Mar 12",
      after: "Jan 25",
      kind: "split",
      note: "Launches at 34 of 40; the full 40 comes with M3 Team inbox, Apr 9",
    },
    { what: "Thread summary card (first slice)", before: "Jan 22", after: "Jan 8", kind: "in" },
    { what: "Import saved snippets", before: "Mar 5", after: "Jan 18", kind: "in" },
    { what: "Hide card numbers in drafts", before: "Mar 12", after: "Jan 25", kind: "in" },
    { what: "Reply time chart (no longer holds M2)", before: "Feb 19", after: "Mar 5", kind: "out" },
    { what: "Reply to similar threads at once (to M3)", before: "Feb 12", after: "Mar 19", kind: "out" },
    { what: "M3 Team inbox", before: "Apr 2", after: "Apr 9", kind: "out" },
    { what: "Tone presets (to the next PRD)", before: "Feb 26", after: "Not dated", kind: "out" },
  ],
  /** The hard case (target Jan 8): every change picked, and the target itself moves. */
  hardDates: [
    { what: "M2 target", before: "Jan 8", after: "Jan 16", kind: "out", note: "No set of cuts reaches Jan 8, so you approve the new target too" },
    { what: "M2 Agent reply flow", before: "Mar 12", after: "Jan 16", kind: "in" },
    {
      what: "Goal: 40 replied threads per agent per day",
      before: "Mar 12",
      after: "Jan 16",
      kind: "split",
      note: "Launches at 34 of 40; the full 40 comes with M3 Team inbox, Apr 9",
    },
    { what: "Thread summary card (first slice)", before: "Jan 22", after: "Jan 8", kind: "in" },
    { what: "Import saved snippets (first slice)", before: "Mar 5", after: "Jan 14", kind: "in" },
    { what: "Hide card numbers in drafts", before: "Mar 12", after: "Jan 16", kind: "in" },
    { what: "Reply time chart (no longer holds M2)", before: "Feb 19", after: "Mar 5", kind: "out" },
    { what: "Reply to similar threads at once (to M3)", before: "Feb 12", after: "Mar 19", kind: "out" },
    { what: "M3 Team inbox", before: "Apr 2", after: "Apr 9", kind: "out" },
    { what: "Tone presets (to the next PRD)", before: "Feb 26", after: "Not dated", kind: "out" },
  ],
  hardPrd: [
    { change: "First slice only in M2 (plain text)", item: "Import saved snippets" },
    { change: "70% to 80%; support shifts move to two people outside the team for 10 weeks", item: "Team focus" },
  ],
  run: {
    took: "about 40 seconds",
    costs: "about $0.20 of Claude time",
    by: "Oracle drafts; you approve",
  },
};

/** The roadmap after the pick, milestone order then priority order (adjusted frame). */
export const FIT_AFTER = [
  // MOCK-HOOK
  {
    milestone: "M1 Inbox basics",
    date: "Dec 4",
    was: "Dec 4",
    items: [
      { t: "Shared inbox views", d: "Nov 27" },
      { t: "Assign a thread", d: "Dec 4" },
    ],
  },
  {
    milestone: "M2 Agent reply flow",
    date: "Jan 25",
    was: "Mar 12",
    items: [
      { t: "Reply drafts in the inbox", d: "Dec 18" },
      { t: "Send check before a draft goes out", d: "Dec 30", lock: true },
      { t: "Thread summary card (first slice)", d: "Jan 8", was: "Jan 22" },
      { t: "Import saved snippets", d: "Jan 18", was: "Mar 5" },
      {
        t: "Hide card numbers in drafts",
        d: "Jan 25",
        was: "Mar 12",
        lock: true,
      },
      { t: "Reply time chart (no longer holds M2)", d: "Mar 5", was: "Feb 19" },
    ],
  },
  {
    milestone: "M3 Team inbox",
    date: "Apr 9",
    was: "Apr 2",
    items: [
      { t: "Reply to similar threads at once", d: "Mar 19", was: "Feb 12" },
      { t: "Edit a thread summary", d: "Apr 2" },
    ],
  },
  {
    milestone: "Next PRD",
    date: "",
    was: "",
    items: [{ t: "Tone presets", d: "Not dated" }],
  },
];
